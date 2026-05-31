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
    status?: string | {
        long?: string;
        short?: string;
    };
};

type ApiSportsHockeyGame = {
    id?: number | string;
    date?: string;
    timestamp?: number;
    timezone?: string;
    status?: string | {
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

    async getMovieSources(): Promise<ProviderResult> {
        return this.emptyResult('API-Sports only supports live event discovery.');
    }

    async getTVSources(): Promise<ProviderResult> {
        return this.emptyResult('API-Sports only supports live event discovery.');
    }

    async getLiveEvents(): Promise<ProviderLiveEventCandidate[]> {
        if (!this.apiKey()) {
            return [];
        }

        const events: ProviderLiveEventCandidate[] = [];

        if (this.envFlag('APISPORTS_F1_ENABLED', true)) {
            try {
                events.push(...await this.getFormulaOneEvents());
            } catch (error) {
                this.console.warn(`Formula 1 discovery failed: ${this.errorMessage(error)}`);
            }
        }

        if (this.envFlag('APISPORTS_HOCKEY_ENABLED', true)) {
            try {
                events.push(...await this.getNhlEvents());
            } catch (error) {
                this.console.warn(`Hockey discovery failed: ${this.errorMessage(error)}`);
            }
        }

        return this.dedupeEvents(events.filter((event) => this.isWithinManifestWindow(event.startsAt)));
    }

    async getLiveEventSources(event: LiveEventManifest): Promise<ProviderResult> {
        const sourceMap = await this.loadAuthorizedSourceMap();
        const keys = this.sourceMapKeys(event);
        const sources = keys.flatMap((key) => sourceMap[key] ?? []);

        if (!sources.length) {
            return this.emptyResult(
                'Event was discovered from API-Sports, but no authorized source mapping is configured.'
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

    private async getFormulaOneEvents(): Promise<ProviderLiveEventCandidate[]> {
        const season = process.env.APISPORTS_F1_SEASON ?? String(new Date().getUTCFullYear());
        const allowedTypes = this.csv(process.env.APISPORTS_F1_TYPES).map((type) => type.toLowerCase());
        const payload = await this.fetchApi<ApiSportsFormulaRace>(
            this.formulaOneBaseUrl(),
            '/races',
            { season }
        );

        return payload.response
            .filter((race) => {
                if (!allowedTypes.length) return true;
                return allowedTypes.includes((race.type ?? '').trim().toLowerCase());
            })
            .map((race) => this.formulaOneRaceToCandidate(race))
            .filter((event): event is ProviderLiveEventCandidate => Boolean(event));
    }

    private async getNhlEvents(): Promise<ProviderLiveEventCandidate[]> {
        const league = process.env.APISPORTS_HOCKEY_NHL_LEAGUE_ID ?? '57';
        const season = process.env.APISPORTS_HOCKEY_NHL_SEASON ?? this.currentNhlSeason();
        const payload = await this.fetchApi<ApiSportsHockeyGame>(
            this.hockeyBaseUrl(),
            '/games',
            { league, season }
        );

        return payload.response
            .map((game) => this.hockeyGameToCandidate(game))
            .filter((event): event is ProviderLiveEventCandidate => Boolean(event));
    }

    private formulaOneRaceToCandidate(race: ApiSportsFormulaRace): ProviderLiveEventCandidate | undefined {
        const competition = this.cleanText(race.competition?.name) ?? 'Formula 1';
        const sessionType = this.cleanText(race.type);
        const startsAt = this.parseDate(race.date);
        const title = sessionType && !competition.toLowerCase().includes(sessionType.toLowerCase())
            ? `${competition} ${sessionType}`
            : competition;
        const internalEventId = `f1:${race.id ?? `${competition}:${sessionType ?? ''}:${startsAt ?? ''}`}`;

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
            endsAt: this.endsAt(startsAt, this.durationMinutesForFormulaOne(sessionType)),
            status: this.mapLiveStatus(race.status),
            region: this.cleanText(race.competition?.location?.country),
            sourceCount: 0
        };
    }

    private hockeyGameToCandidate(game: ApiSportsHockeyGame): ProviderLiveEventCandidate | undefined {
        const home = this.cleanText(game.teams?.home?.name);
        const away = this.cleanText(game.teams?.away?.name);
        const title = home && away
            ? `${away} vs ${home}`
            : this.cleanText(game.league?.name) ?? 'NHL Game';
        const startsAt = this.parseDate(game.date) ?? this.parseTimestamp(game.timestamp);
        const internalEventId = `hockey:${game.id ?? `${title}:${startsAt ?? ''}`}`;

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
            sourceCount: 0
        };
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
            throw new Error(`API-Sports request failed with ${response.status}`);
        }

        const payload = await response.json() as ApiSportsResponse<T>;
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
        const inline = process.env.APISPORTS_AUTHORIZED_SOURCE_MAP ?? process.env.LIVE_AUTHORIZED_SOURCE_MAP;
        if (inline) {
            return JSON.parse(inline) as AuthorizedSourceMap;
        }

        const path = process.env.APISPORTS_AUTHORIZED_SOURCE_MAP_PATH ?? process.env.LIVE_AUTHORIZED_SOURCE_MAP_PATH;
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
                    [provider.internalEventId, provider.href, ...(provider.hrefs ?? [])].filter(
                        (value): value is string => Boolean(value)
                    )
                )
        ];
    }

    private mapLiveStatus(status: ApiSportsFormulaRace['status'] | ApiSportsHockeyGame['status']): LiveEventStatus | undefined {
        const raw = typeof status === 'string'
            ? status
            : [status?.short, status?.long].filter(Boolean).join(' ');
        const value = raw.trim().toLowerCase();

        if (!value) {
            return undefined;
        }

        if (/\b(postponed|cancelled|canceled|abandoned|suspended)\b|\b(post|canc|abd|sus)\b/i.test(value)) {
            return 'postponed';
        }

        if (/\b(live|in progress|in play|1st|2nd|3rd|period|overtime|break)\b|\b(p1|p2|p3|ot|bt)\b/i.test(value)) {
            return 'live';
        }

        if (/\b(finished|complete|completed|ended|after overtime|after penalties)\b|\b(ft|aot|ap)\b/i.test(value)) {
            return 'ended';
        }

        return 'scheduled';
    }

    private endsAt(startsAt: string, durationMinutes: number): string {
        const start = new Date(startsAt).getTime();
        return new Date(start + durationMinutes * 60 * 1000).toISOString();
    }

    private durationMinutesForFormulaOne(type?: string): number {
        const override = Number(process.env.APISPORTS_DEFAULT_EVENT_DURATION_MINUTES);
        if (Number.isFinite(override) && override > 0) {
            return override;
        }

        const value = (type ?? '').toLowerCase();
        if (value.includes('race')) return 3 * 60;
        if (value.includes('sprint')) return 90;
        return 2 * 60;
    }

    private durationMinutesForHockey(): number {
        const override = Number(process.env.APISPORTS_HOCKEY_EVENT_DURATION_MINUTES);
        return Number.isFinite(override) && override > 0 ? override : 3 * 60;
    }

    private parseDate(value?: string): string | undefined {
        if (!value) {
            return undefined;
        }

        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
    }

    private parseTimestamp(value?: number): string | undefined {
        if (!value) {
            return undefined;
        }

        const milliseconds = value > 10_000_000_000 ? value : value * 1000;
        const parsed = new Date(milliseconds);
        return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
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
        const lookbackMs = this.numberEnv('APISPORTS_LOOKBACK_HOURS', DEFAULT_LOOKBACK_HOURS) * 60 * 60 * 1000;
        const lookaheadMs = this.numberEnv('APISPORTS_LOOKAHEAD_DAYS', DEFAULT_LOOKAHEAD_DAYS) * 24 * 60 * 60 * 1000;
        return start >= now - lookbackMs && start <= now + lookaheadMs;
    }

    private currentNhlSeason(): string {
        const now = new Date();
        const year = now.getUTCFullYear();
        return String(now.getUTCMonth() >= 8 ? year : year - 1);
    }

    private canSpendRequest(): boolean {
        const budget = this.numberEnv('APISPORTS_DAILY_REQUEST_BUDGET', DEFAULT_DAILY_REQUEST_BUDGET);
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
            const entries = Object.values(errors as Record<string, unknown>).map(String).filter(Boolean);
            return entries.length ? entries.join('; ') : undefined;
        }

        return undefined;
    }

    private dedupeEvents(events: ProviderLiveEventCandidate[]): ProviderLiveEventCandidate[] {
        const byKey = new Map<string, ProviderLiveEventCandidate>();
        for (const event of events) {
            const key = [event.internalEventId, event.title, event.startsAt].filter(Boolean).join(':');
            if (!byKey.has(key)) {
                byKey.set(key, event);
            }
        }
        return Array.from(byKey.values());
    }

    private normalizeSourceType(type: Source['type'] | undefined, url: string): Source['type'] {
        if (type && SOURCE_TYPES.includes(type)) {
            return type;
        }

        const inferred = this.inferType(url);
        return SOURCE_TYPES.includes(inferred as Source['type']) ? (inferred as Source['type']) : 'hls';
    }

    private formulaOneBaseUrl(): string {
        return process.env.APISPORTS_F1_BASE_URL ?? 'https://v1.formula-1.api-sports.io';
    }

    private hockeyBaseUrl(): string {
        return process.env.APISPORTS_HOCKEY_BASE_URL ?? 'https://v1.hockey.api-sports.io';
    }

    private apiKey(): string | undefined {
        return process.env.APISPORTS_KEY?.trim() || undefined;
    }

    private apiCacheTtlSeconds(): number {
        return this.numberEnv('APISPORTS_CACHE_TTL_SECONDS', DEFAULT_API_CACHE_TTL_SECONDS);
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
        return value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
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
