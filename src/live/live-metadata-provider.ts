import { BaseProvider } from '@omss/framework';
import type {
    AudioTrack,
    LiveEventManifest,
    LiveProvider,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import { readFile } from 'node:fs/promises';
import {
    WatchPageSourceResolver,
    type ResolvedWatchSource
} from '../providers/daddylive/watch-page.resolver.js';
import { WatchPageLinkDiscovery } from '../providers/live/watch-page-link-discovery.js';

type AuthorizedSource = {
    url: string;
    type?: Source['type'];
    quality?: string;
    headers?: Record<string, string>;
    audioTracks?: AudioTrack[];
};

type AuthorizedSourceMap = Record<string, AuthorizedSource[]>;

const SOURCE_TYPES: Source['type'][] = [
    'hls',
    'dash',
    'http',
    'mp4',
    'mkv',
    'webm',
    'embed'
];

export function envValue(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value) {
            return value;
        }
    }
    return undefined;
}

export function envFlag(name: string, defaultValue: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === undefined) {
        return defaultValue;
    }
    return ['true', '1', 'yes', 'on'].includes(value);
}

export function envNumber(defaultValue: number, ...names: string[]): number {
    for (const name of names) {
        const value = Number(process.env[name]);
        if (Number.isFinite(value)) {
            return value;
        }
    }
    return defaultValue;
}

export function csv(value?: string): string[] {
    return (
        value
            ?.split(',')
            .map((entry) => entry.trim())
            .filter(Boolean) ?? []
    );
}

export function unique(values: Array<string | undefined>): string[] {
    return Array.from(
        new Set(values.filter((value): value is string => Boolean(value)))
    );
}

export abstract class LiveMetadataProvider
    extends BaseProvider
    implements LiveProvider
{
    protected abstract readonly envPrefix: string;
    protected abstract readonly defaultWatchPages: string[];

    private watchLinkDiscovery?: WatchPageLinkDiscovery;
    private watchSourceResolver?: WatchPageSourceResolver;

    async getMovieSources(
        _media: ProviderMediaObject
    ): Promise<ProviderResult> {
        return this.emptyResult(
            `${this.name} only supports live event discovery.`
        );
    }

    async getTVSources(_media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult(
            `${this.name} only supports live event discovery.`
        );
    }

    async getLiveEventSources(
        event: LiveEventManifest
    ): Promise<ProviderResult> {
        const sourceMap = await this.loadAuthorizedSourceMap();
        const keys = this.sourceMapKeys(event);
        const mappedSources = keys.flatMap((key) => sourceMap[key] ?? []);
        const resolvedSources = await this.resolveWatchSources(event);
        const sources = this.dedupeSources([
            ...mappedSources,
            ...resolvedSources
        ]);

        if (!sources.length) {
            return this.emptyResult(
                this.watchSourceResolutionEnabled()
                    ? `${this.name} discovered the event, but no matching watch-page links or authorized source mapping could be resolved.`
                    : `${this.name} discovered the event, but no authorized source mapping is configured.`
            );
        }

        return {
            sources: sources.map((source) => ({
                url: this.createProxyUrl(source.url, source.headers),
                type: this.normalizeSourceType(source.type, source.url),
                quality: source.quality ?? 'Auto',
                audioTracks: source.audioTracks ?? [
                    {
                        label: 'Original',
                        language: 'und'
                    }
                ],
                provider: {
                    id: this.id,
                    name: this.name
                }
            })),
            subtitles: [],
            diagnostics: []
        };
    }

    protected watchLookupPagesForCandidate(): string[] {
        return this.watchLookupPages();
    }

    protected parseDate(value?: string | null): string | undefined {
        if (!value) {
            return undefined;
        }

        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime())
            ? parsed.toISOString()
            : undefined;
    }

    protected endsAt(startsAt: string, durationMinutes: number): string {
        return new Date(
            new Date(startsAt).getTime() + durationMinutes * 60 * 1000
        ).toISOString();
    }

    protected cleanText(value?: string | null): string | undefined {
        const cleaned = value?.replace(/\s+/g, ' ').trim();
        return cleaned || undefined;
    }

    private async resolveWatchSources(
        event: LiveEventManifest
    ): Promise<ResolvedWatchSource[]> {
        if (!this.watchSourceResolutionEnabled()) {
            return [];
        }

        const lookupPages = this.watchLookupPages(event);
        if (!lookupPages.length) {
            return [];
        }

        const discovery = await this.getWatchLinkDiscovery().discover(
            event,
            lookupPages
        );
        for (const failure of discovery.failures) {
            this.console.warn(
                `${this.name} watch page failed for ${failure.pageUrl}: ${failure.error}`
            );
        }

        const resolver = this.getWatchSourceResolver();
        const results = await Promise.allSettled(
            discovery.links.map((href) => resolver.resolveWatchPage(href))
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                this.console.warn(
                    `${this.name} watch source resolution failed: ${
                        result.reason instanceof Error
                            ? result.reason.message
                            : String(result.reason)
                    }`
                );
            }
        }

        return this.dedupeSources(
            results.flatMap((result) =>
                result.status === 'fulfilled' ? result.value : []
            )
        );
    }

    private watchLookupPages(event?: LiveEventManifest): string[] {
        const providerPages = event
            ? event.providers
                  .filter((provider) => provider.providerId === this.id)
                  .flatMap((provider) => [
                      provider.href,
                      ...(provider.hrefs ?? [])
                  ])
            : [];
        const explicitPages = csv(envValue(`${this.envPrefix}_WATCH_PAGES`));

        return unique([
            ...providerPages,
            ...csv(
                envValue(
                    `${this.envPrefix}_COMMON_WATCH_PAGES`,
                    'LIVE_COMMON_WATCH_PAGES'
                )
            ),
            ...csv(envValue('WATCHPAGE_URL', 'DADDYLIVE_SCHEDULE_URL')),
            ...(explicitPages.length ? explicitPages : this.defaultWatchPages)
        ]);
    }

    private getWatchLinkDiscovery(): WatchPageLinkDiscovery {
        this.watchLinkDiscovery ??= new WatchPageLinkDiscovery({
            headers: {
                'User-Agent':
                    envValue(
                        `${this.envPrefix}_WATCH_USER_AGENT`,
                        'WATCHPAGE_USER_AGENT',
                        'LIVE_WATCH_USER_AGENT',
                        'DADDYLIVE_USER_AGENT'
                    ) ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
                Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
            },
            hrefPatterns: csv(
                envValue(
                    `${this.envPrefix}_WATCH_HREF_PATTERNS`,
                    'WATCHPAGE_HREF_PATTERNS'
                )
            ),
            rowSelector: envValue(
                `${this.envPrefix}_WATCH_EVENT_ROW_SELECTOR`,
                'WATCHPAGE_EVENT_ROW_SELECTOR'
            ),
            matchMinScore: envNumber(
                0.45,
                `${this.envPrefix}_WATCH_MATCH_MIN_SCORE`,
                'WATCHPAGE_MATCH_MIN_SCORE'
            ),
            timeWindowHours: envNumber(
                18,
                `${this.envPrefix}_WATCH_MATCH_TIME_WINDOW_HOURS`,
                'WATCHPAGE_MATCH_TIME_WINDOW_HOURS'
            ),
            cacheTtlSeconds: envNumber(
                60,
                `${this.envPrefix}_WATCH_PAGE_CACHE_TTL_SECONDS`,
                'WATCHPAGE_CACHE_TTL_SECONDS'
            ),
            renderWithPlaywright: envFlag(
                `${this.envPrefix}_WATCH_RENDER_WITH_PLAYWRIGHT`,
                envFlag('WATCHPAGE_RENDER_WITH_PLAYWRIGHT', false)
            ),
            playwrightPackage:
                envValue(
                    `${this.envPrefix}_WATCH_PLAYWRIGHT_PACKAGE`,
                    'WATCHPAGE_PLAYWRIGHT_PACKAGE'
                ) ?? 'playwright-core',
            browserExecutablePath: envValue(
                `${this.envPrefix}_WATCH_BROWSER_EXECUTABLE_PATH`,
                'WATCHPAGE_BROWSER_EXECUTABLE_PATH'
            ),
            playwrightTimeoutMs: envNumber(
                20_000,
                `${this.envPrefix}_WATCH_PLAYWRIGHT_TIMEOUT_MS`,
                'WATCHPAGE_PLAYWRIGHT_TIMEOUT_MS'
            )
        });

        return this.watchLinkDiscovery;
    }

    private getWatchSourceResolver(): WatchPageSourceResolver {
        this.watchSourceResolver ??= new WatchPageSourceResolver({
            baseUrl: envValue(
                `${this.envPrefix}_HEADLESSVIDX_BASE_URL`,
                'WATCHPAGE_HEADLESSVIDX_BASE_URL',
                'LIVE_WATCH_HEADLESSVIDX_BASE_URL',
                'DADDYLIVE_HEADLESSVIDX_BASE_URL'
            ),
            cacheTtlSeconds: envNumber(
                30,
                `${this.envPrefix}_WATCH_SOURCE_CACHE_TTL_SECONDS`,
                'WATCHPAGE_SOURCE_CACHE_TTL_SECONDS',
                'LIVE_WATCH_SOURCE_CACHE_TTL_SECONDS',
                'DADDYLIVE_SOURCE_CACHE_TTL_SECONDS'
            )
        });

        return this.watchSourceResolver;
    }

    private watchSourceResolutionEnabled(): boolean {
        return envFlag(
            `${this.envPrefix}_WATCH_SOURCE_RESOLUTION_ENABLED`,
            true
        );
    }

    private async loadAuthorizedSourceMap(): Promise<AuthorizedSourceMap> {
        const inline = envValue(
            `${this.envPrefix}_AUTHORIZED_SOURCE_MAP`,
            'LIVE_AUTHORIZED_SOURCE_MAP'
        );
        if (inline) {
            return JSON.parse(inline) as AuthorizedSourceMap;
        }

        const path = envValue(
            `${this.envPrefix}_AUTHORIZED_SOURCE_MAP_PATH`,
            'LIVE_AUTHORIZED_SOURCE_MAP_PATH'
        );
        if (!path) {
            return {};
        }

        return JSON.parse(await readFile(path, 'utf8')) as AuthorizedSourceMap;
    }

    private sourceMapKeys(event: LiveEventManifest): string[] {
        return [
            event.id,
            ...event.providers
                .filter((provider) => provider.providerId === this.id)
                .flatMap((provider) =>
                    [
                        provider.internalEventId,
                        provider.href,
                        ...(provider.hrefs ?? [])
                    ].filter((value): value is string => Boolean(value))
                )
        ];
    }

    private normalizeSourceType(
        type: Source['type'] | undefined,
        url: string
    ): Source['type'] {
        if (type && SOURCE_TYPES.includes(type)) {
            return type;
        }

        const pathname = this.safePathname(url).toLowerCase();
        if (pathname.endsWith('.m3u8')) return 'hls';
        if (pathname.endsWith('.mpd')) return 'dash';
        if (pathname.endsWith('.mp4')) return 'mp4';
        if (pathname.endsWith('.mkv')) return 'mkv';
        if (pathname.endsWith('.webm')) return 'webm';
        return 'hls';
    }

    private safePathname(url: string): string {
        try {
            return new URL(url).pathname;
        } catch {
            return url;
        }
    }

    private dedupeSources<T extends { url: string }>(sources: T[]): T[] {
        const byUrl = new Map<string, T>();
        for (const source of sources) {
            const key = this.sourceDedupeKey(source.url);
            if (!byUrl.has(key)) {
                byUrl.set(key, source);
            }
        }
        return Array.from(byUrl.values());
    }

    private sourceDedupeKey(value: string): string {
        try {
            const url = new URL(value);
            const nestedUrl =
                url.searchParams.get('url') ?? url.searchParams.get('source');
            if (nestedUrl) {
                return this.sourceDedupeKey(nestedUrl);
            }
            url.hash = '';
            url.searchParams.sort();
            return url.toString();
        } catch {
            return value;
        }
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message,
                    field: '',
                    severity: 'error'
                }
            ]
        };
    }
}
