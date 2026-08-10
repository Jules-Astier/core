import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import type { VixSrcApiResponse } from './vixsrc.types.js';

const DEFAULT_BASE_URL = 'https://vixsrc.to';

type VixSrcDependencies = {
    readonly fetch?: typeof fetch;
    readonly baseUrl?: string;
    readonly now?: () => number;
};

type MasterPlaylistData = {
    token: string;
    expires: string;
    playlist: string;
};

type ManifestTrack = {
    language: string;
    label: string;
};

type VixSrcRequestPhase = 'API' | 'embed' | 'playlist';

class VixSrcHttpError extends Error {
    constructor(
        readonly phase: VixSrcRequestPhase,
        readonly status: number
    ) {
        super(`VixSrc ${phase} request failed with status ${status}`);
    }
}

export class VixSrcProvider extends BaseProvider {
    readonly id = 'vixsrc';
    readonly name = 'VixSrc';
    readonly enabled = process.env.VIXSRC_ENABLED === 'true';
    readonly BASE_URL: string;
    readonly HEADERS: Record<string, string>;

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;

    constructor(dependencies: VixSrcDependencies = {}) {
        super();
        this.BASE_URL = this.normalizeBaseUrl(
            dependencies.baseUrl ??
                process.env.VIXSRC_BASE_URL ??
                DEFAULT_BASE_URL
        );
        this.HEADERS = {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${this.BASE_URL}/`,
            Origin: this.BASE_URL
        };
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.now = dependencies.now ?? Date.now;
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
            const apiUrl = this.buildApiUrl(media);
            const embedPath = await this.fetchEmbedPath(apiUrl);
            if (!embedPath) {
                return this.emptyResult('media was not found');
            }

            const embedUrl = this.resolveEmbedUrl(embedPath);
            const html = await this.fetchText(
                embedUrl,
                {
                    ...this.HEADERS,
                    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
                    Referer: apiUrl
                },
                'embed'
            );
            const masterData = this.extractMasterPlaylistData(html);
            if (!masterData || this.isTokenExpired(masterData.expires)) {
                return this.emptyResult(
                    'embed response did not contain a current playlist'
                );
            }

            const masterUrl = this.buildMasterUrl(masterData);
            const playlistHeaders = {
                ...this.HEADERS,
                Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
                Referer: embedUrl
            };
            const manifest = await this.fetchText(
                masterUrl,
                playlistHeaders,
                'playlist'
            );

            return this.parseManifest(manifest, masterUrl, playlistHeaders);
        } catch (error) {
            if (
                error instanceof VixSrcHttpError &&
                [401, 403, 429].includes(error.status)
            ) {
                return this.emptyResult(
                    `${error.phase} request was blocked (${error.status}); ` +
                        'configure VIXSRC_BASE_URL or approved egress'
                );
            }
            return this.emptyResult('upstream response was unavailable');
        }
    }

    private buildApiUrl(media: ProviderMediaObject): string {
        if (media.type === 'movie') {
            return `${this.BASE_URL}/api/movie/${encodeURIComponent(media.tmdbId)}`;
        }

        if (!Number.isInteger(media.s) || !Number.isInteger(media.e)) {
            throw new TypeError('TV media requires a season and episode');
        }

        return `${this.BASE_URL}/api/tv/${encodeURIComponent(media.tmdbId)}/${media.s}/${media.e}`;
    }

    private async fetchEmbedPath(url: string): Promise<string | null> {
        const response = await this.fetchImpl(url, { headers: this.HEADERS });
        if (response.status === 404) return null;
        if (!response.ok) throw new VixSrcHttpError('API', response.status);

        const data = (await response.json()) as Partial<VixSrcApiResponse>;
        return typeof data.src === 'string' && data.src.trim()
            ? data.src
            : null;
    }

    private async fetchText(
        url: string,
        headers: Record<string, string>,
        phase: Exclude<VixSrcRequestPhase, 'API'>
    ): Promise<string> {
        const response = await this.fetchImpl(url, { headers });
        if (!response.ok) throw new VixSrcHttpError(phase, response.status);
        return response.text();
    }

    private resolveEmbedUrl(value: string): string {
        const url = new URL(value, `${this.BASE_URL}/`);
        const base = new URL(this.BASE_URL);
        if (url.origin !== base.origin || !url.pathname.startsWith('/embed/')) {
            throw new TypeError('VixSrc returned an invalid embed URL');
        }
        return url.toString();
    }

    private extractMasterPlaylistData(html: string): MasterPlaylistData | null {
        const block = html.match(
            /window\.masterPlaylist\s*=\s*\{([\s\S]*?)\}\s*;?\s*window\.canPlayFHD/
        )?.[1];
        if (!block) return null;

        const token = block.match(/['"]token['"]\s*:\s*['"]([^'"]+)/)?.[1];
        const expires = block.match(/['"]expires['"]\s*:\s*['"]([^'"]+)/)?.[1];
        const playlist = block.match(/\burl\s*:\s*['"]([^'"]+)/)?.[1];

        return token && expires && playlist
            ? { token, expires, playlist }
            : null;
    }

    private isTokenExpired(expires: string): boolean {
        const expiresAt = Number.parseInt(expires, 10) * 1000;
        return !Number.isFinite(expiresAt) || expiresAt - 60_000 < this.now();
    }

    private buildMasterUrl(data: MasterPlaylistData): string {
        const url = new URL(data.playlist, `${this.BASE_URL}/`);
        if (!this.isAllowedMediaOrigin(url)) {
            throw new TypeError('VixSrc returned an untrusted playlist URL');
        }
        url.searchParams.set('token', data.token);
        url.searchParams.set('expires', data.expires);
        url.searchParams.set('h', '1');
        return url.toString();
    }

    private isAllowedMediaOrigin(url: URL): boolean {
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
        const base = new URL(this.BASE_URL);
        return (
            url.origin === base.origin ||
            url.hostname.endsWith('.vix-content.net')
        );
    }

    private parseManifest(
        content: string,
        masterUrl: string,
        headers: Record<string, string>
    ): ProviderResult {
        if (!content.trimStart().startsWith('#EXTM3U')) {
            return this.emptyResult('playlist response was malformed');
        }

        const variants = this.parseVariants(content);
        if (variants.length === 0) {
            return this.emptyResult('playlist contained no video variants');
        }

        const bestResolution = Math.max(
            ...variants.map(({ resolution }) => resolution)
        );
        const audioTracks = this.parseAudioTracks(content);
        const sources: Source[] = [
            {
                url: this.createProxyUrl(masterUrl, headers),
                type: 'hls',
                quality: `${bestResolution}p`,
                audioTracks:
                    audioTracks.length > 0
                        ? audioTracks
                        : [{ language: 'und', label: 'Default' }],
                provider: {
                    id: this.id,
                    name: this.name
                }
            }
        ];

        return {
            sources,
            subtitles: this.parseSubtitles(content, masterUrl, headers),
            diagnostics: []
        };
    }

    private parseAudioTracks(content: string): ManifestTrack[] {
        return this.mediaLines(content, 'AUDIO').map((line) => ({
            language: this.attribute(line, 'LANGUAGE') ?? 'und',
            label: this.attribute(line, 'NAME') ?? 'Audio'
        }));
    }

    private parseSubtitles(
        content: string,
        masterUrl: string,
        headers: Record<string, string>
    ): Subtitle[] {
        const seen = new Set<string>();
        const subtitles: Subtitle[] = [];

        for (const line of this.mediaLines(content, 'SUBTITLES')) {
            const uri = this.attribute(line, 'URI');
            if (!uri) continue;
            const url = new URL(uri, masterUrl);
            if (!this.isAllowedMediaOrigin(url) || seen.has(url.href)) continue;
            seen.add(url.href);
            subtitles.push({
                url: this.createProxyUrl(url.href, headers),
                label: this.attribute(line, 'NAME') ?? 'Unknown',
                format: 'vtt'
            });
        }

        return subtitles;
    }

    private mediaLines(content: string, type: string): string[] {
        return content
            .split(/\r?\n/)
            .filter((line) => line.startsWith(`#EXT-X-MEDIA:TYPE=${type}`));
    }

    private attribute(line: string, name: string): string | undefined {
        return line.match(new RegExp(`(?:^|,)${name}="([^"]*)"`))?.[1];
    }

    private parseVariants(
        content: string
    ): Array<{ resolution: number; url: string }> {
        const variants: Array<{ resolution: number; url: string }> = [];
        const lines = content.split(/\r?\n/);

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
            const resolution = Number.parseInt(
                line.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? '',
                10
            );
            const url = lines[index + 1]?.trim();
            if (Number.isFinite(resolution) && url && !url.startsWith('#')) {
                variants.push({ resolution, url });
            }
        }

        return variants;
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

    private normalizeBaseUrl(value: string): string {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new TypeError('VIXSRC_BASE_URL must use HTTP or HTTPS');
        }
        url.pathname = '';
        url.search = '';
        url.hash = '';
        return url.href.replace(/\/$/, '');
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
