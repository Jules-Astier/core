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
import { decryptVidKingPayload } from './decrypt.js';
import {
    VIDKING_LEAF_POLICY,
    type VidKingLeafPolicy
} from './vidking.config.js';
import {
    VIDKING_FAMILY_ID,
    VIDKING_LEAVES,
    vidKingIdentityCatalog,
    vidKingUpstreamId,
    type VidKingLeaf
} from './vidking.identity.js';
import type {
    VidKingSeedResponse,
    VidKingSource,
    VidKingSourceResponse,
    VidKingSubtitle
} from './vidking.types.js';

const DEFAULT_API_URL = 'https://api.speedracelight.com';
const DEFAULT_FRONTEND_URL = 'https://www.vidking.net';

const LEAF_CONFIG: Readonly<
    Record<
        VidKingLeaf,
        { name: string; endpoint: string; qualityFilter?: string }
    >
> = {
    yoru: { name: 'Yoru', endpoint: 'cdn/sources-with-title' },
    cypher: { name: 'Cypher', endpoint: 'downloader2/sources-with-title' },
    breach: { name: 'Breach', endpoint: 'm4uhd/sources-with-title' },
    neon: { name: 'Neon', endpoint: 'vsrc/sources-with-title' },
    vyse: {
        name: 'Vyse',
        endpoint: 'hdmovie/sources-with-title',
        qualityFilter: 'English'
    },
    killjoy: { name: 'Killjoy', endpoint: 'meine/sources-with-title' },
    fade: {
        name: 'Fade',
        endpoint: 'hdmovie/sources-with-title',
        qualityFilter: 'Hindi'
    },
    omen: { name: 'Omen', endpoint: 'lamovie/sources-with-title' },
    raze: { name: 'Raze', endpoint: 'superflix/sources-with-title' }
};

type VidKingDependencies = {
    fetch?: typeof fetch;
    decryptPayload?: typeof decryptVidKingPayload;
    apiUrl?: string;
    frontendUrl?: string;
    now?: () => number;
    leafPolicy?: VidKingLeafPolicy;
};

type LeafResult = {
    leaf: VidKingLeaf;
    response: VidKingSourceResponse;
};

function envFlag(name: string, defaultValue: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === undefined) return defaultValue;
    return ['true', '1', 'yes', 'on'].includes(value);
}

export class VidKingProvider extends BaseProvider {
    readonly id = 'vidking';
    readonly name = 'VidKing';
    readonly enabled = envFlag('VIDKING_ENABLED', false);
    readonly BASE_URL: string;
    readonly FRONTEND_URL: string;
    readonly HEADERS: Record<string, string>;
    readonly SERVERS = VIDKING_LEAVES;

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    private readonly fetchImpl: typeof fetch;
    private readonly decryptPayload: typeof decryptVidKingPayload;
    private readonly now: () => number;
    private readonly leafPolicy: VidKingLeafPolicy;

    constructor(dependencies: VidKingDependencies = {}) {
        super();
        this.BASE_URL = normalizeOrigin(
            dependencies.apiUrl ??
                process.env.VIDKING_API_URL ??
                DEFAULT_API_URL
        );
        this.FRONTEND_URL = normalizeOrigin(
            dependencies.frontendUrl ??
                process.env.VIDKING_FRONTEND_URL ??
                DEFAULT_FRONTEND_URL
        );
        this.HEADERS = {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${this.FRONTEND_URL}/`,
            Origin: this.FRONTEND_URL
        };
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.decryptPayload =
            dependencies.decryptPayload ?? decryptVidKingPayload;
        this.now = dependencies.now ?? Date.now;
        this.leafPolicy = dependencies.leafPolicy ?? VIDKING_LEAF_POLICY;
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
            const seed = await this.fetchSeed(media.tmdbId);
            const leaves = this.SERVERS.filter((leaf) =>
                this.leafPolicy.enabledLeaves.has(leaf)
            );
            const settled = await Promise.allSettled(
                leaves.map((leaf) => this.resolveLeaf(leaf, media, seed))
            );
            const successful = settled
                .filter(
                    (result): result is PromiseFulfilledResult<LeafResult> =>
                        result.status === 'fulfilled'
                )
                .map(({ value }) => value);
            const sources = successful.flatMap(({ leaf, response }) =>
                this.mapSources(leaf, response.sources ?? [])
            );
            const subtitles = this.mapSubtitles(successful);
            const failures = settled.length - successful.length;
            const diagnostics: Diagnostic[] = [];
            if (failures > 0) {
                diagnostics.push({
                    code: sources.length > 0 ? 'PARTIAL_SCRAPE' : 'PROVIDER_ERROR',
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
        if (!/^\d+$/.test(media.tmdbId) || !media.title?.trim()) {
            throw new TypeError('VidKing requires a TMDB ID and title');
        }
        if (!media.releaseYear || !/^\d{4}$/.test(String(media.releaseYear))) {
            throw new TypeError('VidKing requires a release year');
        }
        if (
            media.type === 'tv' &&
            (!Number.isInteger(media.s) || !Number.isInteger(media.e))
        ) {
            throw new TypeError('VidKing TV media requires season and episode');
        }
    }

    private async fetchSeed(tmdbId: string): Promise<string> {
        const url = new URL('/seed', `${this.BASE_URL}/`);
        url.searchParams.set('mediaId', tmdbId);
        const response = await this.fetchImpl(url, { headers: this.HEADERS });
        if (!response.ok) throw new Error('VidKing seed request failed');
        const data = (await response.json()) as VidKingSeedResponse;
        if (typeof data.seed !== 'string' || data.seed.length < 8) {
            throw new TypeError('VidKing seed response was malformed');
        }
        return data.seed;
    }

    private async resolveLeaf(
        leaf: VidKingLeaf,
        media: ProviderMediaObject,
        seed: string
    ): Promise<LeafResult> {
        const url = this.buildSourceUrl(leaf, media, seed);
        const response = await this.fetchImpl(url, {
            headers: {
                ...this.HEADERS,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0'
            }
        });
        if (!response.ok) throw new Error('VidKing source request failed');
        const encrypted = await response.text();
        const plaintext = this.decryptPayload(
            encrypted,
            seed,
            Number.parseInt(media.tmdbId, 10)
        );
        const parsed = JSON.parse(plaintext) as VidKingSourceResponse;
        if (!parsed || !Array.isArray(parsed.sources)) {
            throw new TypeError('VidKing source response was malformed');
        }
        const qualityFilter = LEAF_CONFIG[leaf].qualityFilter;
        if (qualityFilter) {
            parsed.sources = parsed.sources.filter(
                ({ quality }) => quality === qualityFilter
            );
        }
        return { leaf, response: parsed };
    }

    private buildSourceUrl(
        leaf: VidKingLeaf,
        media: ProviderMediaObject,
        seed: string
    ): URL {
        const url = new URL(LEAF_CONFIG[leaf].endpoint, `${this.BASE_URL}/`);
        url.searchParams.set('title', media.title);
        url.searchParams.set('mediaType', media.type);
        url.searchParams.set('year', String(media.releaseYear));
        url.searchParams.set('episodeId', String(media.e ?? 1));
        url.searchParams.set('seasonId', String(media.s ?? 1));
        url.searchParams.set('tmdbId', media.tmdbId);
        url.searchParams.set('imdbId', media.imdbId ?? '');
        url.searchParams.set('enc', '2');
        url.searchParams.set('seed', seed);
        url.searchParams.set('_t', String(this.now()));
        if (leaf === 'killjoy') url.searchParams.set('language', 'german');
        return url;
    }

    private mapSources(leaf: VidKingLeaf, inputs: VidKingSource[]) {
        const seen = new Set<string>();
        return inputs.flatMap((input) => {
            if (!input.url || seen.has(input.url)) return [];
            const type = supportedSourceType(input);
            if (!type || !isSafeRemoteUrl(input.url)) return [];
            seen.add(input.url);
            return [
                vidKingIdentityCatalog.identifySource(
                    {
                        url: this.createProxyUrl(input.url, this.HEADERS),
                        type,
                        quality: input.quality?.trim() || 'Auto',
                        audioTracks: [
                            { language: 'und', label: 'Original' }
                        ]
                    },
                    {
                        familyId: VIDKING_FAMILY_ID,
                        upstreamId: vidKingUpstreamId(leaf),
                        providerName: `${this.name} / ${LEAF_CONFIG[leaf].name}`
                    }
                )
            ];
        });
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

    private mapSubtitle(input: VidKingSubtitle): Subtitle | null {
        if (!input.url || !isSafeRemoteUrl(input.url)) return null;
        return {
            url: this.createProxyUrl(input.url, this.HEADERS),
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
            const seed = await this.fetchSeed('603');
            return seed.length >= 8;
        } catch {
            return false;
        }
    }
}

function supportedSourceType(input: VidKingSource): SourceType | null {
    const value = `${input.type ?? ''} ${input.url ?? ''}`.toLowerCase();
    if (value.includes('.m3u8') || /\bhls\b/.test(value)) return 'hls';
    if (value.includes('.mp4') || /\bmp4\b/.test(value)) return 'mp4';
    return null;
}

function subtitleFormat(input: VidKingSubtitle): SubtitleFormat {
    const value = `${input.type ?? ''} ${input.format ?? ''} ${input.url ?? ''}`.toLowerCase();
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

function normalizeOrigin(value: string): string {
    const url = new URL(value);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    ) {
        throw new TypeError('VidKing origin must be an HTTPS origin');
    }
    return url.origin;
}
