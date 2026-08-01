import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    SourceType,
    SubtitleFormat
} from '@omss/framework';

type VidLinkEncryptResponse = {
    status?: number;
    result?: string;
};

type VidLinkCaption = {
    url?: string;
    language?: string;
    type?: string;
};

type VidLinkStreamResponse = {
    sourceId?: string;
    stream?: {
        type?: string;
        playlist?: string;
        captions?: VidLinkCaption[];
    };
};

export class VidLinkProvider extends BaseProvider {
    readonly id = 'vidlink';
    readonly name = 'VidLink';
    readonly enabled = true;
    readonly BASE_URL = 'https://vidlink.pro';
    readonly API_URL = `${this.BASE_URL}/api/b`;
    readonly ENCRYPT_URL = 'https://enc-dec.app/api/enc-vidlink';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

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
        try {
            const encodedTmdbId = await this.encryptTmdbId(media.tmdbId);
            const url = this.buildApiUrl(media, encodedTmdbId);
            const response = await fetch(url, { headers: this.HEADERS });

            if (!response.ok) {
                throw new Error(`API request failed with ${response.status}`);
            }

            const data = (await response.json()) as VidLinkStreamResponse;
            const playlist = data.stream?.playlist;

            if (!playlist) {
                throw new Error('No playlist returned');
            }

            return {
                sources: [
                    {
                        url: this.createProxyUrl(playlist, this.HEADERS),
                        type: this.inferSourceType(data.stream?.type, playlist),
                        quality: 'Auto',
                        audioTracks: [
                            {
                                language: 'eng',
                                label: 'English'
                            }
                        ],
                        provider: {
                            id: this.id,
                            name: this.name
                        }
                    }
                ],
                subtitles: (data.stream?.captions ?? [])
                    .filter((caption) => Boolean(caption.url))
                    .map((caption) => ({
                        url: this.createProxyUrl(caption.url!, this.HEADERS),
                        label: caption.language ?? 'Unknown',
                        format: this.inferSubtitleFormat(
                            caption.type,
                            caption.url!
                        )
                    })),
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

    private async encryptTmdbId(tmdbId: string): Promise<string> {
        const url = `${this.ENCRYPT_URL}?text=${encodeURIComponent(tmdbId)}`;
        const response = await fetch(url, { headers: this.HEADERS });

        if (!response.ok) {
            throw new Error(
                `Encryption request failed with ${response.status}`
            );
        }

        const data = (await response.json()) as VidLinkEncryptResponse;
        if (!data.result) {
            throw new Error('Encryption response did not contain a result');
        }

        return data.result;
    }

    private buildApiUrl(
        media: ProviderMediaObject,
        encodedTmdbId: string
    ): string {
        if (media.type === 'movie') {
            return `${this.API_URL}/movie/${encodedTmdbId}?multiLang=0`;
        }

        if (!media.s || !media.e) {
            throw new Error('Missing season or episode');
        }

        return `${this.API_URL}/tv/${encodedTmdbId}/${media.s}/${media.e}?multiLang=0`;
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
        type: string | undefined,
        url: string
    ): SubtitleFormat {
        const value = `${type ?? ''} ${url}`.toLowerCase();
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
