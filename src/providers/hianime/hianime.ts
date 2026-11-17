import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import { load } from 'cheerio';

const ORIGIN = 'https://hianime.ba';
const EMBEDS = ['zokoanime.video', 'megaplay.buzz'];
const MEDIA = ['dramahot.top'];
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
type Series = {
    genres?: { id: number }[];
    original_language?: string;
    seasons?: { season_number: number; episode_count: number }[];
};
type Dependencies = { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv };
const normalize = (s: string) =>
    s
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
function allowed(url: URL, domains: string[]) {
    return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        domains.some(
            (h) => url.hostname === h || url.hostname.endsWith('.' + h)
        )
    );
}

/** Convert TMDB seasons to the site's absolute numbering; never guess missing seasons. */
export function absoluteEpisode(
    series: Series,
    season: number,
    episode: number
): number | null {
    if (
        !Number.isInteger(season) ||
        !Number.isInteger(episode) ||
        season < 1 ||
        episode < 1
    )
        return null;
    const seasons = series.seasons ?? [];
    let total = 0;
    for (let s = 1; s <= season; s++) {
        const rows = seasons.filter((x) => x.season_number === s);
        if (
            rows.length !== 1 ||
            !Number.isInteger(rows[0].episode_count) ||
            rows[0].episode_count < 1
        )
            return null;
        if (s === season)
            return episode <= rows[0].episode_count ? total + episode : null;
        total += rows[0].episode_count;
    }
    return null;
}

/** The public player uses a fixed XOR/base64 serialization, not executable extraction. */
export function decodePlayer(html: string): Record<string, unknown> {
    const blob = /window\.__P\s*=\s*["']([A-Za-z0-9+/=]+)["']/.exec(html)?.[1];
    if (!blob || blob.length > 256_000)
        throw new Error('player payload missing');
    const raw = Buffer.from(blob, 'base64'),
        key = Buffer.from('otaku-embed-v1');
    for (let i = 0; i < raw.length; i++) raw[i] ^= key[i % key.length];
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid player payload');
    return value as Record<string, unknown>;
}

export class HiAnimeProvider extends BaseProvider {
    readonly id = 'hianime';
    readonly name = 'HiAnime';
    readonly BASE_URL = ORIGIN;
    readonly HEADERS = {
        'User-Agent': UA,
        Referer: ORIGIN + '/',
        Origin: ORIGIN
    };
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['tv']
    };
    readonly enabled: boolean;
    private readonly fetchImpl: typeof fetch;
    private readonly apiKey: string;
    constructor(deps: Dependencies = {}) {
        super();
        const env = deps.environment ?? process.env;
        this.enabled = env.HIANIME_ENABLED === 'true';
        this.apiKey = env.TMDB_API_KEY ?? '';
        this.fetchImpl = deps.fetch ?? fetch;
    }
    async getMovieSources(): Promise<ProviderResult> {
        return { sources: [], subtitles: [], diagnostics: [] };
    }
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        const empty = (message: string): ProviderResult => ({
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: 'HiAnime: ' + message,
                    field: '',
                    severity: 'warning'
                }
            ]
        });
        if (!this.apiKey || !/^\d+$/.test(media.tmdbId) || !media.title)
            return empty('TMDB identity and configured API key required');
        const signal = AbortSignal.timeout(25_000);
        try {
            const series = JSON.parse(
                await this.read(
                    new URL(
                        `https://api.themoviedb.org/3/tv/${media.tmdbId}?api_key=${encodeURIComponent(this.apiKey)}`
                    ),
                    ['api.themoviedb.org'],
                    signal
                )
            ) as Series;
            if (!series.genres?.some((g) => g.id === 16))
                return { sources: [], subtitles: [], diagnostics: [] };
            const episode = absoluteEpisode(series, media.s!, media.e!);
            if (!episode)
                return empty('unsupported or incomplete episode numbering');
            const search = load(
                await this.read(
                    new URL(
                        '/search?keyword=' + encodeURIComponent(media.title),
                        ORIGIN
                    ),
                    ['hianime.ba'],
                    signal
                )
            );
            const matches = new Set<string>();
            search('.film-name a').each((_, el) => {
                const a = search(el);
                if (
                    [a.attr('title'), a.attr('data-jname'), a.text()].some(
                        (t) => t && normalize(t) === normalize(media.title)
                    )
                ) {
                    const url = new URL(a.attr('href') ?? '', ORIGIN);
                    if (
                        url.origin === ORIGIN &&
                        /^\/[a-z0-9-]+-\d+$/.test(url.pathname)
                    )
                        matches.add(url.pathname);
                }
            });
            if (matches.size !== 1)
                return empty('no unique exact anime-title match');
            const path = [...matches][0],
                animeId = /-(\d+)$/.exec(path)![1];
            const listing = JSON.parse(
                await this.read(
                    new URL('/api/theme/episode/list/' + animeId, ORIGIN),
                    ['hianime.ba'],
                    signal
                )
            );
            if (listing.status !== true || typeof listing.html !== 'string')
                return empty('episode list unavailable');
            const episodes = load(listing.html);
            const found = episodes(`.ep-item[data-number="${episode}"]`);
            if (
                found.length !== 1 ||
                !/^\d+$/.test(found.attr('data-id') ?? '')
            )
                return empty('exact absolute episode unavailable');
            const episodeId = found.attr('data-id')!;
            const response = JSON.parse(
                await this.read(
                    new URL(
                        '/api/theme/episode/servers?episodeId=' + episodeId,
                        ORIGIN
                    ),
                    ['hianime.ba'],
                    signal
                )
            );
            if (response.status !== true || typeof response.html !== 'string')
                return empty('servers unavailable');
            const servers = load(response.html);
            const rows: { url: URL; kind: string }[] = [];
            servers('.server-item[data-hash]').each((_, el) => {
                const kind = servers(el).attr('data-type');
                if (kind !== 'sub' && kind !== 'dub') return;
                try {
                    const u = new URL(
                        Buffer.from(
                            servers(el).attr('data-hash')!,
                            'base64'
                        ).toString('utf8')
                    );
                    if (
                        allowed(u, EMBEDS) &&
                        !rows.some((r) => r.url.href === u.href)
                    )
                        rows.push({ url: u, kind });
                } catch {
                    /* Ignore malformed/unrecognized players. */
                }
            });
            const results = await Promise.allSettled(
                rows.slice(0, 4).map(async (row) => {
                    const player = decodePlayer(
                        await this.read(row.url, EMBEDS, signal)
                    );
                    const url = new URL(String(player.src));
                    if (!allowed(url, MEDIA))
                        throw new Error('unrecognized media host');
                    const headers = {
                        'User-Agent': UA,
                        Referer: row.url.origin + '/',
                        Origin: row.url.origin
                    };
                    // Verification remains enabled. HTML/error pages never become playable sources.
                    const master = await this.read(url, MEDIA, signal, headers);
                    if (!master.trimStart().startsWith('#EXTM3U'))
                        throw new Error('not HLS');
                    const language =
                        row.kind === 'dub'
                            ? 'en'
                            : (series.original_language ?? 'und');
                    const source: Source = {
                        url: this.createProxyUrl(url.href, headers),
                        type: 'hls',
                        quality: 'Auto',
                        audioTracks: [
                            {
                                language,
                                label:
                                    row.kind === 'dub'
                                        ? 'English dub'
                                        : 'Original audio (subtitled)'
                            }
                        ],
                        provider: {
                            id: this.id,
                            name:
                                this.name +
                                (row.kind === 'dub' ? ' / Dub' : ' / Sub')
                        }
                    };
                    const subtitles: Subtitle[] = [];
                    if (Array.isArray(player.subtitles))
                        for (const s of player.subtitles.slice(0, 40)) {
                            if (
                                !s ||
                                typeof s !== 'object' ||
                                typeof s.src !== 'string'
                            )
                                continue;
                            try {
                                const sub = new URL(s.src);
                                if (allowed(sub, MEDIA))
                                    subtitles.push({
                                        url: this.createProxyUrl(
                                            sub.href,
                                            headers
                                        ),
                                        format: 'vtt',
                                        label:
                                            typeof s.label === 'string'
                                                ? s.label
                                                : 'Subtitles'
                                    });
                            } catch {
                                /* Invalid subtitle. */
                            }
                        }
                    return { source, subtitles };
                })
            );
            const sources: Source[] = [],
                subtitles: Subtitle[] = [];
            for (const r of results)
                if (r.status === 'fulfilled') {
                    sources.push(r.value.source);
                    subtitles.push(...r.value.subtitles);
                }
            if (!sources.length)
                return empty(
                    'no supported verified player; blocked, unavailable or changed upstream'
                );
            return { sources, subtitles, diagnostics: [] };
        } catch {
            // Never include signed URLs, TMDB keys, player blobs or upstream error bodies.
            return empty(
                signal.aborted
                    ? 'discovery deadline exceeded'
                    : 'upstream lookup failed or provider format changed'
            );
        }
    }
    private async read(
        url: URL,
        hosts: string[],
        signal: AbortSignal,
        headers: Record<string, string> = this.HEADERS
    ): Promise<string> {
        if (!allowed(url, hosts)) throw new Error('unsupported host');
        const r = await this.fetchImpl(url.href, {
            headers,
            signal,
            redirect: 'manual'
        });
        if (!r.ok) throw new Error('upstream HTTP failure');
        if (!r.body) throw new Error('empty upstream body');
        const reader = r.body.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 4 * 1024 * 1024)
                    throw new Error('upstream body too large');
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        return Buffer.concat(chunks).toString('utf8');
    }
}
