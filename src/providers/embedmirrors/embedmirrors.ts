import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';

type EmbedMirror = {
    baseUrl: string;
    moviePath: (tmdbId: string) => string;
    tvPath: (tmdbId: string, season: number, episode: number) => string;
    probeUrl?: string;
};

function envValue(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value) {
            return value;
        }
    }

    return undefined;
}

function envFlag(name: string, defaultValue: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === undefined) {
        return defaultValue;
    }

    return ['true', '1', 'yes', 'on'].includes(value);
}

abstract class EmbedMirrorProvider extends BaseProvider {
    abstract readonly id: string;
    abstract readonly name: string;
    abstract readonly enabled: boolean;
    abstract readonly BASE_URL: string;
    abstract readonly HEADERS: Record<string, string>;
    abstract readonly mirrors: EmbedMirror[];

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    protected getSources(media: ProviderMediaObject): ProviderResult {
        try {
            const sources = this.mirrors.flatMap((mirror, index) =>
                this.buildSources(mirror, media, index)
            );

            return {
                sources,
                subtitles: [],
                diagnostics: []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error
                    ? error.message
                    : 'Unknown provider error'
            );
        }
    }

    private buildSources(
        mirror: EmbedMirror,
        media: ProviderMediaObject,
        index: number
    ): Source[] {
        const embedUrl =
            media.type === 'movie'
                ? this.absoluteUrl(
                      mirror.baseUrl,
                      mirror.moviePath(media.tmdbId)
                  )
                : this.absoluteUrl(
                      mirror.baseUrl,
                      mirror.tvPath(
                          media.tmdbId,
                          this.requiredNumber(media.s, 'season'),
                          this.requiredNumber(media.e, 'episode')
                      )
                  );

        const sourceUrl = this.withValidationProbe(
            embedUrl,
            mirror.probeUrl ?? mirror.baseUrl
        );
        const mirrorHost = new URL(mirror.baseUrl).hostname;
        const provider = {
            id: index === 0 ? this.id : `${this.id}:${mirrorHost}`,
            name: index === 0 ? this.name : `${this.name} ${mirrorHost}`
        };
        const sources: Source[] = [];
        const headlessVidXPlayUrl = this.headlessVidXPlayUrl(embedUrl);

        if (headlessVidXPlayUrl) {
            sources.push({
                url: this.createProxyUrl(headlessVidXPlayUrl),
                type: 'hls',
                quality: 'Auto',
                audioTracks: [
                    {
                        language: 'eng',
                        label: 'English'
                    }
                ],
                provider: {
                    id: `${provider.id}:headlessvidx`,
                    name: `${provider.name} HeadlessVidX`
                }
            });
        }

        sources.push({
            url: sourceUrl,
            type: 'embed',
            quality: 'Embed',
            audioTracks: [
                {
                    language: 'eng',
                    label: 'English'
                }
            ],
            provider
        });

        return sources;
    }

    private withValidationProbe(embedUrl: string, probeUrl: string): string {
        const url = new URL(embedUrl);

        if (!url.searchParams.has('data')) {
            url.searchParams.set(
                'data',
                JSON.stringify({
                    url: probeUrl,
                    headers: this.HEADERS
                })
            );
        }

        return url.toString();
    }

    private headlessVidXPlayUrl(embedUrl: string): string | undefined {
        if (!envFlag('EMBED_HEADLESSVIDX_ENABLED', true)) {
            return undefined;
        }

        const baseUrl = envValue(
            'EMBED_HEADLESSVIDX_BASE_URL',
            'HEADLESSVIDX_BASE_URL'
        );
        if (!baseUrl) {
            return undefined;
        }

        const playUrl = new URL('/play', baseUrl);
        playUrl.searchParams.set('url', embedUrl);
        return playUrl.toString();
    }

    private absoluteUrl(baseUrl: string, path: string): string {
        return new URL(path, baseUrl).toString();
    }

    private requiredNumber(value: number | undefined, field: string): number {
        if (!value) {
            throw new Error(`Missing ${field}`);
        }

        return value;
    }

    protected emptyResult(message: string): ProviderResult {
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
            const response = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

export class SuperEmbedProvider extends EmbedMirrorProvider {
    readonly id = 'superembed';
    readonly name = 'SuperEmbed';
    readonly enabled = true;
    readonly BASE_URL = 'https://www.superembed.stream';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

    readonly mirrors: EmbedMirror[] = [
        {
            baseUrl: 'https://multiembed.mov',
            moviePath: (tmdbId) => `/?video_id=${tmdbId}&tmdb=1`,
            tvPath: (tmdbId, season, episode) =>
                `/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`,
            probeUrl: this.BASE_URL
        },
        {
            baseUrl: 'https://multiembed.mov',
            moviePath: (tmdbId) =>
                `/directstream.php?video_id=${tmdbId}&tmdb=1`,
            tvPath: (tmdbId, season, episode) =>
                `/directstream.php?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`,
            probeUrl: this.BASE_URL
        }
    ];
}

export class TwoEmbedProvider extends EmbedMirrorProvider {
    readonly id = '2embed';
    readonly name = '2Embed';
    readonly enabled = true;
    readonly BASE_URL = 'https://www.2embed.cc';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

    readonly mirrors: EmbedMirror[] = [
        {
            baseUrl: 'https://www.2embed.cc',
            moviePath: (tmdbId) => `/embed/movie/${tmdbId}`,
            tvPath: (tmdbId, season, episode) =>
                `/embed/tv/${tmdbId}/${season}/${episode}`,
            probeUrl: 'https://hnembed.cc/embed/movie/550'
        },
        {
            baseUrl: 'https://www.2embedstream.xyz',
            moviePath: (tmdbId) => `/embed/movie/${tmdbId}`,
            tvPath: (tmdbId, season, episode) =>
                `/embed/tv/${tmdbId}/${season}/${episode}`,
            probeUrl: 'https://hnembed.cc/embed/movie/550'
        },
        {
            baseUrl: 'https://2embed.to',
            moviePath: (tmdbId) => `/embed/tmdb/movie?id=${tmdbId}`,
            tvPath: (tmdbId, season, episode) =>
                `/embed/tmdb/tv?id=${tmdbId}&s=${season}&e=${episode}`,
            probeUrl: 'https://hnembed.cc/embed/movie/550'
        },
        {
            baseUrl: 'https://2embed.ru',
            moviePath: (tmdbId) => `/embed/movie/${tmdbId}`,
            tvPath: (tmdbId, season, episode) =>
                `/embed/tv/${tmdbId}/${season}/${episode}`,
            probeUrl: 'https://hnembed.cc/embed/movie/550'
        },
        {
            baseUrl: 'https://2embed.org',
            moviePath: (tmdbId) => `/embed/movie/${tmdbId}`,
            tvPath: (tmdbId, season, episode) =>
                `/embed/tv/${tmdbId}/${season}/${episode}`,
            probeUrl: 'https://hnembed.cc/embed/movie/550'
        }
    ];
}

export class MoviesApiProvider extends EmbedMirrorProvider {
    readonly id = 'moviesapi';
    readonly name = 'MoviesAPI';
    readonly enabled = true;
    readonly BASE_URL = 'https://moviesapi.to';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

    readonly mirrors: EmbedMirror[] = [
        {
            baseUrl: 'https://moviesapi.to',
            moviePath: (tmdbId) => `/movie/${tmdbId}`,
            tvPath: (tmdbId, season, episode) =>
                `/tv/${tmdbId}-${season}-${episode}`
        },
        {
            baseUrl: 'https://vidbinge.to',
            moviePath: (tmdbId) => `/movie/${tmdbId}`,
            tvPath: (tmdbId, season, episode) =>
                `/tv/${tmdbId}/${season}/${episode}`,
            probeUrl: 'https://moviesapi.to'
        }
    ];
}

export class VidPlusProvider extends EmbedMirrorProvider {
    readonly id = 'vidplus';
    readonly name = 'VidPlus';
    readonly enabled = true;
    readonly BASE_URL = 'https://vidplus.to';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

    readonly mirrors: EmbedMirror[] = [
        {
            baseUrl: 'https://player.vidplus.to',
            moviePath: (tmdbId) => `/embed/movie/${tmdbId}`,
            tvPath: (tmdbId, season, episode) =>
                `/embed/tv/${tmdbId}/${season}/${episode}`,
            probeUrl: 'https://moviesapi.to'
        }
    ];
}
