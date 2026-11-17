import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import { load } from 'cheerio';
import { absoluteEpisode } from '../hianime/hianime.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://www.wco.tv';
const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: ORIGIN + '/'
};
const normal = (s: string) =>
    s
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
const valid = (u: URL, hosts: string[]) =>
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    !u.port &&
    hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
const PAGE_HOSTS = ['www.wco.tv'],
    PLAYER_HOSTS = ['embed.wcostream.com'],
    MEDIA_HOSTS = ['wcostream.com'];

/** Different standard HTTP clients receive different WCO responses. Keep this
 * transport public-only, bounded, cookie-free and inside the provider deadline. */
export function readPublicWcoPage(
    url: URL,
    signal: AbortSignal
): Promise<Response> {
    if (!valid(url, PAGE_HOSTS) || signal.aborted)
        return Promise.reject(new Error('Unsupported public page'));
    return new Promise((resolve, reject) => {
        const child = spawn(
            'python3',
            [fileURLToPath(new URL('./public-page.py', import.meta.url))],
            { stdio: ['pipe', 'pipe', 'pipe'] }
        );
        let output = '',
            stopped = false;
        const abort = () => {
            stopped = true;
            child.kill();
        };
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk) => {
            output += chunk.toString();
            if (output.length > 8 * 1024 * 1024) abort();
        });
        // Discard diagnostics from the child: upstream tokens and bodies must not be logged.
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', () => {
            signal.removeEventListener('abort', abort);
            reject(new Error('Public-page transport unavailable'));
        });
        child.on('close', (code) => {
            signal.removeEventListener('abort', abort);
            if (code !== 0 || stopped)
                return reject(new Error('Public-page transport failed'));
            try {
                const value = JSON.parse(output);
                if (
                    !Number.isInteger(value.status) ||
                    typeof value.body !== 'string'
                )
                    throw new Error();
                resolve(new Response(value.body, { status: value.status }));
            } catch {
                reject(new Error('Invalid public-page response'));
            }
        });
        child.stdin.end(JSON.stringify({ url: url.href }));
    });
}

/** Parse the site's public character-array serialization without evaluating JavaScript. */
export function publicIframe(html: string): string | null {
    if (/This Video Is for Premium Users/i.test(html)) return null;
    let fragment = html;
    if (!load(fragment)('iframe[src]').length) {
        const script = (
            html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []
        ).find((s) => s.includes('document.write') && s.includes('atob'));
        if (!script) return null;
        const list = /var\s+\w+\s*=\s*\[([\s\S]*?)\]/.exec(script)?.[1];
        const offset =
            /parseInt\(atob\(\w+\)\.replace\(\/\\D\/g\s*,\s*['"]['"]\)\)\s*-\s*(\d+)/.exec(
                script
            )?.[1];
        if (!list || !offset || list.length > 400_000) return null;
        const encoded = [...list.matchAll(/["']([A-Za-z0-9+/=]+)["']/g)].map(
            (m) => m[1]
        );
        const codes = encoded.map(
            (v) =>
                Number(Buffer.from(v, 'base64').toString().replace(/\D/g, '')) -
                Number(offset)
        );
        if (
            !codes.length ||
            codes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
        )
            return null;
        fragment = Buffer.from(codes).toString('utf8');
    }
    const $ = load(fragment);
    const url = $('iframe[src]').first().attr('src');
    try {
        const u = new URL(url ?? '');
        return valid(u, PLAYER_HOSTS) ? u.href : null;
    } catch {
        return null;
    }
}

export class WcoProvider extends BaseProvider {
    readonly id = 'wco';
    readonly name = 'WCO';
    readonly BASE_URL = ORIGIN;
    readonly HEADERS = HEADERS;
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['tv']
    };
    readonly enabled: boolean;
    private readonly fetchImpl: typeof fetch;
    private readonly apiKey: string;
    constructor(
        deps: { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv } = {}
    ) {
        super();
        const env = deps.environment ?? process.env;
        this.enabled = env.WCO_ENABLED === 'true';
        this.apiKey = env.TMDB_API_KEY ?? '';
        this.fetchImpl = deps.fetch ?? fetch;
    }
    async getMovieSources(): Promise<ProviderResult> {
        return { sources: [], subtitles: [], diagnostics: [] };
    }
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        const empty = (reason: string): ProviderResult => ({
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    field: '',
                    message: 'WCO: ' + reason,
                    severity: 'warning'
                }
            ]
        });
        if (!this.apiKey || !/^\d+$/.test(media.tmdbId) || !media.title)
            return empty('exact TMDB identity required');
        const signal = AbortSignal.timeout(25_000);
        try {
            const details = JSON.parse(
                await this.read(
                    new URL(
                        `https://api.themoviedb.org/3/tv/${media.tmdbId}?api_key=${encodeURIComponent(this.apiKey)}`
                    ),
                    ['api.themoviedb.org'],
                    signal
                )
            );
            if (!details.genres?.some((g: { id: number }) => g.id === 16))
                return { sources: [], subtitles: [], diagnostics: [] };
            const absolute = absoluteEpisode(details, media.s!, media.e!);
            if (!absolute)
                return empty('unsupported or incomplete episode numbering');
            const slug = media.title
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
            const listing = load(
                await this.read(
                    new URL('/anime/' + slug, ORIGIN),
                    PAGE_HOSTS,
                    signal
                )
            );
            if (
                ![...listing('h1, .film-name')].some(
                    (el) => normal(listing(el).text()) === normal(media.title)
                )
            )
                return empty('series title does not match exactly');
            const explicit: URL[] = [],
                numbered: URL[] = [];
            listing('a[href]').each((_, el) => {
                const u = new URL(listing(el).attr('href') ?? '', ORIGIN);
                if (u.origin !== ORIGIN) return;
                if (
                    new RegExp(
                        `^/${slug}-season-${media.s}-episode-${media.e}(?:-|$)`
                    ).test(u.pathname)
                )
                    explicit.push(u);
                if (
                    new RegExp(`^/${slug}-episode-${absolute}(?:-|$)`).test(
                        u.pathname
                    )
                )
                    numbered.push(u);
            });
            const paths = [
                ...new Map(
                    (explicit.length ? explicit : numbered).map((u) => [
                        u.href,
                        u
                    ])
                ).values()
            ].slice(0, 4);
            if (!paths.length) return empty('exact episode unavailable');
            let premium = 0;
            const resolved = await Promise.allSettled(
                paths.map(async (u) => {
                    const page = await this.read(u, PAGE_HOSTS, signal);
                    if (/This Video Is for Premium Users/i.test(page)) {
                        premium++;
                        return [];
                    }
                    const iframe = publicIframe(page);
                    if (!iframe) return [];
                    const embed = new URL(iframe);
                    if (
                        embed.pathname !== '/inc/embed/index.php' &&
                        embed.pathname !== '/inc/embed/video-js.php'
                    )
                        return [];
                    // This is the public player's next page; no account cookies, ad scripts or challenges are executed.
                    embed.pathname = '/inc/embed/video-js.php';
                    const player = await this.read(embed, PLAYER_HOSTS, signal);
                    const path = /\$\.getJSON\(["']([^"']+)["']/.exec(
                        player
                    )?.[1];
                    if (!path) return [];
                    const api = new URL(path, embed);
                    if (api.pathname !== '/inc/embed/getvidlink.php') return [];
                    const data = JSON.parse(
                        await this.read(api, PLAYER_HOSTS, signal)
                    );
                    const server = new URL(String(data.server));
                    if (!valid(server, MEDIA_HOSTS)) return [];
                    const kinds: [string, string][] = [
                        ['fhd', '1080p'],
                        ['hd', '720p'],
                        ['enc', 'Auto']
                    ];
                    const sources: Source[] = [];
                    for (const [key, quality] of kinds) {
                        if (typeof data[key] !== 'string' || !data[key])
                            continue;
                        const target = new URL('/getvid', server);
                        target.searchParams.set('evid', data[key]);
                        if (!(await this.verify(target, signal))) continue;
                        sources.push({
                            url: this.createProxyUrl(target.href, {
                                ...HEADERS,
                                Referer: 'https://embed.wcostream.com/'
                            }),
                            type: 'mp4',
                            quality,
                            audioTracks: [
                                {
                                    language: u.pathname.includes(
                                        '-english-dubbed'
                                    )
                                        ? 'en'
                                        : (details.original_language ?? 'und'),
                                    label: u.pathname.includes(
                                        '-english-dubbed'
                                    )
                                        ? 'English dub'
                                        : 'Original audio (subtitled)'
                                }
                            ],
                            provider: { id: this.id, name: this.name }
                        });
                    }
                    return sources;
                })
            );
            const sources = resolved.flatMap((r) =>
                r.status === 'fulfilled' ? r.value : []
            );
            return sources.length
                ? { sources, subtitles: [], diagnostics: [] }
                : empty(
                      premium
                          ? 'episode requires a WCO premium account; public adapter cannot access it'
                          : 'no verified public media; blocked, unavailable or changed upstream'
                  );
        } catch {
            return empty(
                signal.aborted
                    ? 'discovery deadline exceeded'
                    : 'upstream lookup failed or provider format changed'
            );
        }
    }
    private async read(
        u: URL,
        hosts: string[],
        signal: AbortSignal
    ): Promise<string> {
        if (!valid(u, hosts)) throw new Error('unsupported host');
        let r = await this.fetchImpl(u.href, {
            headers: HEADERS,
            signal,
            redirect: 'manual'
        });
        if (r.status === 403 && u.hostname === 'www.wco.tv') {
            await r.body?.cancel();
            r = await readPublicWcoPage(u, signal);
        }
        if (!r.ok || !r.body) throw new Error('upstream HTTP failure');
        const reader = r.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > 4 * 1024 * 1024) throw new Error('body too large');
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        return Buffer.concat(chunks).toString('utf8');
    }
    private async verify(u: URL, signal: AbortSignal): Promise<boolean> {
        for (let i = 0; i < 4; i++) {
            if (!valid(u, MEDIA_HOSTS) || /\/error\.mp4$/i.test(u.pathname))
                return false;
            const r = await this.fetchImpl(u.href, {
                headers: {
                    ...HEADERS,
                    Referer: 'https://embed.wcostream.com/',
                    Range: 'bytes=0-4095'
                },
                signal,
                redirect: 'manual'
            });
            if (r.status >= 300 && r.status < 400) {
                await r.body?.cancel();
                const location = r.headers.get('location');
                if (!location) return false;
                u = new URL(location, u);
                continue;
            }
            if (!r.ok || !r.body) {
                await r.body?.cancel();
                return false;
            }
            const reader = r.body.getReader();
            let b = Buffer.alloc(0);
            try {
                while (b.length < 12) {
                    const v = await reader.read();
                    if (v.done) break;
                    b = Buffer.concat([b, Buffer.from(v.value)]);
                }
            } finally {
                await reader.cancel().catch(() => {});
            }
            return b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp';
        }
        return false;
    }
}
