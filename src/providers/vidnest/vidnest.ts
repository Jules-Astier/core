import { BaseProvider } from '@omss/framework';
import type {
    Diagnostic,
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';

import decrypt from './decrypt.js';
import {
    createVidnestLeafPolicy,
    VIDNEST_ELIGIBLE_LEAVES,
    VIDNEST_FAMILY_ID,
    VIDNEST_REQUESTED_SERVERS,
    VIDNEST_LEAF_POLICY,
    type VidnestLeaf,
    type VidnestLeafEnvironment,
    type VidnestLeafPolicy
} from './vidnest.config.js';
import {
    createProviderIdentityCatalog,
    type IdentifiedSource
} from '../../provider-identity.js';
import type {
    ServerMap,
    SupportedServer,
    klikxxiResponse,
    allmoviesResponse,
    onehdResponse,
    hollymoviehdResponse,
    vidlinkResponse,
    purstreamResponse,
    deltaResponse,
    movieboxSource
} from './vidnest.types.js';

const identityCatalog = createProviderIdentityCatalog([
    { id: VIDNEST_FAMILY_ID, kind: 'aggregator' },
    ...VIDNEST_ELIGIBLE_LEAVES.map((leaf) => ({
        id: `${VIDNEST_FAMILY_ID}:${leaf}`,
        familyId: VIDNEST_FAMILY_ID,
        kind: 'upstream'
    }))
]);

export type VidnestDependencies = {
    readonly environment?: VidnestLeafEnvironment;
    readonly leafPolicy?: VidnestLeafPolicy;
    readonly fetch?: typeof fetch;
    readonly decrypt?: <T>(payload: string) => T;
};

export class VidNestProvider extends BaseProvider {
    readonly id = 'vidnest';
    readonly name = 'VidNest';
    readonly enabled = true;

    readonly BASE_URL = 'https://vidnest.fun';
    readonly API_BASE_URL = 'https://new.vidnest.fun';

    readonly HEADERS: Record<string, string> = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

    /**
     * ALL servers (some unsupported)
     */
    private readonly SERVERS: readonly {
        path: (typeof VIDNEST_REQUESTED_SERVERS)[number];
        query: string;
    }[];
    private readonly leafPolicy: VidnestLeafPolicy;
    private readonly fetchImpl: typeof fetch;
    private readonly decryptImpl: NonNullable<VidnestDependencies['decrypt']>;

    private readonly handlers: {
        [K in SupportedServer]: {
            parse: (data: string) => ServerMap[K];
            mapSources: (root: ServerMap[K]) => Source[];
            mapSubtitles: (root: ServerMap[K]) => Subtitle[];
        };
    } = {
        klikxxi: {
            parse: (d) => this.decryptImpl<klikxxiResponse>(d),
            mapSources: (root) =>
                root.sources.map((s) => ({
                    url: this.createProxyUrl(s.url),
                    type: this.inferSourceType(s.type, s.url),
                    quality: s.quality,
                    audioTracks: [{ language: 'English', label: 'eng' }],
                    ...this.identity('klikxxi')
                })),
            mapSubtitles: () => []
        },

        allmovies: {
            parse: (d) => this.decryptImpl<allmoviesResponse>(d),
            mapSources: (root) =>
                root.streams.map((s) => ({
                    url: this.createProxyUrl(s.url, s.headers),
                    type: this.inferSourceType(s.type, s.url),
                    quality: 'Auto',
                    audioTracks: [{ language: s.language, label: s.language }],
                    ...this.identity('allmovies')
                })),
            mapSubtitles: () => []
        },

        onehd: {
            parse: (d) => this.decryptImpl<onehdResponse>(d),
            mapSources: (root) => [
                {
                    url: this.createProxyUrl(root.url, root.headers),
                    type: this.inferSourceType('', root.url),
                    quality: 'Auto',
                    audioTracks: [{ language: 'English', label: 'eng' }],
                    ...this.identity('onehd')
                }
            ],
            mapSubtitles: (root) =>
                root.subtitles.map((s) => ({
                    url: this.createProxyUrl(s.url, root.headers),
                    label: s.lang,
                    format: this.inferSubtitleFormat(s.url)
                }))
        },

        hollymoviehd: {
            parse: (d) => this.decryptImpl<hollymoviehdResponse>(d),
            mapSources: (root) =>
                'streams' in root
                    ? root.streams.map((s) => ({
                          url: this.createProxyUrl(s.url, s.headers),
                          type: this.inferSourceType(s.type, s.url),
                          quality: 'Auto',
                          audioTracks: [
                              {
                                  language: s.language,
                                  label: s.language
                              }
                          ],
                          ...this.identity('hollymoviehd')
                      }))
                    : root.sources.map((s) => ({
                          url: this.createProxyUrl(s.file),
                          type: this.inferSourceType(s.type, s.file),
                          quality: s.label,
                          audioTracks: [{ language: 'English', label: 'eng' }],
                          ...this.identity('hollymoviehd')
                      })),
            mapSubtitles: () => []
        },

        vidlink: {
            parse: (d) => this.decryptImpl<vidlinkResponse>(d),
            mapSources: (root) => {
                const stream = root.data.stream;
                const variants = stream.qualities
                    ? Object.entries(stream.qualities).map(
                          ([quality, value]) => ({
                              quality,
                              url: value.url,
                              type: value.type ?? stream.type,
                              headers: {
                                  ...root.headers,
                                  ...(value.headers ?? {})
                              }
                          })
                      )
                    : stream.playlist
                      ? [
                            {
                                quality: 'Auto',
                                url: stream.playlist,
                                type: stream.type,
                                headers: root.headers
                            }
                        ]
                      : [];
                return variants.map((variant) => ({
                    url: this.createProxyUrl(variant.url, variant.headers),
                    type: this.inferSourceType(variant.type, variant.url),
                    quality: variant.quality,
                    audioTracks: [{ language: 'English', label: 'eng' }],
                    ...this.identity('vidlink')
                }));
            },
            mapSubtitles: (root) =>
                root.data.stream.captions.map((c) => ({
                    url: this.createProxyUrl(c.url, root.headers),
                    label: c.language,
                    format: this.inferSubtitleFormat(c.url)
                }))
        },

        delta: {
            parse: (d) => this.decryptImpl<deltaResponse>(d),
            mapSources: (root) =>
                root.streams.map((s) => ({
                    url: this.createProxyUrl(s.url),
                    type: this.inferSourceType(s.type, s.url),
                    quality: 'Auto',
                    audioTracks: [
                        { language: s.language.slice(0, 3), label: s.language }
                    ],
                    provider: { id: this.id, name: this.name }
                })),
            mapSubtitles: () => []
        },

        purstream: {
            parse: (d) => this.decryptImpl<purstreamResponse>(d),
            mapSources: (root) =>
                root.sources.map((s) => ({
                    url: this.createProxyUrl(s.url),
                    type: this.inferSourceType(s.format, s.url),
                    quality: this.inferQuality(s.name),
                    audioTracks: [{ language: 'French', label: 'fr' }],
                    ...this.identity('purstream')
                })),
            mapSubtitles: () => []
        },

        moviebox: {
            parse: (d) => this.decryptImpl<movieboxSource>(d),
            mapSources: (root) =>
                root.url.map((u) => ({
                    url: this.createProxyUrl(u.link, this.HEADERS),
                    type: this.inferSourceType(u.type, u.link),
                    quality: 'Auto',
                    audioTracks: [
                        { language: u.lang.slice(0, 3), label: u.lang }
                    ],
                    ...this.identity('moviebox')
                })),
            mapSubtitles: () => []
        }
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    constructor(dependencies: VidnestDependencies = {}) {
        super();
        this.leafPolicy =
            dependencies.leafPolicy ??
            (dependencies.environment
                ? createVidnestLeafPolicy(dependencies.environment)
                : VIDNEST_LEAF_POLICY);
        this.SERVERS = VIDNEST_REQUESTED_SERVERS.filter(
            (path) =>
                VIDNEST_ELIGIBLE_LEAVES.includes(path as VidnestLeaf) &&
                this.leafPolicy.enabled(path as VidnestLeaf)
        ).map((path) => ({
            path,
            query: path === 'onehd' ? '?server=upcloud' : ''
        }));
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.decryptImpl = dependencies.decrypt ?? decrypt;
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
        const sources: Source[] = [];
        const subtitles: Subtitle[] = [];
        const diagnostics: Diagnostic[] = [];

        const promises = this.SERVERS.map((server) => {
            const url =
                media.type === 'movie'
                    ? this.buildMovieUrl(media, server.path) + server.query
                    : this.buildTvUrl(media, server.path) + server.query;

            return this.fetchVidnest(url);
        });

        const results = await Promise.allSettled(promises);
        const rejectedCount = results.filter(
            (result) => result.status === 'rejected'
        ).length;

        if (rejectedCount > 0) {
            diagnostics.push({
                code: 'PARTIAL_SCRAPE',
                field: '',
                message: `${this.name}: ${rejectedCount}/${results.length} upstream requests failed`,
                severity: rejectedCount === results.length ? 'error' : 'warning'
            });
        }

        results.forEach((result, i) => {
            if (result.status !== 'fulfilled') return;

            const server = this.SERVERS[i];
            const handler = this.handlers[server.path as SupportedServer];

            if (!handler) {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    field: '',
                    message: `${this.name}: ${server.path} returned sources, but we don't have a handler for it yet (check for updates: https://github.com/cinepro-org/core).`,
                    severity: 'warning'
                });
                return;
            }
            const key = server.path as SupportedServer;

            if (!(key in this.handlers)) return;
            if (!this.leafPolicy.enabled(key as VidnestLeaf)) return;

            try {
                const { sources: s, subtitles: sub } = this.handleServer(
                    key,
                    result.value.data
                );

                sources.push(...s);
                subtitles.push(...sub);
            } catch {
                diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    field: '',
                    message: `${this.name}: ${server.path} returned an unusable response`,
                    severity: 'warning'
                });
            }
        });

        return {
            sources,
            subtitles,
            diagnostics
        };
    }

    private handleServer<K extends SupportedServer>(
        key: K,
        data: string
    ): { sources: Source[]; subtitles: Subtitle[] } {
        const handler = this.handlers[key];
        const root = handler.parse(data);

        return {
            sources: handler.mapSources(root),
            subtitles: handler.mapSubtitles(root)
        };
    }

    private buildMovieUrl(media: ProviderMediaObject, server: string) {
        return `${this.API_BASE_URL}/${server}/movie/${media.tmdbId}`;
    }

    private buildTvUrl(media: ProviderMediaObject, server: string) {
        return `${this.API_BASE_URL}/${server}/tv/${media.tmdbId}/${media.s}/${media.e}`;
    }

    private async fetchVidnest(url: string) {
        const res = await this.fetchImpl(url, { headers: this.HEADERS });

        if (!res.ok) {
            throw new Error(`VidNest: ${res.status}`);
        }

        return res.json() as Promise<{ encrypted: boolean; data: string }>;
    }

    private identity(
        leaf: VidnestLeaf
    ): Pick<IdentifiedSource, 'provider' | 'providerFamilyId' | 'upstreamId'> {
        const identified = identityCatalog.identifySource(
            {
                url: 'https://identity.invalid',
                type: 'hls',
                quality: 'Auto',
                audioTracks: []
            },
            {
                familyId: VIDNEST_FAMILY_ID,
                upstreamId: `${VIDNEST_FAMILY_ID}:${leaf}`,
                providerName: this.name
            }
        );
        return {
            provider: identified.provider,
            providerFamilyId: identified.providerFamilyId,
            upstreamId: identified.upstreamId
        };
    }

    private inferSourceType(type: string, url: string): SourceType {
        const t = (type ?? '').toLowerCase();
        if (t === 'hls' || url.includes('.m3u8')) return 'hls';
        if (t === 'dash' || url.includes('.mpd')) return 'dash';
        if (t === 'mp4' || url.includes('.mp4')) return 'mp4';
        if (t === 'mkv' || url.includes('.mkv')) return 'mkv';
        if (t === 'webm' || url.includes('.webm')) return 'webm';
        if (t === 'embed') return 'embed';
        return 'hls';
    }

    private inferSubtitleFormat(url: string): SubtitleFormat {
        const u = url.toLowerCase();
        if (u.includes('.vtt')) return 'vtt';
        if (u.includes('.srt')) return 'srt';
        if (u.includes('.ass')) return 'ass';
        if (u.includes('.ssa')) return 'ssa';
        if (u.includes('.ttml')) return 'ttml';
        return 'vtt';
    }
}
