import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import { decryptVidZeeStream, type VidZeeDecodedStream } from './decrypt.js';
import type {
    VidZeeEncryptedResponse,
    VidZeeSubtitle
} from './vidzee.types.js';

const SERVERS = ['ipcloud', 'dcloud', 'tik'] as const;

export type VidZeeDependencies = {
    fetch?: typeof fetch;
    decrypt?: (
        encoded: string,
        hostname?: string
    ) => Promise<VidZeeDecodedStream | null>;
};

export class VidZeeProvider extends BaseProvider {
    readonly id = 'vidzee';
    readonly name = 'VidZee';
    readonly enabled = true;
    readonly BASE_URL = 'https://core.vidzee.wtf';
    readonly PLAYER_URL = 'https://player.vidzee.wtf';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${this.PLAYER_URL}/`,
        Origin: this.PLAYER_URL
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    private readonly fetchImpl: typeof fetch;
    private readonly decryptImpl: NonNullable<VidZeeDependencies['decrypt']>;

    constructor(dependencies: VidZeeDependencies = {}) {
        super();
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.decryptImpl = dependencies.decrypt ?? decryptVidZeeStream;
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
        const settled = await Promise.allSettled(
            SERVERS.map((server) => this.resolveServer(media, server))
        );
        const sources: Source[] = [];
        let failures = 0;
        for (const result of settled) {
            if (result.status !== 'fulfilled' || !result.value) {
                failures += 1;
                continue;
            }
            const decoded = result.value;
            const headers = safeHeaders(decoded.headers);
            sources.push({
                url: this.createProxyUrl(decoded.url, headers),
                type: decoded.url.toLowerCase().includes('.mp4')
                    ? 'mp4'
                    : 'hls',
                quality: 'Auto',
                audioTracks: [audioTrack(decoded.language)],
                provider: { id: this.id, name: this.name }
            });
        }

        const unique = [
            ...new Map(sources.map((source) => [source.url, source])).values()
        ];
        const subtitles = await this.fetchSubtitles(media);
        const diagnostics: ProviderResult['diagnostics'] = [];
        if (failures > 0 && unique.length > 0) {
            diagnostics.push({
                code: 'PARTIAL_SCRAPE',
                message: `${this.name}: ${failures}/${SERVERS.length} stream servers were unavailable`,
                field: '',
                severity: 'warning'
            });
        }
        if (unique.length === 0) {
            diagnostics.push({
                code: 'PROVIDER_ERROR',
                message: `${this.name}: no working stream servers`,
                field: '',
                severity: 'error'
            });
        }
        return { sources: unique, subtitles, diagnostics };
    }

    private async resolveServer(
        media: ProviderMediaObject,
        server: (typeof SERVERS)[number]
    ): Promise<VidZeeDecodedStream | null> {
        const response = await this.fetchImpl(this.streamUrl(media, server), {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(8_000)
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as VidZeeEncryptedResponse;
        if (typeof payload.url === 'string') {
            return {
                url: payload.url,
                language: payload.language,
                headers: payload.headers
            };
        }
        return typeof payload.c === 'string'
            ? this.decryptImpl(payload.c, new URL(this.PLAYER_URL).hostname)
            : null;
    }

    private streamUrl(
        media: ProviderMediaObject,
        server: (typeof SERVERS)[number]
    ): string {
        const path =
            media.type === 'movie'
                ? `/streams/movie/${encodeURIComponent(media.tmdbId)}`
                : `/streams/tv/${encodeURIComponent(media.tmdbId)}/${media.s}/${media.e}`;
        return `${this.BASE_URL}${path}?${new URLSearchParams({
            s: server,
            e: '1'
        })}`;
    }

    private async fetchSubtitles(
        media: ProviderMediaObject
    ): Promise<Subtitle[]> {
        const path =
            media.type === 'movie'
                ? `/subs/movie/${encodeURIComponent(media.tmdbId)}`
                : `/subs/tv/${encodeURIComponent(media.tmdbId)}/${media.s}/${media.e}`;
        try {
            const response = await this.fetchImpl(`${this.BASE_URL}${path}`, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(8_000)
            });
            if (!response.ok) return [];
            const entries = (await response.json()) as VidZeeSubtitle[];
            if (!Array.isArray(entries)) return [];
            return entries
                .filter(
                    (entry) =>
                        typeof entry.file === 'string' &&
                        entry.file.startsWith('https://')
                )
                .map((entry) => ({
                    url: this.createProxyUrl(entry.file!, this.HEADERS),
                    label: entry.label?.trim() || 'Unknown',
                    format: subtitleFormat(entry.file!)
                }));
        } catch {
            return [];
        }
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(this.PLAYER_URL, {
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

function safeHeaders(value: Record<string, string> | undefined) {
    const allowed = new Set([
        'accept',
        'accept-language',
        'origin',
        'referer',
        'user-agent'
    ]);
    return Object.fromEntries(
        Object.entries(value ?? {}).filter(
            ([name, entry]) =>
                allowed.has(name.toLowerCase()) && typeof entry === 'string'
        )
    );
}

function audioTrack(language: string | undefined) {
    const value = language?.trim() || 'Auto';
    const normalized = value.toLowerCase();
    const codes: Record<string, string> = {
        auto: 'und',
        english: 'eng',
        hindi: 'hin',
        vietnamese: 'vie'
    };
    return {
        language: codes[normalized] ?? normalized.slice(0, 3),
        label: value
    };
}

function subtitleFormat(url: string): 'vtt' | 'srt' | 'ass' {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.srt')) return 'srt';
    if (pathname.endsWith('.ass') || pathname.endsWith('.ssa')) return 'ass';
    return 'vtt';
}
