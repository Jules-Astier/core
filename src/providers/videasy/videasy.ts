import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import type { VideasyServer } from './videasy.types.js';
import { decryptResponse } from './decryptor.js';
import type { DecryptedPayload } from './decryptor.js';
import {
    resolveVideasyServers,
    VIDEASY_ACTIVE_SERVERS,
    VIDEASY_FAMILY_ID,
    type VideasyLeafEnvironment
} from './videasy.config.js';
import {
    createProviderIdentityCatalog,
    type IdentifiedSource
} from '../../provider-identity.js';

const identityCatalog = createProviderIdentityCatalog([
    { id: VIDEASY_FAMILY_ID, kind: 'aggregator' },
    ...VIDEASY_ACTIVE_SERVERS.map(({ name }) => ({
        id: `${VIDEASY_FAMILY_ID}:${name}`,
        familyId: VIDEASY_FAMILY_ID,
        kind: 'upstream'
    }))
]);

export type VideasyDependencies = {
    readonly environment?: VideasyLeafEnvironment;
    readonly fetch?: typeof fetch;
    readonly decrypt?: (
        blob: string,
        tmdbId: string
    ) => Promise<DecryptedPayload | null>;
};

export class VideasyProvider extends BaseProvider {
    readonly id = 'Videasy';
    readonly name = 'Videasy';
    readonly enabled = true;
    readonly BASE_URL = 'https://api.videasy.net';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, */*; q=0.01',
        Referer: 'https://player.videasy.net/',
        Origin: 'https://player.videasy.net'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };
    private readonly servers: readonly VideasyServer[];
    private readonly fetchImpl: typeof fetch;
    private readonly decryptImpl: NonNullable<VideasyDependencies['decrypt']>;

    constructor(dependencies: VideasyDependencies = {}) {
        super();
        this.servers = resolveVideasyServers(
            dependencies.environment ?? process.env
        );
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.decryptImpl = dependencies.decrypt ?? decryptResponse;
    }

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    // fans out to all servers in parallel, merges results
    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        const results = await Promise.allSettled(
            this.servers.map((server) => this.fetchFromServer(server, media))
        );

        const sources: ProviderResult['sources'] = [];
        const subtitles: ProviderResult['subtitles'] = [];
        const diagnostics: ProviderResult['diagnostics'] = [];
        let failCount = 0;

        for (const result of results) {
            if (result.status === 'rejected' || !result.value) {
                failCount++;
                continue;
            }
            sources.push(...result.value.sources);
            subtitles.push(...result.value.subtitles);
        }

        if (failCount > 0 && sources.length > 0) {
            diagnostics.push({
                code: 'PARTIAL_SCRAPE',
                message: `${failCount} of ${this.servers.length} videasy servers did not return results`,
                field: '',
                severity: 'warning'
            });
        }

        if (sources.length === 0) {
            return this.emptyResult(
                'all videasy servers returned no sources',
                media
            );
        }

        return { sources, subtitles, diagnostics };
    }

    // I have added a small identification of error in case in future we have some problem
    // if the error has all capital then it proly mean that they shifted their encryption and all
    // if it's small and has same then we might have to change a bit let's say api url ?.
    // suppose the small invalid response indicates that they might have changed their setup
    // while the capital indicates that the response might be short not enough, hope it helps.

    // fetches one server, reads plain text blob, decrypts via enc-dec.app
    private async fetchFromServer(
        server: VideasyServer,
        media: ProviderMediaObject
    ): Promise<ProviderResult | null> {
        const params = this.buildParams(server, media);
        const url = `${server.url}?${new URLSearchParams(params as Record<string, string>)}`;
        const response = await this.fetchImpl(url, { headers: this.HEADERS });

        if (!response.ok) {
            return null;
        }

        // api returns plain text hex blob, not json
        const blob = await response.text();

        if (!blob || blob.length < 10) {
            return null;
        }

        const decrypted = await this.decryptImpl(blob, String(media.tmdbId));

        if (!decrypted || decrypted.sources.length === 0) {
            return null;
        }

        const sources: IdentifiedSource[] = decrypted.sources
            .filter((s) => !!s?.url)
            .map((s) =>
                identityCatalog.identifySource(
                    {
                        url: this.createProxyUrl(s.url, this.HEADERS),
                        type: this.detectType(s.url, s.type),
                        quality: this.normalizeQuality(s.quality),
                        audioTracks: [
                            {
                                language: this.resolveLanguage(server),
                                label: this.resolveLanguageLabel(server)
                            }
                        ]
                    },
                    {
                        familyId: VIDEASY_FAMILY_ID,
                        upstreamId: `${VIDEASY_FAMILY_ID}:${server.name}`,
                        providerName: this.name
                    }
                )
            );

        const subtitles: ProviderResult['subtitles'] = decrypted.subtitles
            .filter((s) => !!s?.url)
            .map((s) => ({
                url: this.createProxyUrl(s.url, {}),
                label: s.lang ?? s.language ?? 'Unknown',
                format: 'vtt' as const
            }));

        return { sources, subtitles, diagnostics: [] };
    }

    // builds query params — title passed as plain string, URLSearchParams handles encoding
    private buildParams(
        server: VideasyServer,
        media: ProviderMediaObject
    ): Record<string, string> {
        const base: Record<string, string> = {
            title: media.title ?? '', // no encodeURIComponent — URLSearchParams does it
            mediaType: media.type === 'movie' ? 'movie' : 'tv',
            tmdbId: String(media.tmdbId),
            imdbId: media.imdbId ?? '',
            episodeId: String(media.type === 'tv' ? (media.e ?? 1) : 1),
            seasonId: String(media.type === 'tv' ? (media.s ?? 1) : 1)
        };

        if (media.type === 'movie') {
            base.year = String(media.releaseYear ?? '');
        }

        if (server.language) {
            base.language = server.language;
        }

        return base;
    }

    // detects stream type from url extension and api hint
    private detectType(url: string, hint?: string): 'hls' | 'mp4' {
        const lower = (hint ?? '').toLowerCase();
        if (
            lower.includes('hls') ||
            lower.includes('m3u8') ||
            url.toLowerCase().includes('.m3u8')
        ) {
            return 'hls';
        }
        return 'mp4';
    }

    // guards against language labels being passed as quality (e.g. "Hindi")
    private normalizeQuality(raw?: string): string {
        if (!raw) return 'unknown';
        return /^\d{3,4}p$|^4K$|^8K$|^HD$|^SD$/i.test(raw.trim())
            ? raw.trim()
            : 'unknown';
    }

    private resolveLanguage(server: VideasyServer): string {
        if (!server.language) return 'en';
        const map: Record<string, string> = {
            german: 'de',
            italian: 'it',
            french: 'fr'
        };
        return map[server.language] ?? 'en';
    }

    private resolveLanguageLabel(server: VideasyServer): string {
        if (!server.language) return 'English';
        const map: Record<string, string> = {
            german: 'German',
            italian: 'Italian',
            french: 'French'
        };
        return map[server.language] ?? 'English';
    }

    private emptyResult(
        message: string,
        _media: ProviderMediaObject
    ): ProviderResult {
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
            const res = await this.fetchImpl(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return res.status < 500;
        } catch {
            return false;
        }
    }
}
