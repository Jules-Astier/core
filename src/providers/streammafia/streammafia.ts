import type {
    AudioTrack,
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType
} from '@omss/framework';
import { BaseProvider } from '@omss/framework';
import type { ApiResponse, EncryptedPayload } from './streammafia.types.js';
import { decryptStreamMafia } from './decrypt.js';
import { generateRandomUserAgent } from '../../utils/ua.js';

type TokenResponse = { token?: string; secureId?: string };

export type StreamMafiaDependencies = {
    fetch?: typeof fetch;
    decrypt?: (payload: EncryptedPayload) => ApiResponse;
    ipv4?: () => Promise<string>;
};

function envFlag(name: string, fallback: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === undefined) return fallback;
    return ['true', '1', 'yes', 'on'].includes(value);
}

export class StreamMafiaProvider extends BaseProvider {
    readonly id = 'streammafia';
    readonly name = 'MafiaEmbed';
    readonly enabled = envFlag('STREAMMAFIA_ENABLED', false);
    readonly BASE_URL = 'https://player.nhdapi.com';
    readonly HEADERS = {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    private readonly fetchImpl: typeof fetch;
    private readonly decryptImpl: NonNullable<
        StreamMafiaDependencies['decrypt']
    >;
    private readonly ipv4Impl?: StreamMafiaDependencies['ipv4'];

    constructor(dependencies: StreamMafiaDependencies = {}) {
        super();
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.decryptImpl = dependencies.decrypt ?? decryptStreamMafia;
        this.ipv4Impl = dependencies.ipv4;
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
            const ipv4 = await this.getClientIpv4();
            if (!ipv4)
                return this.emptyResult('Unable to determine client IPv4');
            const userAgent = generateRandomUserAgent();
            const token = await this.createToken(media.tmdbId, ipv4, userAgent);
            if (!token)
                return this.emptyResult('Failed to retrieve access token');

            const response = await this.fetchImpl(
                this.streamUrl(media, token.secureId),
                {
                    headers: {
                        ...this.HEADERS,
                        'User-Agent': userAgent,
                        'X-API-Token': token.token,
                        'X-Client-IPv4': ipv4
                    },
                    signal: AbortSignal.timeout(10_000)
                }
            );
            if (!response.ok) return this.emptyResult('Invalid API response');
            const encrypted = (await response.json()) as EncryptedPayload;
            const api = this.decryptImpl(encrypted);
            return this.mapApiResponse(api, userAgent);
        } catch {
            return this.emptyResult('Upstream response was unavailable');
        }
    }

    private async getClientIpv4(): Promise<string> {
        if (this.ipv4Impl) return this.ipv4Impl();
        try {
            const response = await this.fetchImpl(
                'https://api.ipify.org/?format=json',
                { signal: AbortSignal.timeout(5_000) }
            );
            if (!response.ok) return '';
            const data = (await response.json()) as { ip?: unknown };
            return typeof data.ip === 'string' &&
                /^\d{1,3}(?:\.\d{1,3}){3}$/.test(data.ip)
                ? data.ip
                : '';
        } catch {
            return '';
        }
    }

    private async createToken(
        contentId: string,
        ipv4: string,
        userAgent: string
    ): Promise<{ token: string; secureId: string } | null> {
        const response = await this.fetchImpl(`${this.BASE_URL}/api/token`, {
            method: 'POST',
            headers: {
                ...this.HEADERS,
                'User-Agent': userAgent,
                'Content-Type': 'application/json',
                'X-Content-Id': contentId
            },
            body: JSON.stringify({ ipv4 }),
            signal: AbortSignal.timeout(8_000)
        });
        if (!response.ok) return null;
        const data = (await response.json()) as TokenResponse;
        return typeof data.token === 'string' &&
            data.token.length > 0 &&
            typeof data.secureId === 'string' &&
            data.secureId.length > 0
            ? { token: data.token, secureId: data.secureId }
            : null;
    }

    private streamUrl(media: ProviderMediaObject, secureId: string): string {
        const path = media.type === 'movie' ? '/api/movie' : '/api/tv';
        const params: Record<string, string> = { id: secureId };
        if (media.type === 'tv') {
            params.season = String(media.s);
            params.episode = String(media.e);
        }
        return `${this.BASE_URL}${path}?${new URLSearchParams(params)}`;
    }

    private async mapApiResponse(
        api: ApiResponse,
        userAgent: string
    ): Promise<ProviderResult> {
        const sources: Source[] = [];
        const fallbackAudio = this.extractAudioTrack(api.selected);
        if (api.stream?.hls_streaming) {
            const parsed = await this.parseHLS(
                api.stream.hls_streaming,
                userAgent
            );
            sources.push({
                url: this.createProxyUrl(api.stream.hls_streaming, {
                    'User-Agent': userAgent,
                    Referer: `${this.BASE_URL}/`,
                    Origin: this.BASE_URL
                }),
                type: 'hls',
                quality: parsed.quality,
                audioTracks:
                    parsed.audioTracks.length > 0
                        ? parsed.audioTracks
                        : [fallbackAudio],
                provider: { id: this.id, name: this.name }
            });
        }
        for (const download of api.stream?.download ?? []) {
            if (!download.url) continue;
            sources.push({
                url: this.createProxyUrl(download.url, {
                    'User-Agent': userAgent,
                    Referer: `${this.BASE_URL}/`,
                    Origin: this.BASE_URL
                }),
                type: this.inferSourceType(download.url),
                quality: this.normalizeQuality(download.quality),
                audioTracks: [fallbackAudio],
                provider: { id: this.id, name: this.name }
            });
        }
        const unique = [
            ...new Map(sources.map((source) => [source.url, source])).values()
        ];
        return unique.length > 0
            ? { sources: unique, subtitles: [], diagnostics: [] }
            : this.emptyResult('No playable sources found');
    }

    private extractAudioTrack(selected: ApiResponse['selected']): AudioTrack {
        return {
            language:
                selected?.lang_code?.trim().toLowerCase() ||
                selected?.lang?.trim().toLowerCase() ||
                'und',
            label:
                selected?.lang?.trim() ||
                selected?.lang_code?.toUpperCase() ||
                'Original'
        };
    }

    private async parseHLS(
        url: string,
        userAgent: string
    ): Promise<{ quality: string; audioTracks: AudioTrack[] }> {
        try {
            const response = await this.fetchImpl(url, {
                headers: {
                    ...this.HEADERS,
                    'User-Agent': userAgent
                },
                signal: AbortSignal.timeout(8_000)
            });
            if (!response.ok) return { quality: 'Auto', audioTracks: [] };
            const content = await response.text();
            const heights = [...content.matchAll(/RESOLUTION=\d+x(\d+)/g)].map(
                (match) => Number.parseInt(match[1], 10)
            );
            const audioTracks = content
                .split('\n')
                .filter((line) => line.includes('TYPE=AUDIO'))
                .map((line) => ({
                    language:
                        line.match(/LANGUAGE="([^"]+)"/)?.[1]?.toLowerCase() ??
                        'und',
                    label: line.match(/NAME="([^"]+)"/)?.[1] ?? 'Original'
                }));
            return {
                quality:
                    heights.length > 0 ? String(Math.max(...heights)) : 'Auto',
                audioTracks
            };
        } catch {
            return { quality: 'Auto', audioTracks: [] };
        }
    }

    private inferSourceType(url: string): SourceType {
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname.endsWith('.mp4')) return 'mp4';
        return 'hls';
    }

    private normalizeQuality(value?: string): string {
        return value?.match(/2160|1080|720|480|360|240/)?.[0] ?? 'Auto';
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
            const response = await this.fetchImpl(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS,
                signal: AbortSignal.timeout(5_000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
