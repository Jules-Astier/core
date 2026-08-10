import { BaseProvider } from '@omss/framework';
import type {
    Diagnostic,
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    SourceType,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';
import {
    VIDLOVE_LEAF_POLICY,
    type VidLoveLeafPolicy
} from './vidlove.config.js';
import {
    VIDLOVE_FAMILY_ID,
    VIDLOVE_LEAVES,
    vidLoveIdentityCatalog,
    vidLoveUpstreamId,
    type VidLoveLeaf
} from './vidlove.identity.js';
import type {
    VidLoveResponse,
    VidLoveSource,
    VidLoveSubtitle
} from './vidlove.types.js';

const DEFAULT_PLAYER_URL = 'https://player.vidlove.cc';
const DISCOVERY_TIMEOUT_MS = 5_000;
const LEAF_TIMEOUT_MS = 4_000;

const LEAF_NAMES: Readonly<Record<VidLoveLeaf, string>> = {
    moviebox: 'MovieBox',
    vidapi: 'VidAPI',
    ipcloud: 'IPCloud',
    tcloud: 'TCloud',
    vixsrc: 'VixSrc',
    '1embed': '1Embed',
    xpass: 'XPass',
    vidrift: 'Vidrift',
    lookmovie: 'LookMovie',
    vidnest: 'VidNest'
};

type VidLoveDependencies = {
    fetch?: typeof fetch;
    playerUrl?: string;
    apiUrl?: string;
    leafPolicy?: VidLoveLeafPolicy;
};

type LeafResult = {
    leaf: VidLoveLeaf;
    response: VidLoveResponse;
};

function envFlag(name: string, defaultValue: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === undefined) return defaultValue;
    return ['true', '1', 'yes', 'on'].includes(value);
}

export class VidLoveProvider extends BaseProvider {
    readonly id = 'vidlove';
    readonly name = 'VidLove';
    readonly enabled = envFlag('VIDLOVE_ENABLED', true);
    readonly BASE_URL: string;
    readonly PLAYER_URL: string;
    readonly HEADERS: Record<string, string>;
    readonly SERVERS = VIDLOVE_LEAVES;

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    private readonly fetchImpl: typeof fetch;
    private readonly configuredApiUrl?: string;
    private readonly leafPolicy: VidLoveLeafPolicy;
    private discoveredApiUrl?: Promise<string>;

    constructor(dependencies: VidLoveDependencies = {}) {
        super();
        this.PLAYER_URL = normalizeOrigin(
            dependencies.playerUrl ??
                process.env.VIDLOVE_PLAYER_URL ??
                DEFAULT_PLAYER_URL,
            'player'
        );
        this.BASE_URL = this.PLAYER_URL;
        const apiUrl = dependencies.apiUrl ?? process.env.VIDLOVE_API_URL;
        this.configuredApiUrl = apiUrl
            ? normalizeOrigin(apiUrl, 'API')
            : undefined;
        this.HEADERS = {
            'User-Agent':
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${this.PLAYER_URL}/`,
            Origin: this.PLAYER_URL
        };
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.leafPolicy = dependencies.leafPolicy ?? VIDLOVE_LEAF_POLICY;
    }

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        try {
            this.validateMedia(media);
            const apiUrl = await this.apiUrl(media);
            const leaves = this.SERVERS.filter((leaf) =>
                this.leafPolicy.enabledLeaves.has(leaf)
            );
            const settled = await Promise.allSettled(
                leaves.map((leaf) => this.resolveLeaf(apiUrl, leaf, media))
            );
            const successful = settled
                .filter(
                    (result): result is PromiseFulfilledResult<LeafResult> =>
                        result.status === 'fulfilled'
                )
                .map(({ value }) => value);
            const sources = successful.flatMap(({ leaf, response }) =>
                response.source ? this.mapSource(leaf, response.source) : []
            );
            const subtitles = this.mapSubtitles(successful);
            const failures = settled.length - successful.length;
            const diagnostics: Diagnostic[] = [];
            if (failures > 0) {
                diagnostics.push({
                    code:
                        sources.length > 0
                            ? 'PARTIAL_SCRAPE'
                            : 'PROVIDER_ERROR',
                    message: `${this.name}: ${failures} upstream resolver(s) were unavailable`,
                    field: '',
                    severity: sources.length > 0 ? 'warning' : 'error'
                });
            }
            if (sources.length === 0 && diagnostics.length === 0) {
                diagnostics.push({
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: no supported streams were returned`,
                    field: '',
                    severity: 'error'
                });
            }
            return { sources, subtitles, diagnostics };
        } catch {
            return this.emptyResult('upstream response was unavailable');
        }
    }

    private validateMedia(media: ProviderMediaObject): void {
        if (!/^\d+$/.test(media.tmdbId)) {
            throw new TypeError('VidLove requires a TMDB ID');
        }
        if (
            media.type === 'tv' &&
            (!Number.isInteger(media.s) || !Number.isInteger(media.e))
        ) {
            throw new TypeError('VidLove TV media requires season and episode');
        }
    }

    private async apiUrl(media: ProviderMediaObject): Promise<string> {
        if (this.configuredApiUrl) return this.configuredApiUrl;
        this.discoveredApiUrl ??= this.discoverApiUrl(media);
        return this.discoveredApiUrl;
    }

    private async discoverApiUrl(media: ProviderMediaObject): Promise<string> {
        const embedUrl = this.embedUrl(media);
        const htmlResponse = await this.fetchImpl(embedUrl, {
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
            headers: {
                ...this.HEADERS,
                Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
            }
        });
        if (!htmlResponse.ok) throw new Error('VidLove embed request failed');
        const html = await htmlResponse.text();
        const scriptPath = html.match(
            /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i
        )?.[1];
        if (!scriptPath) {
            throw new TypeError('VidLove player bundle was not found');
        }
        const scriptUrl = new URL(scriptPath, `${this.PLAYER_URL}/`);
        if (scriptUrl.origin !== this.PLAYER_URL) {
            throw new TypeError('VidLove player bundle origin was invalid');
        }
        const bundleResponse = await this.fetchImpl(scriptUrl, {
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
            headers: this.HEADERS
        });
        if (!bundleResponse.ok) {
            throw new Error('VidLove player bundle request failed');
        }
        const bundle = await bundleResponse.text();
        for (const match of bundle.matchAll(/https:\/\/[A-Za-z0-9.-]+/g)) {
            const candidate = match[0];
            const tail = bundle.slice(match.index, match.index + 4_000);
            if (tail.includes('/movie?id=') && tail.includes('mode=json')) {
                return normalizeOrigin(candidate, 'API');
            }
        }
        throw new TypeError('VidLove API origin was not discoverable');
    }

    private embedUrl(media: ProviderMediaObject): string {
        if (media.type === 'movie') {
            return `${this.PLAYER_URL}/embed/movie/${encodeURIComponent(media.tmdbId)}`;
        }
        return `${this.PLAYER_URL}/embed/tv/${encodeURIComponent(media.tmdbId)}/${media.s}/${media.e}`;
    }

    private async resolveLeaf(
        apiUrl: string,
        leaf: VidLoveLeaf,
        media: ProviderMediaObject
    ): Promise<LeafResult> {
        const url = new URL(
            media.type === 'tv' ? '/tv' : '/movie',
            `${apiUrl}/`
        );
        url.searchParams.set('id', media.tmdbId);
        if (media.type === 'tv') {
            url.searchParams.set('season', String(media.s));
            url.searchParams.set('episode', String(media.e));
        }
        url.searchParams.set('mode', 'json');
        url.searchParams.set('sources', leaf);
        const response = await this.fetchImpl(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(LEAF_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error('VidLove source request failed');
        const parsed = (await response.json()) as VidLoveResponse;
        if (!parsed || typeof parsed !== 'object') {
            throw new TypeError('VidLove source response was malformed');
        }
        if (
            parsed.source &&
            parsed.source.source?.trim().toLowerCase() !== leaf
        ) {
            throw new TypeError('VidLove source identity did not match');
        }
        return { leaf, response: parsed };
    }

    private mapSource(leaf: VidLoveLeaf, input: VidLoveSource) {
        if (!input.url || !isSafeRemoteUrl(input.url)) return [];
        const type = supportedSourceType(input);
        if (!type) return [];
        const mediaUrl =
            type === 'hls'
                ? (bestManifestVariant(input.manifest, input.url) ?? input.url)
                : input.url;
        if (!isSafeRemoteUrl(mediaUrl)) return [];
        const headers = {
            ...this.HEADERS,
            ...safeHeaders(input.headers)
        };
        return [
            vidLoveIdentityCatalog.identifySource(
                {
                    url: this.createProxyUrl(
                        mediaUrl,
                        headers,
                        leaf === 'ipcloud'
                            ? {
                                  responseTransform: 'strip-png-ts-prefix'
                              }
                            : undefined
                    ),
                    type,
                    quality: sourceQuality(input),
                    audioTracks: [{ language: 'und', label: 'Original' }]
                },
                {
                    familyId: VIDLOVE_FAMILY_ID,
                    upstreamId: vidLoveUpstreamId(leaf),
                    providerName: `${this.name} / ${LEAF_NAMES[leaf]}`
                }
            )
        ];
    }

    private mapSubtitles(results: LeafResult[]): Subtitle[] {
        const subtitles = new Map<string, Subtitle>();
        for (const { response } of results) {
            for (const input of response.subtitles ?? []) {
                const mapped = this.mapSubtitle(input);
                if (mapped && !subtitles.has(mapped.url)) {
                    subtitles.set(mapped.url, mapped);
                }
            }
        }
        return [...subtitles.values()];
    }

    private mapSubtitle(input: VidLoveSubtitle): Subtitle | null {
        const value = input.file ?? input.url;
        if (!value || !isSafeRemoteUrl(value)) return null;
        return {
            url: this.createProxyUrl(value, this.HEADERS),
            label:
                input.display?.trim() ||
                input.label?.trim() ||
                input.language?.trim() ||
                'Unknown',
            format: subtitleFormat(input)
        };
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ]
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(`${this.PLAYER_URL}/`, {
                signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
                headers: this.HEADERS
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

function supportedSourceType(input: VidLoveSource): SourceType | null {
    const manifest = input.manifest?.trimStart();
    if (manifest?.startsWith('#EXTM3U')) return 'hls';
    const value = `${input.type ?? ''} ${input.url ?? ''}`.toLowerCase();
    if (value.includes('.m3u8') || /\bhls\b/.test(value)) return 'hls';
    if (value.includes('.mp4') || /\bmp4\b/.test(value)) return 'mp4';
    return null;
}

function sourceQuality(input: VidLoveSource): string {
    if (input.quality?.trim()) return input.quality.trim();
    const heights = [
        ...(input.manifest ?? '').matchAll(/RESOLUTION=\d+x(\d+)/gi)
    ]
        .map((match) => Number.parseInt(match[1], 10))
        .filter(Number.isFinite);
    return heights.length > 0 ? `${Math.max(...heights)}p` : 'Auto';
}

function bestManifestVariant(
    manifest: string | undefined,
    masterUrl: string
): string | null {
    if (!manifest?.trimStart().startsWith('#EXTM3U')) return null;
    const variants: Array<{ height: number; url: string }> = [];
    const lines = manifest.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
        const height = Number.parseInt(
            line.match(/RESOLUTION=\d+x(\d+)/i)?.[1] ?? '0',
            10
        );
        const next = lines
            .slice(index + 1)
            .map((entry) => entry.trim())
            .find((entry) => entry && !entry.startsWith('#'));
        if (!next) continue;
        try {
            const url = new URL(next, masterUrl).toString();
            if (isSafeRemoteUrl(url)) variants.push({ height, url });
        } catch {
            continue;
        }
    }
    variants.sort((left, right) => right.height - left.height);
    return variants[0]?.url ?? null;
}

function safeHeaders(value: Record<string, unknown> | undefined) {
    const allowed = new Set([
        'accept',
        'accept-language',
        'origin',
        'referer',
        'user-agent'
    ]);
    const headers: Record<string, string> = {};
    for (const [name, entry] of Object.entries(value ?? {})) {
        if (allowed.has(name.toLowerCase()) && typeof entry === 'string') {
            headers[name] = entry;
        }
    }
    return headers;
}

function subtitleFormat(input: VidLoveSubtitle): SubtitleFormat {
    const value =
        `${input.type ?? ''} ${input.format ?? ''} ${input.file ?? ''} ${input.url ?? ''}`.toLowerCase();
    if (value.includes('.srt') || /\bsrt\b/.test(value)) return 'srt';
    if (value.includes('.ass') || /\bass\b/.test(value)) return 'ass';
    if (value.includes('.ssa') || /\bssa\b/.test(value)) return 'ssa';
    if (value.includes('.xml') || /\bttml\b/.test(value)) return 'ttml';
    return 'vtt';
}

function isSafeRemoteUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
        return false;
    }
}

function normalizeOrigin(value: string, label: string): string {
    const url = new URL(value);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    ) {
        throw new TypeError(`VidLove ${label} origin must be an HTTPS origin`);
    }
    return url.origin;
}
