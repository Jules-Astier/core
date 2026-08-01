import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    SourceType,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import {
    createEzVidApiLeafPolicy,
    EZVIDAPI_FAMILY_ID,
    EZVIDAPI_LEAVES,
    resolveEzVidApiLeaf,
    type EzVidApiEnvironment,
    type EzVidApiLeaf
} from './ezvidapi.config.js';

type EzVidApiResponse = {
    provider?: string;
    stream_url?: string;
    stream_type?: string;
    subtitles?: Array<{
        url?: string;
        label?: string;
        language?: string;
        format?: string;
    }>;
};

type EzVidProvider = {
    name: string;
    types?: string[];
    subtitles?: boolean;
};

type SelectedProvider = {
    leaf: EzVidApiLeaf;
    requestName: string;
    displayLabel: string;
};

export type EzVidApiDependencies = {
    readonly environment?: EzVidApiEnvironment;
    readonly fetch?: typeof fetch;
};

export class EzVidApiProvider extends BaseProvider {
    readonly id = 'ezvidapi';
    readonly name = 'EzVidAPI';
    readonly enabled: boolean;
    readonly BASE_URL = 'https://api.ezvidapi.com';
    readonly FRONTEND_URL = 'https://ezvidapi.com';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: `${this.FRONTEND_URL}/`,
        Origin: this.FRONTEND_URL
    };

    private readonly fetchImpl: typeof fetch;
    private readonly leafPolicy: ReturnType<typeof createEzVidApiLeafPolicy>;

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    constructor(dependencies: EzVidApiDependencies = {}) {
        super();
        const environment = dependencies.environment ?? process.env;
        this.enabled = environment.EZVIDAPI_ENABLED === 'true';
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.leafPolicy = createEzVidApiLeafPolicy(environment);
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
        const providers = await this.getProviderNames(media);
        const results = await Promise.allSettled(
            providers.map((provider) => this.fetchProvider(provider, media))
        );

        const sources: IdentifiedSource[] = [];
        const subtitlesByUrl = new Map<string, Subtitle>();
        let failed = 0;

        for (const result of results) {
            if (result.status === 'rejected' || !result.value) {
                failed++;
                continue;
            }

            sources.push(result.value.source);
            for (const subtitle of result.value.subtitles) {
                subtitlesByUrl.set(subtitle.url, subtitle);
            }
        }

        if (!sources.length) {
            return this.emptyResult('No EzVidAPI providers returned sources');
        }

        return {
            sources,
            subtitles: [...subtitlesByUrl.values()],
            diagnostics:
                failed > 0
                    ? [
                          {
                              code: 'PARTIAL_SCRAPE',
                              message: `${failed} of ${providers.length} EzVidAPI upstream providers failed`,
                              field: '',
                              severity: 'warning'
                          }
                      ]
                    : []
        };
    }

    private async getProviderNames(
        media: ProviderMediaObject
    ): Promise<SelectedProvider[]> {
        try {
            const response = await this.fetchImpl(`${this.BASE_URL}/list`, {
                headers: this.HEADERS
            });

            if (!response.ok) {
                return this.fallbackProviders();
            }

            const data = (await response.json()) as {
                providers?: EzVidProvider[];
            };
            const wantedType = media.type === 'movie' ? 'movie' : 'tv';
            const providers = (data.providers ?? [])
                .filter((provider) => provider.types?.includes(wantedType))
                .map((provider) => this.selectProvider(provider.name))
                .filter(
                    (provider): provider is SelectedProvider =>
                        provider !== undefined
                );

            return providers.length
                ? this.uniqueProviders(providers)
                : this.fallbackProviders();
        } catch {
            return this.fallbackProviders();
        }
    }

    private async fetchProvider(
        provider: SelectedProvider,
        media: ProviderMediaObject
    ): Promise<{ source: IdentifiedSource; subtitles: Subtitle[] } | null> {
        const url = this.buildApiUrl(provider.requestName, media);
        const response = await this.fetchImpl(url, { headers: this.HEADERS });

        if (!response.ok) {
            return null;
        }

        const data = (await response.json()) as EzVidApiResponse;
        if (!data.stream_url) {
            return null;
        }

        const responseLeaf =
            data.provider === undefined
                ? provider.leaf
                : resolveEzVidApiLeaf(data.provider);
        if (!responseLeaf || !this.leafPolicy.enabled(responseLeaf)) {
            return null;
        }
        const displayLabel =
            data.provider?.trim() ||
            provider.displayLabel ||
            responseLeaf.label;
        return {
            source: {
                url: this.createProxyUrl(data.stream_url, this.HEADERS),
                type: this.inferSourceType(data.stream_type, data.stream_url),
                quality: 'Auto',
                audioTracks: [
                    {
                        language: 'eng',
                        label: 'English'
                    }
                ],
                provider: {
                    id: responseLeaf.id,
                    name: `${this.name} / ${displayLabel}`
                },
                providerFamilyId: EZVIDAPI_FAMILY_ID,
                upstreamId: responseLeaf.id
            },
            subtitles: (data.subtitles ?? [])
                .filter((subtitle) => Boolean(subtitle.url))
                .map((subtitle) => ({
                    url: this.createProxyUrl(subtitle.url!, this.HEADERS),
                    label:
                        subtitle.label ??
                        subtitle.language ??
                        `${displayLabel} subtitle`,
                    format: this.inferSubtitleFormat(
                        subtitle.format,
                        subtitle.url!
                    )
                }))
        };
    }

    private selectProvider(name: string): SelectedProvider | undefined {
        const leaf = resolveEzVidApiLeaf(name);
        if (!leaf || !this.leafPolicy.enabled(leaf)) return undefined;
        return {
            leaf,
            requestName: name,
            displayLabel: name.trim() || leaf.label
        };
    }

    private fallbackProviders(): SelectedProvider[] {
        return EZVIDAPI_LEAVES.filter((leaf) =>
            this.leafPolicy.enabled(leaf)
        ).map((leaf) => ({
            leaf,
            requestName: leaf.slug,
            displayLabel: leaf.label
        }));
    }

    private uniqueProviders(
        providers: readonly SelectedProvider[]
    ): SelectedProvider[] {
        const seen = new Set<string>();
        return providers.filter(({ leaf }) => {
            if (seen.has(leaf.id)) return false;
            seen.add(leaf.id);
            return true;
        });
    }

    private buildApiUrl(provider: string, media: ProviderMediaObject): string {
        if (media.type === 'movie') {
            return `${this.BASE_URL}/movie/${provider}/${media.tmdbId}`;
        }

        if (!media.s || !media.e) {
            throw new Error('Missing season or episode');
        }

        const params = new URLSearchParams({
            season: String(media.s),
            episode: String(media.e)
        });

        return `${this.BASE_URL}/tv/${provider}/${media.tmdbId}?${params.toString()}`;
    }

    private inferSourceType(type: string | undefined, url: string): SourceType {
        const normalized = type?.toLowerCase();
        if (normalized === 'hls' || url.includes('.m3u8')) return 'hls';
        if (normalized === 'dash' || url.includes('.mpd')) return 'dash';
        if (normalized === 'mp4' || url.includes('.mp4')) return 'mp4';
        if (normalized === 'mkv' || url.includes('.mkv')) return 'mkv';
        if (normalized === 'webm' || url.includes('.webm')) return 'webm';
        return 'hls';
    }

    private inferSubtitleFormat(
        format: string | undefined,
        url: string
    ): SubtitleFormat {
        const value = `${format ?? ''} ${url}`.toLowerCase();
        if (value.includes('srt')) return 'srt';
        if (value.includes('ass')) return 'ass';
        if (value.includes('ssa')) return 'ssa';
        if (value.includes('ttml') || value.includes('.xml')) return 'ttml';
        return 'vtt';
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
            const response = await this.fetchImpl(`${this.BASE_URL}/list`, {
                headers: this.HEADERS
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
