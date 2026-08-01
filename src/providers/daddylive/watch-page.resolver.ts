export type ResolvedWatchSource = {
    url: string;
    type: 'hls';
    quality?: string;
    headers?: Record<string, string>;
    audioTracks?: Array<{
        label: string;
        language: string;
    }>;
};

type ResolverOptions = {
    baseUrl: string;
    cacheTtlSeconds: number;
};

type ResolverCacheEntry = {
    expiresAt: number;
    sources: ResolvedWatchSource[];
};

const DEFAULT_HEADLESSVIDX_BASE_URL = 'http://headlessvidx:3202';

export class WatchPageSourceResolver {
    private readonly baseUrl: string;
    private readonly cacheTtlSeconds: number;
    private readonly cache = new Map<string, ResolverCacheEntry>();

    constructor(options: Partial<ResolverOptions> = {}) {
        this.baseUrl = options.baseUrl ?? DEFAULT_HEADLESSVIDX_BASE_URL;
        this.cacheTtlSeconds = options.cacheTtlSeconds ?? 30;
    }

    async resolveWatchPage(href: string): Promise<ResolvedWatchSource[]> {
        const watchUrl = this.normalizeUrl(href);
        const cached = this.cache.get(watchUrl);
        const now = Date.now();
        if (cached && cached.expiresAt > now) {
            return cached.sources;
        }

        const sources = [
            {
                url: this.playUrl(watchUrl),
                type: 'hls' as const
            }
        ];

        this.cache.set(watchUrl, {
            sources,
            expiresAt: now + this.cacheTtlSeconds * 1000
        });

        return sources;
    }

    private playUrl(watchUrl: string): string {
        const endpoint = new URL('/play', this.baseUrl);
        endpoint.searchParams.set('url', watchUrl);
        return endpoint.toString();
    }

    private normalizeUrl(value: string): string {
        try {
            const url = new URL(value);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                throw new Error('Watch URL must be http or https');
            }
            return url.toString();
        } catch (error) {
            throw new Error(
                `Invalid watch URL: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }
}
