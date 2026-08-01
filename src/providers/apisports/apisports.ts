import { BaseProvider } from '@omss/framework';
import type {
    AudioTrack,
    LiveEventManifest,
    LiveEventStatus,
    LiveProvider,
    ProviderCapabilities,
    ProviderLiveEventCandidate,
    ProviderResult,
    Source
} from '@omss/framework';
import { readFile } from 'node:fs/promises';
import {
    API_SPORTS_WATCH_PAGES,
    type ApiSportsWatchPageCategory
} from './watch-pages.js';
import { WatchPageLinkDiscovery } from '../live/watch-page-link-discovery.js';
import {
    WatchPageSourceResolver,
    type ResolvedWatchSource
} from '../daddylive/watch-page.resolver.js';

type ApiSportsResponse<T> = {
    get: string;
    parameters: Record<string, string>;
    errors: unknown;
    results: number;
    paging: {
        current: number;
        total: number;
    };
    response: T[];
};

type ApiSportsFormulaRace = {
    id?: number | string;
    competition?: {
        id?: number | string;
        name?: string;
        location?: {
            country?: string;
            city?: string;
        };
    };
    circuit?: {
        id?: number | string;
        name?: string;
    };
    season?: number | string;
    type?: string;
    date?: string;
    timezone?: string;
    status?:
        | string
        | {
              long?: string;
              short?: string;
          };
};

type ApiSportsHockeyGame = {
    id?: number | string;
    date?: string;
    timestamp?: number;
    timezone?: string;
    status?:
        | string
        | {
              long?: string;
              short?: string;
          };
    country?: {
        id?: number | string;
        name?: string;
    };
    league?: {
        id?: number | string;
        name?: string;
        season?: number | string;
    };
    teams?: {
        home?: {
            id?: number | string;
            name?: string;
        };
        away?: {
            id?: number | string;
            name?: string;
        };
    };
};

type AuthorizedSource = {
    url: string;
    type?: Source['type'];
    quality?: string;
    headers?: Record<string, string>;
    audioTracks?: AudioTrack[];
};

type AuthorizedSourceMap = Record<string, AuthorizedSource[]>;

type EndpointCacheEntry = {
    expiresAt: number;
    value: unknown;
};

type ApiSportsEventKind = 'f1' | 'nhl';

const SOURCE_TYPES: Source['type'][] = [
    'hls',
    'dash',
    'http',
    'mp4',
    'mkv',
    'webm',
    'embed'
];

const DEFAULT_LOOKBACK_HOURS = 12;
const DEFAULT_LOOKAHEAD_DAYS = 14;
const DEFAULT_API_CACHE_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_DAILY_REQUEST_BUDGET = 24;

export class ApiSportsProvider extends BaseProvider implements LiveProvider {
    readonly id = 'apisports';
    readonly name = 'API-Sports';
    readonly enabled = process.env.APISPORTS_ENABLED === 'true';
    readonly BASE_URL = 'https://api-sports.io';
    readonly HEADERS = {
        'x-apisports-key': process.env.APISPORTS_KEY ?? '',
        Accept: 'application/json'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['live']
    };

    private readonly endpointCache = new Map<string, EndpointCacheEntry>();
    private readonly requestCounts = new Map<string, number>();
    private watchLinkDiscovery?: WatchPageLinkDiscovery;
    private watchSourceResolver?: WatchPageSourceResolver;

    async getMovieSources(): Promise<ProviderResult> {
        return this.emptyResult(
            'API-Sports only supports live event discovery.'
        );
    }

    async getTVSources(): Promise<ProviderResult> {
        return this.emptyResult(
            'API-Sports only supports live event discovery.'
        );
    }

    async getLiveEvents(): Promise<ProviderLiveEventCandidate[]> {
        if (!this.apiKey()) {
            return [];
        }

        const events: ProviderLiveEventCandidate[] = [];

        if (this.envFlag('APISPORTS_F1_ENABLED', true)) {
            try {
                events.push(...(await this.getFormulaOneEvents()));
            } catch (error) {
                this.console.warn(
                    `Formula 1 discovery failed: ${this.errorMessage(error)}`
                );
            }
        }

        if (this.envFlag('APISPORTS_HOCKEY_ENABLED', true)) {
            try {
                events.push(...(await this.getNhlEvents()));
            } catch (error) {
                this.console.warn(
                    `Hockey discovery failed: ${this.errorMessage(error)}`
                );
            }
        }

        return this.dedupeEvents(
            events.filter((event) =>
                this.isWithinManifestWindow(event.startsAt)
            )
        );
    }

    async getLiveEventSources(
        event: LiveEventManifest
    ): Promise<ProviderResult> {
        const sourceMap = await this.loadAuthorizedSourceMap();
        const keys = this.sourceMapKeys(event);
        const sources = keys.flatMap((key) => sourceMap[key] ?? []);
        const resolvedSources = await this.resolveEventWatchSources(event);
        const allSources = this.dedupeSources([...sources, ...resolvedSources]);

        if (!allSources.length) {
            return this.emptyResult(
                this.watchSourceResolutionEnabled()
                    ? 'Event was discovered from API-Sports, but no matching watch-page links or authorized source mapping could be resolved.'
                    : 'Event was discovered from API-Sports, but no authorized source mapping is configured.'
            );
        }

        return {
            sources: allSources.map((source) => ({
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

    private async resolveEventWatchSources(
        event: LiveEventManifest
    ): Promise<ResolvedWatchSource[]> {
        if (!this.watchSourceResolutionEnabled()) {
            return [];
        }

        const lookupPages = this.watchLookupPagesForEvent(event);
        if (!lookupPages.length) {
            return [];
        }

        const discovery = await this.getWatchLinkDiscovery().discover(
            event,
            lookupPages
        );
        for (const failure of discovery.failures) {
            this.console.warn(
                `API-Sports watch page failed for ${failure.pageUrl}: ${failure.error}`
            );
        }

        const resolver = this.getWatchSourceResolver();
        const results = await Promise.allSettled(
            discovery.links.map((href) => resolver.resolveWatchPage(href))
        );

        for (const result of results) {
            if (result.status === 'rejected') {
                this.console.warn(
                    `API-Sports watch source resolution failed: ${this.errorMessage(result.reason)}`
                );
            }
        }

        return this.dedupeSources(
            results.flatMap((result) =>
                result.status === 'fulfilled' ? result.value : []
            )
        );
    }

    private watchLookupPagesForEvent(event: LiveEventManifest): string[] {
        return this.unique(
            event.providers
                .filter((provider) => provider.providerId === this.id)
                .flatMap((provider) => [
                    provider.href,
                    ...(provider.hrefs ?? [])
                ])
        );
    }

    private getWatchLinkDiscovery(): WatchPageLinkDiscovery {
        this.watchLinkDiscovery ??= new WatchPageLinkDiscovery({
            headers: {
                'User-Agent':
                    process.env.APISPORTS_WATCH_USER_AGENT ??
                    process.env.WATCHPAGE_USER_AGENT ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
                Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
            },
            hrefPatterns: this.csv(
                process.env.APISPORTS_WATCH_HREF_PATTERNS ??
                    process.env.WATCHPAGE_HREF_PATTERNS
            ),
            rowSelector:
                process.env.APISPORTS_WATCH_EVENT_ROW_SELECTOR ??
                process.env.WATCHPAGE_EVENT_ROW_SELECTOR,
            matchMinScore: this.numberEnv(
                'APISPORTS_WATCH_MATCH_MIN_SCORE',
                0.45
            ),
            timeWindowHours: this.numberEnv(
                'APISPORTS_WATCH_MATCH_TIME_WINDOW_HOURS',
                18
            ),
            cacheTtlSeconds: this.numberEnv(
                'APISPORTS_WATCH_PAGE_CACHE_TTL_SECONDS',
                60
            ),
            renderWithPlaywright: this.envFlag(
                'APISPORTS_WATCH_RENDER_WITH_PLAYWRIGHT',
                this.envFlag('WATCHPAGE_RENDER_WITH_PLAYWRIGHT', false)
            ),
            playwrightPackage:
                process.env.APISPORTS_WATCH_PLAYWRIGHT_PACKAGE ??
                process.env.WATCHPAGE_PLAYWRIGHT_PACKAGE ??
                'playwright-core',
            browserExecutablePath:
                process.env.APISPORTS_WATCH_BROWSER_EXECUTABLE_PATH ??
                process.env.WATCHPAGE_BROWSER_EXECUTABLE_PATH,
            playwrightTimeoutMs: this.numberEnv(
                'APISPORTS_WATCH_PLAYWRIGHT_TIMEOUT_MS',
                20_000
            )
        });

        return this.watchLinkDiscovery;
    }

    private getWatchSourceResolver(): WatchPageSourceResolver {
        this.watchSourceResolver ??= new WatchPageSourceResolver({
            baseUrl:
                process.env.APISPORTS_HEADLESSVIDX_BASE_URL ??
                process.env.WATCHPAGE_HEADLESSVIDX_BASE_URL ??
                process.env.DADDYLIVE_HEADLESSVIDX_BASE_URL,
            cacheTtlSeconds: this.numberEnv(
                'APISPORTS_WATCH_SOURCE_CACHE_TTL_SECONDS',
                30
            )
        });

        return this.watchSourceResolver;
    }

    private watchSourceResolutionEnabled(): boolean {
        return this.envFlag('APISPORTS_WATCH_SOURCE_RESOLUTION_ENABLED', true);
    }

    private async getFormulaOneEvents(): Promise<ProviderLiveEventCandidate[]> {
        const season =
            process.env.APISPORTS_F1_SEASON ??
            String(new Date().getUTCFullYear());
        const allowedTypes = this.csv(process.env.APISPORTS_F1_TYPES).map(
            (type) => type.toLowerCase()
        );
        const payload = await this.fetchApi<ApiSportsFormulaRace>(
            this.formulaOneBaseUrl(),
            '/races',
            { season }
        );

        return payload.response
            .filter((race) => {
                if (!allowedTypes.length) return true;
                return allowedTypes.includes(
                    (race.type ?? '').trim().toLowerCase()
                );
            })
            .map((race) => this.formulaOneRaceToCandidate(race))
            .filter((event): event is ProviderLiveEventCandidate =>
                Boolean(event)
            );
    }

    private async getNhlEvents(): Promise<ProviderLiveEventCandidate[]> {
        const league = process.env.APISPORTS_HOCKEY_NHL_LEAGUE_ID ?? '57';
        const season =
            process.env.APISPORTS_HOCKEY_NHL_SEASON ?? this.currentNhlSeason();
        const payload = await this.fetchApi<ApiSportsHockeyGame>(
            this.hockeyBaseUrl(),
            '/games',
            { league, season }
        );

        return payload.response
            .map((game) => this.hockeyGameToCandidate(game))
            .filter((event): event is ProviderLiveEventCandidate =>
                Boolean(event)
            );
    }

    private formulaOneRaceToCandidate(
        race: ApiSportsFormulaRace
    ): ProviderLiveEventCandidate | undefined {
        const competition =
            this.cleanText(race.competition?.name) ?? 'Formula 1';
        const sessionType = this.cleanText(race.type);
        const startsAt = this.parseDate(race.date);
        const title =
            sessionType &&
            !competition.toLowerCase().includes(sessionType.toLowerCase())
                ? `${competition} ${sessionType}`
                : competition;
        const internalEventId = `f1:${race.id ?? `${competition}:${sessionType ?? ''}:${startsAt ?? ''}`}`;
        const hrefs = this.watchLookupPages('f1');

        if (!startsAt) {
            return undefined;
        }

        return {
            providerId: this.id,
            internalEventId,
            title,
            league: 'Formula 1',
            sport: 'Motorsport',
            startsAt,
            endsAt: this.endsAt(
                startsAt,
                this.durationMinutesForFormulaOne(sessionType)
            ),
            status: this.mapLiveStatus(race.status),
            region: this.cleanText(race.competition?.location?.country),
            hrefs,
            sourceCount: 0
        };
    }

    private hockeyGameToCandidate(
        game: ApiSportsHockeyGame
    ): ProviderLiveEventCandidate | undefined {
        const home = this.cleanText(game.teams?.home?.name);
        const away = this.cleanText(game.teams?.away?.name);
        const title =
            home && away
                ? `${away} vs ${home}`
                : (this.cleanText(game.league?.name) ?? 'NHL Game');
        const startsAt =
            this.parseDate(game.date) ?? this.parseTimestamp(game.timestamp);
        const internalEventId = `hockey:${game.id ?? `${title}:${startsAt ?? ''}`}`;
        const hrefs = this.watchLookupPages('nhl');

        if (!startsAt) {
            return undefined;
        }

        return {
            providerId: this.id,
            internalEventId,
            title,
            league: this.cleanText(game.league?.name) ?? 'NHL',
            sport: 'Ice Hockey',
            startsAt,
            endsAt: this.endsAt(startsAt, this.durationMinutesForHockey()),
            status: this.mapLiveStatus(game.status),
            teams: {
                home,
                away
            },
            region: this.cleanText(game.country?.name),
            hrefs,
            sourceCount: 0
        };
    }

    private watchLookupPages(kind: ApiSportsEventKind): string[] {
        const category = this.watchPageCategoryForKind(kind);
        const envPages = this.csv(
            process.env[`APISPORTS_${kind.toUpperCase()}_WATCH_PAGES`]
        );
        return this.unique([
            ...this.commonWatchLookupPages(),
            ...(envPages.length ? envPages : API_SPORTS_WATCH_PAGES[category])
        ]);
    }

    private commonWatchLookupPages(): string[] {
        return this.csv(
            [
                process.env.APISPORTS_COMMON_WATCH_PAGES,
                process.env.WATCHPAGE_URL,
                process.env.DADDYLIVE_SCHEDULE_URL
            ]
                .filter(Boolean)
                .join(',')
        );
    }

    private watchPageCategoryForKind(
        kind: ApiSportsEventKind
    ): ApiSportsWatchPageCategory {
        if (kind === 'f1') {
            return 'f1';
        }
        return 'nhl';
    }

    private async fetchApi<T>(
        baseUrl: string,
        path: string,
        params: Record<string, string>
    ): Promise<ApiSportsResponse<T>> {
        const url = new URL(path, baseUrl);
        for (const [key, value] of Object.entries(params)) {
            if (value) {
                url.searchParams.set(key, value);
            }
        }

        const cacheKey = url.toString();
        const now = Date.now();
        const cached = this.endpointCache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
            return cached.value as ApiSportsResponse<T>;
        }

        if (!this.canSpendRequest()) {
            if (cached) {
                return cached.value as ApiSportsResponse<T>;
            }
            throw new Error('API-Sports daily request budget exhausted');
        }

        this.recordRequest();

        const response = await fetch(cacheKey, {
            headers: this.HEADERS
        });

        if (!response.ok) {
            throw new Error(
                `API-Sports request failed with ${response.status}`
            );
        }

        const payload = (await response.json()) as ApiSportsResponse<T>;
        const apiError = this.apiErrorMessage(payload.errors);
        if (apiError) {
            throw new Error(apiError);
        }

        this.endpointCache.set(cacheKey, {
            expiresAt: now + this.apiCacheTtlSeconds() * 1000,
            value: payload
        });

        return payload;
    }

    private async loadAuthorizedSourceMap(): Promise<AuthorizedSourceMap> {
        const inline =
            process.env.APISPORTS_AUTHORIZED_SOURCE_MAP ??
            process.env.LIVE_AUTHORIZED_SOURCE_MAP;
        if (inline) {
            return JSON.parse(inline) as AuthorizedSourceMap;
        }

        const path =
            process.env.APISPORTS_AUTHORIZED_SOURCE_MAP_PATH ??
            process.env.LIVE_AUTHORIZED_SOURCE_MAP_PATH;
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

    private mapLiveStatus(
        status: ApiSportsFormulaRace['status'] | ApiSportsHockeyGame['status']
    ): LiveEventStatus | undefined {
        const raw =
            typeof status === 'string'
                ? status
                : [status?.short, status?.long].filter(Boolean).join(' ');
        const value = raw.trim().toLowerCase();

        if (!value) {
            return undefined;
        }

        if (
            /\b(postponed|cancelled|canceled|abandoned|suspended)\b|\b(post|canc|abd|sus)\b/i.test(
                value
            )
        ) {
            return 'postponed';
        }

        if (
            /\b(live|in progress|in play|1st|2nd|3rd|period|overtime|break)\b|\b(p1|p2|p3|ot|bt)\b/i.test(
                value
            )
        ) {
            return 'live';
        }

        if (
            /\b(finished|complete|completed|ended|after overtime|after penalties)\b|\b(ft|aot|ap)\b/i.test(
                value
            )
        ) {
            return 'ended';
        }

        return 'scheduled';
    }

    private endsAt(startsAt: string, durationMinutes: number): string {
        const start = new Date(startsAt).getTime();
        return new Date(start + durationMinutes * 60 * 1000).toISOString();
    }

    private durationMinutesForFormulaOne(type?: string): number {
        const override = Number(
            process.env.APISPORTS_DEFAULT_EVENT_DURATION_MINUTES
        );
        if (Number.isFinite(override) && override > 0) {
            return override;
        }

        const value = (type ?? '').toLowerCase();
        if (value.includes('race')) return 3 * 60;
        if (value.includes('sprint')) return 90;
        return 2 * 60;
    }

    private durationMinutesForHockey(): number {
        const override = Number(
            process.env.APISPORTS_HOCKEY_EVENT_DURATION_MINUTES
        );
        return Number.isFinite(override) && override > 0 ? override : 3 * 60;
    }

    private parseDate(value?: string): string | undefined {
        if (!value) {
            return undefined;
        }

        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime())
            ? parsed.toISOString()
            : undefined;
    }

    private parseTimestamp(value?: number): string | undefined {
        if (!value) {
            return undefined;
        }

        const milliseconds = value > 10_000_000_000 ? value : value * 1000;
        const parsed = new Date(milliseconds);
        return Number.isFinite(parsed.getTime())
            ? parsed.toISOString()
            : undefined;
    }

    private isWithinManifestWindow(startsAt?: string): boolean {
        if (!startsAt) {
            return false;
        }

        const start = new Date(startsAt).getTime();
        if (!Number.isFinite(start)) {
            return false;
        }

        const now = Date.now();
        const lookbackMs =
            this.numberEnv('APISPORTS_LOOKBACK_HOURS', DEFAULT_LOOKBACK_HOURS) *
            60 *
            60 *
            1000;
        const lookaheadMs =
            this.numberEnv('APISPORTS_LOOKAHEAD_DAYS', DEFAULT_LOOKAHEAD_DAYS) *
            24 *
            60 *
            60 *
            1000;
        return start >= now - lookbackMs && start <= now + lookaheadMs;
    }

    private currentNhlSeason(): string {
        const now = new Date();
        const year = now.getUTCFullYear();
        return String(now.getUTCMonth() >= 8 ? year : year - 1);
    }

    private canSpendRequest(): boolean {
        const budget = this.numberEnv(
            'APISPORTS_DAILY_REQUEST_BUDGET',
            DEFAULT_DAILY_REQUEST_BUDGET
        );
        if (budget <= 0) {
            return true;
        }

        return (this.requestCounts.get(this.requestDay()) ?? 0) < budget;
    }

    private recordRequest(): void {
        const day = this.requestDay();
        this.requestCounts.set(day, (this.requestCounts.get(day) ?? 0) + 1);
    }

    private requestDay(): string {
        return new Date().toISOString().slice(0, 10);
    }

    private apiErrorMessage(errors: unknown): string | undefined {
        if (!errors) {
            return undefined;
        }

        if (typeof errors === 'string') {
            return errors.trim() || undefined;
        }

        if (Array.isArray(errors)) {
            return errors.length ? errors.map(String).join('; ') : undefined;
        }

        if (typeof errors === 'object') {
            const entries = Object.values(errors as Record<string, unknown>)
                .map(String)
                .filter(Boolean);
            return entries.length ? entries.join('; ') : undefined;
        }

        return undefined;
    }

    private dedupeEvents(
        events: ProviderLiveEventCandidate[]
    ): ProviderLiveEventCandidate[] {
        const byKey = new Map<string, ProviderLiveEventCandidate>();
        for (const event of events) {
            const key = [event.internalEventId, event.title, event.startsAt]
                .filter(Boolean)
                .join(':');
            if (!byKey.has(key)) {
                byKey.set(key, event);
            }
        }
        return Array.from(byKey.values());
    }

    private unique(values: Array<string | undefined>): string[] {
        return Array.from(
            new Set(values.filter((value): value is string => Boolean(value)))
        );
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

    private normalizeSourceType(
        type: Source['type'] | undefined,
        url: string
    ): Source['type'] {
        if (type && SOURCE_TYPES.includes(type)) {
            return type;
        }

        const inferred = this.inferType(url);
        return SOURCE_TYPES.includes(inferred as Source['type'])
            ? (inferred as Source['type'])
            : 'hls';
    }

    private formulaOneBaseUrl(): string {
        return (
            process.env.APISPORTS_F1_BASE_URL ??
            'https://v1.formula-1.api-sports.io'
        );
    }

    private hockeyBaseUrl(): string {
        return (
            process.env.APISPORTS_HOCKEY_BASE_URL ??
            'https://v1.hockey.api-sports.io'
        );
    }

    private apiKey(): string | undefined {
        return process.env.APISPORTS_KEY?.trim() || undefined;
    }

    private apiCacheTtlSeconds(): number {
        return this.numberEnv(
            'APISPORTS_CACHE_TTL_SECONDS',
            DEFAULT_API_CACHE_TTL_SECONDS
        );
    }

    private envFlag(name: string, defaultValue: boolean): boolean {
        const value = process.env[name];
        if (value === undefined) {
            return defaultValue;
        }
        return value === 'true';
    }

    private numberEnv(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isFinite(value) ? value : defaultValue;
    }

    private csv(value?: string): string[] {
        return (
            value
                ?.split(',')
                .map((entry) => entry.trim())
                .filter(Boolean) ?? []
        );
    }

    private cleanText(value?: string): string | undefined {
        const cleaned = value?.replace(/\s+/g, ' ').trim();
        return cleaned || undefined;
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : 'Unknown error';
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
}
