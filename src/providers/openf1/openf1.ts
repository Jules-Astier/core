import type {
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

type OpenF1Session = {
    session_key?: number;
    session_type?: string;
    session_name?: string;
    date_start?: string;
    date_end?: string;
    meeting_key?: number;
    circuit_short_name?: string;
    country_code?: string;
    country_name?: string;
    location?: string;
    year?: number;
    is_cancelled?: boolean;
};

type OpenF1Meeting = {
    meeting_key?: number;
    meeting_name?: string;
    meeting_official_name?: string;
    date_start?: string;
    date_end?: string;
    country_name?: string;
    location?: string;
    year?: number;
    is_cancelled?: boolean;
};

type CacheEntry = {
    expiresAt: number;
    value: unknown;
};

export class OpenF1Provider extends LiveMetadataProvider {
    readonly id = 'openf1';
    readonly name = 'OpenF1';
    readonly enabled = envFlag('OPENF1_ENABLED', true);
    readonly BASE_URL = envValue('OPENF1_BASE_URL') ?? 'https://api.openf1.org';
    readonly HEADERS = {
        Accept: 'application/json'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['live']
    };

    protected readonly envPrefix = 'OPENF1';
    protected readonly defaultWatchPages = [...DEFAULT_LIVE_WATCH_PAGES.f1];

    private readonly endpointCache = new Map<string, CacheEntry>();

    async getLiveEvents(): Promise<ProviderLiveEventCandidate[]> {
        const window = this.manifestWindow();
        const years = this.yearsInWindow(window.startMs, window.endMs);
        const [sessionsByYear, meetingsByYear] = await Promise.all([
            Promise.all(
                years.map((year) =>
                    this.fetchJson<OpenF1Session[]>('/v1/sessions', { year })
                )
            ),
            Promise.all(
                years.map((year) =>
                    this.fetchJson<OpenF1Meeting[]>('/v1/meetings', { year })
                )
            )
        ]);

        const meetings = new Map<number, OpenF1Meeting>();
        for (const meeting of meetingsByYear.flat()) {
            if (meeting.meeting_key !== undefined) {
                meetings.set(meeting.meeting_key, meeting);
            }
        }

        const allowedTypes = csv(envValue('OPENF1_SESSION_TYPES')).map((type) =>
            type.toLowerCase()
        );
        const events = sessionsByYear
            .flat()
            .filter((session) =>
                this.sessionWithinWindow(session, window.startMs, window.endMs)
            )
            .filter((session) => {
                if (!allowedTypes.length) {
                    return true;
                }
                return allowedTypes.includes(
                    (session.session_type ?? '').trim().toLowerCase()
                );
            })
            .map((session) =>
                this.sessionToCandidate(
                    session,
                    meetings.get(session.meeting_key ?? -1)
                )
            )
            .filter((event): event is ProviderLiveEventCandidate =>
                Boolean(event)
            );

        return this.dedupeEvents(events);
    }

    private sessionToCandidate(
        session: OpenF1Session,
        meeting?: OpenF1Meeting
    ): ProviderLiveEventCandidate | undefined {
        const startsAt = this.parseDate(session.date_start);
        if (!startsAt || session.session_key === undefined) {
            return undefined;
        }

        const meetingName =
            this.cleanText(meeting?.meeting_name) ??
            this.cleanText(meeting?.meeting_official_name) ??
            this.cleanText(session.location) ??
            this.cleanText(session.country_name) ??
            'Formula 1';
        const sessionName =
            this.cleanText(session.session_name) ??
            this.cleanText(session.session_type) ??
            'Session';
        const title = this.eventTitle(meetingName, sessionName);

        return {
            providerId: this.id,
            internalEventId: `openf1:${session.session_key}`,
            title,
            league: 'Formula 1',
            sport: 'Motorsport',
            startsAt,
            endsAt: this.parseDate(session.date_end),
            status:
                session.is_cancelled || meeting?.is_cancelled
                    ? 'postponed'
                    : undefined,
            region: this.cleanText(
                session.country_name ?? meeting?.country_name
            ),
            hrefs: this.watchLookupPagesForCandidate(),
            sourceCount: 0
        };
    }

    private eventTitle(meetingName: string, sessionName: string): string {
        const normalizedMeeting = meetingName.toLowerCase();
        const normalizedSession = sessionName.toLowerCase();
        if (normalizedMeeting.includes(normalizedSession)) {
            return meetingName;
        }
        return `${meetingName} ${sessionName}`;
    }

    private sessionWithinWindow(
        session: OpenF1Session,
        startMs: number,
        endMs: number
    ): boolean {
        const startsAt = this.parseDate(session.date_start);
        if (!startsAt) {
            return false;
        }

        const start = new Date(startsAt).getTime();
        return Number.isFinite(start) && start >= startMs && start <= endMs;
    }

    private manifestWindow(): { startMs: number; endMs: number } {
        const now = Date.now();
        const startMs =
            now - envNumber(12, 'OPENF1_LOOKBACK_HOURS') * 60 * 60 * 1000;
        const endMs =
            now + envNumber(14, 'OPENF1_LOOKAHEAD_DAYS') * 24 * 60 * 60 * 1000;
        return { startMs, endMs };
    }

    private yearsInWindow(startMs: number, endMs: number): number[] {
        const years: number[] = [];
        const startYear = new Date(startMs).getUTCFullYear();
        const endYear = new Date(endMs).getUTCFullYear();
        for (let year = startYear; year <= endYear; year += 1) {
            years.push(year);
        }
        return years;
    }

    private async fetchJson<T>(
        path: string,
        params: Record<string, string | number>
    ): Promise<T> {
        const url = new URL(path, this.BASE_URL);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, String(value));
        }

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
            throw new Error(`OpenF1 request failed with ${response.status}`);
        }

        const payload = (await response.json()) as T;
        this.endpointCache.set(cacheKey, {
            expiresAt:
                now + envNumber(6 * 60 * 60, 'OPENF1_CACHE_TTL_SECONDS') * 1000,
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
