import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';

type LordFlixBridgeResponse = {
    status?: number;
    result?: {
        url?: string;
        sign?: string;
    };
};

type LordFlixDecodedResponse = {
    status?: number;
    result?: {
        error?: unknown;
        stream?: Array<{
            type?: string;
            playlist?: string;
            captions?: Array<{
                url?: string;
                language?: string;
                type?: string;
            }>;
        }>;
    };
};

export class LordFlixProvider extends BaseProvider {
    readonly id = 'lordflix';
    readonly name = 'LordFlix';
    readonly enabled = true;
    readonly BASE_URL = 'https://lordflix.org';
    readonly API_URL = 'https://snowhouse.lordflix.club';
    readonly CRYPTO_URL = 'https://enc-dec.app/api';
    readonly HEADERS = {
        Accept: '*/*',
        Origin: this.BASE_URL,
        Referer: `${this.BASE_URL}/`,
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36'
    };

    private readonly REQUEST_TIMEOUT_MS = 7000;

    private readonly SERVERS = ['Berlin', 'Marseille', 'Phoenix', 'Oslo'];

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        if (!media.imdbId) {
            return this.emptyResult('Missing IMDb ID');
        }

        const results = await Promise.allSettled(
            this.SERVERS.map((server) => this.fetchServer(server, media))
        );

        const sources: Source[] = [];
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
            return this.emptyResult('No LordFlix servers returned sources');
        }

        return {
            sources,
            subtitles: [...subtitlesByUrl.values()],
            diagnostics:
                failed > 0
                    ? [
                          {
                              code: 'PARTIAL_SCRAPE',
                              message: `${failed} of ${this.SERVERS.length} LordFlix servers failed`,
                              field: '',
                              severity: 'warning'
                          }
                      ]
                    : []
        };
    }

    private async fetchServer(
        server: string,
        media: ProviderMediaObject
    ): Promise<{ source: Source; subtitles: Subtitle[] } | null> {
        const signed = await this.getSignedUrl(server, media);
        if (!signed.url || !signed.sign) {
            return null;
        }

        const encryptedResponse = await this.fetchWithTimeout(signed.url, {
            headers: this.HEADERS
        });

        if (!encryptedResponse.ok) {
            return null;
        }

        const encryptedText = await encryptedResponse.text();
        const decoded = await this.decodeResponse(encryptedText, signed.sign);
        const stream = decoded.result?.stream?.find(
            (item) => item.type === 'hls' && item.playlist
        );

        if (!stream?.playlist) {
            return null;
        }

        return {
            source: {
                url: this.createProxyUrl(stream.playlist, this.HEADERS),
                type: 'hls',
                quality: 'Auto',
                audioTracks: [
                    {
                        language: 'eng',
                        label: 'English'
                    }
                ],
                provider: {
                    id: `${this.id}:${server.toLowerCase()}`,
                    name: `${this.name} ${server}`
                }
            },
            subtitles: (stream.captions ?? [])
                .filter((caption) => Boolean(caption.url))
                .map((caption) => ({
                    url: this.createProxyUrl(caption.url!, this.HEADERS),
                    label: caption.language ?? `${server} subtitle`,
                    format: this.inferSubtitleFormat(caption.type, caption.url!)
                }))
        };
    }

    private async getSignedUrl(
        server: string,
        media: ProviderMediaObject
    ): Promise<NonNullable<LordFlixBridgeResponse['result']>> {
        const url = this.buildServerUrl(server, media);
        const response = await this.fetchWithTimeout(
            `${this.CRYPTO_URL}/enc-lordflix?url=${this.encodeQuote(url)}`,
            { headers: this.HEADERS }
        );

        if (!response.ok) {
            return {};
        }

        const data = (await response.json()) as LordFlixBridgeResponse;
        return data.status === 200 ? (data.result ?? {}) : {};
    }

    private async decodeResponse(
        text: string,
        sign: string
    ): Promise<LordFlixDecodedResponse> {
        const response = await this.fetchWithTimeout(
            `${this.CRYPTO_URL}/dec-lordflix`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({ text, sign })
            }
        );

        if (!response.ok) {
            return {};
        }

        return (await response.json()) as LordFlixDecodedResponse;
    }

    private async fetchWithTimeout(
        input: string,
        init: RequestInit = {}
    ): Promise<Response> {
        return fetch(input, {
            ...init,
            signal: AbortSignal.timeout(this.REQUEST_TIMEOUT_MS)
        });
    }

    private buildServerUrl(server: string, media: ProviderMediaObject): string {
        const params = new URLSearchParams({
            title: media.title,
            type: media.type === 'tv' ? 'series' : 'movie',
            year: media.releaseYear ?? '',
            imdb: media.imdbId,
            tmdb: media.tmdbId,
            server
        });

        if (media.type === 'tv') {
            if (!media.s || !media.e) {
                throw new Error('Missing season or episode');
            }

            params.set('season', String(media.s));
            params.set('episode', String(media.e));
        }

        return `${this.API_URL}/?${params.toString()}`;
    }

    private encodeQuote(value: string): string {
        return encodeURIComponent(value)
            .replace(/%20/g, '+')
            .replace(/\+/g, '%20');
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
