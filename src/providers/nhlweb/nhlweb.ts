import type {
    LiveEventStatus,
    ProviderCapabilities,
    ProviderLiveEventCandidate
} from '@omss/framework';
import {
    csv,
    envFlag,
    envNumber,
    envValue,
    LiveMetadataProvider
} from '../../live/live-metadata-provider.js';
import { DEFAULT_LIVE_WATCH_PAGES } from '../live/default-watch-pages.js';

type NhlLocalizedString = {
    default?: string;
};

type NhlTeam = {
    id?: number;
    commonName?: NhlLocalizedString;
    placeName?: NhlLocalizedString;
    abbrev?: string;
};

type NhlGame = {
    id?: number;
    season?: number;
    gameType?: number;
    venue?: NhlLocalizedString;
    startTimeUTC?: string;
    gameState?: string;
    gameScheduleState?: string;
    awayTeam?: NhlTeam;
    homeTeam?: NhlTeam;
};

type NhlGameWeek = {
    date?: string;
    games?: NhlGame[];
};

type NhlScheduleResponse = {
    nextStartDate?: string;
    previousStartDate?: string;
    gameWeek?: NhlGameWeek[];
    numberOfGames?: number;
};

type CacheEntry = {
    expiresAt: number;
    value: unknown;
};

export class NhlWebProvider extends LiveMetadataProvider {
    readonly id = 'nhlweb';
    readonly name = 'NHL Web';
    readonly enabled = envFlag('NHLWEB_ENABLED', true);
    readonly BASE_URL =
        envValue('NHLWEB_BASE_URL') ?? 'https://api-web.nhle.com';
    readonly HEADERS = {
        Accept: 'application/json'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['live']
    };

    protected readonly envPrefix = 'NHLWEB';
    protected readonly defaultWatchPages = [...DEFAULT_LIVE_WATCH_PAGES.nhl];

    private readonly endpointCache = new Map<string, CacheEntry>();

    async getLiveEvents(): Promise<ProviderLiveEventCandidate[]> {
        const window = this.manifestWindow();
        const schedules = await this.fetchScheduleWindow(
            this.dateKey(window.startMs),
            this.dateKey(window.endMs)
        );
        const allowedGameTypes = this.allowedGameTypes();
        const events = schedules
            .flatMap((schedule) => this.gamesFromSchedule(schedule))
            .filter((game) =>
                this.gameWithinWindow(game, window.startMs, window.endMs)
            )
            .filter(
                (game) =>
                    !allowedGameTypes.length ||
                    allowedGameTypes.includes(String(game.gameType))
            )
            .map((game) => this.gameToCandidate(game))
            .filter((event): event is ProviderLiveEventCandidate =>
                Boolean(event)
            );

        return this.dedupeEvents(events);
    }

    private async fetchScheduleWindow(
        startDate: string,
        endDate: string
    ): Promise<NhlScheduleResponse[]> {
        const schedules: NhlScheduleResponse[] = [];
        const seenDates = new Set<string>();
        let cursor = envValue('NHLWEB_START_DATE') ?? startDate;

        while (cursor <= endDate && !seenDates.has(cursor)) {
            seenDates.add(cursor);
            const schedule = await this.fetchJson<NhlScheduleResponse>(
                `/v1/schedule/${cursor}`
            );
            schedules.push(schedule);

            const nextDate = schedule.nextStartDate;
            if (!nextDate || nextDate <= cursor) {
                break;
            }
            cursor = nextDate;
        }

        return schedules;
    }

    private gamesFromSchedule(schedule: NhlScheduleResponse): NhlGame[] {
        return (
            schedule.gameWeek?.flatMap((week) =>
                (week.games ?? []).map((game) => ({
                    ...game
                }))
            ) ?? []
        );
    }

    private gameToCandidate(
        game: NhlGame
    ): ProviderLiveEventCandidate | undefined {
        const startsAt = this.parseDate(game.startTimeUTC);
        if (!startsAt || game.id === undefined) {
            return undefined;
        }

        const away = this.teamName(game.awayTeam);
        const home = this.teamName(game.homeTeam);
        const title = away && home ? `${away} vs ${home}` : 'NHL Game';

        return {
            providerId: this.id,
            internalEventId: `nhl:${game.id}`,
            title,
            league: this.leagueName(game),
            sport: 'Ice Hockey',
            startsAt,
            endsAt: this.endsAt(
                startsAt,
                envNumber(3 * 60, 'NHLWEB_EVENT_DURATION_MINUTES')
            ),
            status: this.mapGameStatus(game.gameState, game.gameScheduleState),
            teams: {
                away,
                home
            },
            region: this.cleanText(game.venue?.default),
            hrefs: this.watchLookupPagesForCandidate(),
            sourceCount: 0
        };
    }

    private leagueName(game: NhlGame): string {
        if (game.gameType === 3) {
            return 'NHL Playoffs';
        }
        if (game.gameType === 1) {
            return 'NHL Preseason';
        }
        return 'NHL';
    }

    private teamName(team?: NhlTeam): string | undefined {
        const place = this.cleanText(team?.placeName?.default);
        const common = this.cleanText(team?.commonName?.default);
        const full = [place, common].filter(Boolean).join(' ').trim();
        return full || this.cleanText(team?.abbrev);
    }

    private mapGameStatus(
        gameState?: string,
        gameScheduleState?: string
    ): LiveEventStatus | undefined {
        const scheduleState = (gameScheduleState ?? '').toLowerCase();
        if (
            /\b(ppd|post|postponed|cancelled|canceled|cncl|susp)\b/.test(
                scheduleState
            )
        ) {
            return 'postponed';
        }

        const state = (gameState ?? '').toUpperCase();
        if (['LIVE', 'CRIT'].includes(state)) {
            return 'live';
        }
        if (['FINAL', 'OFF'].includes(state)) {
            return 'ended';
        }
        if (['FUT', 'PRE'].includes(state)) {
            return 'scheduled';
        }
        return undefined;
    }

    private allowedGameTypes(): string[] {
        return csv(envValue('NHLWEB_GAME_TYPES')).map((type) => type.trim());
    }

    private gameWithinWindow(
        game: NhlGame,
        startMs: number,
        endMs: number
    ): boolean {
        const startsAt = this.parseDate(game.startTimeUTC);
        if (!startsAt) {
            return false;
        }

        const start = new Date(startsAt).getTime();
        return Number.isFinite(start) && start >= startMs && start <= endMs;
    }

    private manifestWindow(): { startMs: number; endMs: number } {
        const now = Date.now();
        const startMs =
            now - envNumber(12, 'NHLWEB_LOOKBACK_HOURS') * 60 * 60 * 1000;
        const endMs =
            now + envNumber(14, 'NHLWEB_LOOKAHEAD_DAYS') * 24 * 60 * 60 * 1000;
        return { startMs, endMs };
    }

    private dateKey(value: number): string {
        return new Date(value).toISOString().slice(0, 10);
    }

    private async fetchJson<T>(path: string): Promise<T> {
        const url = new URL(path, this.BASE_URL);
        const cacheKey = url.toString();
        const now = Date.now();
        const cached = this.endpointCache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
            return cached.value as T;
        }

        const response = await fetch(cacheKey, {
            headers: this.HEADERS
        });
        if (!response.ok) {
            throw new Error(
                `NHL schedule request failed with ${response.status}`
            );
        }

        const payload = (await response.json()) as T;
        this.endpointCache.set(cacheKey, {
            expiresAt:
                now + envNumber(15 * 60, 'NHLWEB_CACHE_TTL_SECONDS') * 1000,
            value: payload
        });
        return payload;
    }

    private dedupeEvents(
        events: ProviderLiveEventCandidate[]
    ): ProviderLiveEventCandidate[] {
        const byKey = new Map<string, ProviderLiveEventCandidate>();
        for (const event of events) {
            const key =
                event.internalEventId ??
                `${event.title}:${event.startsAt ?? ''}`;
            if (!byKey.has(key)) {
                byKey.set(key, event);
            }
        }
        return Array.from(byKey.values()).sort((left, right) => {
            return (
                (left.startsAt ?? '').localeCompare(right.startsAt ?? '') ||
                left.title.localeCompare(right.title)
            );
        });
    }
}
