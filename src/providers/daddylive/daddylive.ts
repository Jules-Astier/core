import { BaseProvider } from '@omss/framework';
import type {
    AudioTrack,
    LiveEventManifest,
    LiveProvider,
    ProviderCapabilities,
    ProviderLiveEventCandidate,
    ProviderResult,
    Source
} from '@omss/framework';
import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';

type JsonRecord = Record<string, unknown>;
type DiscoveryContext = Partial<ProviderLiveEventCandidate> & {
    dateLabel?: string;
};

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

export class DaddyLiveProvider extends BaseProvider implements LiveProvider {
    readonly id = 'daddylive';
    readonly name = 'DaddyLive';
    readonly enabled = process.env.DADDYLIVE_ENABLED === 'true';
    readonly BASE_URL = this.scheduleUrl()
        ? new URL(this.scheduleUrl()!).origin
        : 'https://daddylive.invalid';
    readonly HEADERS = {
        'User-Agent':
            process.env.DADDYLIVE_USER_AGENT ??
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['live']
    };

    async getMovieSources(): Promise<ProviderResult> {
        return this.emptyResult('DaddyLive only supports live events.');
    }

    async getTVSources(): Promise<ProviderResult> {
        return this.emptyResult('DaddyLive only supports live events.');
    }

    async getLiveEvents(): Promise<ProviderLiveEventCandidate[]> {
        const url = this.scheduleUrl();
        if (!url) {
            return [];
        }

        const response = await fetch(url, {
            headers: this.HEADERS
        });

        if (!response.ok) {
            throw new Error(`DaddyLive schedule failed with ${response.status}`);
        }

        const body = await response.text();
        const contentType = response.headers.get('content-type') ?? '';
        const events = contentType.includes('json') || this.looksLikeJson(body)
            ? this.eventsFromJson(JSON.parse(body))
            : this.eventsFromHtml(body, url);

        return this.dedupeEvents(events);
    }

    async getLiveEventSources(event: LiveEventManifest): Promise<ProviderResult> {
        const sourceMap = await this.loadAuthorizedSourceMap();
        const keys = this.sourceMapKeys(event);
        const sources = keys.flatMap((key) => sourceMap[key] ?? []);

        if (!sources.length) {
            return this.emptyResult(
                'Event was discovered from DaddyLive, but no authorized source mapping is configured.'
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

    private scheduleUrl(): string | undefined {
        return process.env.DADDYLIVE_SCHEDULE_URL?.trim() || undefined;
    }

    private eventsFromJson(payload: unknown): ProviderLiveEventCandidate[] {
        const events: ProviderLiveEventCandidate[] = [];
        this.collectJsonEvents(payload, {}, events);
        return events;
    }

    private collectJsonEvents(
        value: unknown,
        context: DiscoveryContext,
        events: ProviderLiveEventCandidate[]
    ): void {
        if (Array.isArray(value)) {
            for (const item of value) {
                this.collectJsonEvents(item, context, events);
            }
            return;
        }

        if (!this.isRecord(value)) {
            return;
        }

        const nextContext: DiscoveryContext = {
            ...context,
            league: this.firstString(value, ['league', 'competition', 'category']) ?? context.league,
            sport: this.firstString(value, ['sport', 'sportName']) ?? context.sport
        };

        const candidate = this.candidateFromJsonRecord(value, nextContext);
        if (candidate) {
            events.push(candidate);
        }

        for (const [key, child] of Object.entries(value)) {
            if (child === value) {
                continue;
            }

            const childContext = this.contextFromContainerKey(key, nextContext);
            this.collectJsonEvents(child, childContext, events);
        }
    }

    private candidateFromJsonRecord(
        record: JsonRecord,
        context: DiscoveryContext
    ): ProviderLiveEventCandidate | undefined {
        const title =
            this.firstString(record, ['title', 'event', 'name', 'match', 'fixture']) ??
            this.titleFromTeams(record);

        if (!title || title.length < 4) {
            return undefined;
        }

        const href = this.firstString(record, ['href', 'url', 'link']);
        const startsAt = this.parseEventDate(
            this.firstString(record, ['startsAt', 'startAt', 'startTime', 'datetime', 'time']),
            this.firstString(record, ['date', 'eventDate', 'day']) ?? context.dateLabel
        );
        const internalEventId =
            this.firstScalar(record, ['id', 'eventId', 'event_id', 'channelId', 'channel_id']) ??
            href ??
            `${title}:${startsAt ?? ''}`;

        return {
            providerId: this.id,
            internalEventId,
            title,
            league: this.firstString(record, ['league', 'competition', 'category']) ?? context.league,
            sport: this.firstString(record, ['sport', 'sportName']) ?? context.sport ?? 'live',
            startsAt,
            teams: this.teamsFromRecord(record),
            href,
            sourceCount: this.sourceCountFromRecord(record)
        };
    }

    private eventsFromHtml(body: string, baseUrl: string): ProviderLiveEventCandidate[] {
        const $ = cheerio.load(body);
        const selector =
            process.env.DADDYLIVE_EVENT_SELECTOR ??
            'a[href], [data-event], [data-event-id], .event, .match, .fixture';
        const events: ProviderLiveEventCandidate[] = [];

        $(selector).each((_, element) => {
            const node = $(element);
            const title = this.cleanText(node.text());
            if (!title || title.length < 4) {
                return;
            }

            const hrefValue = node.attr('href') ?? node.attr('data-href') ?? node.attr('data-url');
            const href = hrefValue ? new URL(hrefValue, baseUrl).toString() : undefined;
            const startsAt = this.parseEventDate(
                node.attr('data-start') ?? node.attr('data-time') ?? title,
                node.attr('data-date')
            );
            const internalEventId =
                node.attr('data-event-id') ??
                node.attr('data-id') ??
                href ??
                `${title}:${startsAt ?? ''}`;

            events.push({
                providerId: this.id,
                internalEventId,
                title: this.stripLeadingTime(title),
                league: process.env.DADDYLIVE_DEFAULT_LEAGUE ?? 'live',
                sport: process.env.DADDYLIVE_DEFAULT_SPORT ?? 'live',
                startsAt,
                href,
                sourceCount: href ? 1 : 0
            });
        });

        return events;
    }

    private async loadAuthorizedSourceMap(): Promise<AuthorizedSourceMap> {
        const inline = process.env.DADDYLIVE_AUTHORIZED_SOURCE_MAP;
        if (inline) {
            return JSON.parse(inline) as AuthorizedSourceMap;
        }

        const path = process.env.DADDYLIVE_AUTHORIZED_SOURCE_MAP_PATH;
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
                    [provider.internalEventId, provider.href].filter(
                        (value): value is string => Boolean(value)
                    )
                )
        ];
    }

    private parseEventDate(timeValue?: string, dateValue?: string): string | undefined {
        const raw = [dateValue, timeValue].filter(Boolean).join(' ').trim();
        if (!raw) {
            return undefined;
        }

        const direct = new Date(raw);
        if (Number.isFinite(direct.getTime())) {
            return direct.toISOString();
        }

        const timeMatch = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
        if (!timeMatch) {
            return undefined;
        }

        const date = this.parseLooseDate(dateValue) ?? new Date();
        let hour = Number(timeMatch[1]);
        const minute = Number(timeMatch[2] ?? 0);
        const meridiem = timeMatch[3]?.toLowerCase();

        if (meridiem === 'pm' && hour < 12) hour += 12;
        if (meridiem === 'am' && hour === 12) hour = 0;

        const offsetMinutes = Number(process.env.DADDYLIVE_TIMEZONE_OFFSET_MINUTES ?? 0);
        const utcMs =
            Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute) -
            offsetMinutes * 60 * 1000;

        return new Date(utcMs).toISOString();
    }

    private parseLooseDate(value?: string): Date | undefined {
        if (!value) {
            return undefined;
        }

        const direct = new Date(value);
        if (Number.isFinite(direct.getTime())) {
            return direct;
        }

        const match = value.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
        if (!match) {
            return undefined;
        }

        const now = new Date();
        const month = Number(match[1]) - 1;
        const day = Number(match[2]);
        const rawYear = match[3] ? Number(match[3]) : now.getUTCFullYear();
        const year = rawYear < 100 ? 2000 + rawYear : rawYear;
        return new Date(Date.UTC(year, month, day));
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

    private firstString(record: JsonRecord, keys: string[]): string | undefined {
        for (const key of keys) {
            const value = record[key];
            if (typeof value === 'string' && value.trim()) {
                return this.cleanText(value);
            }
        }
        return undefined;
    }

    private firstScalar(record: JsonRecord, keys: string[]): string | undefined {
        for (const key of keys) {
            const value = record[key];
            if (typeof value === 'string' || typeof value === 'number') {
                return String(value);
            }
        }
        return undefined;
    }

    private titleFromTeams(record: JsonRecord): string | undefined {
        const teams = this.teamsFromRecord(record);
        if (teams?.home && teams.away) {
            return `${teams.away} vs ${teams.home}`;
        }
        return undefined;
    }

    private teamsFromRecord(record: JsonRecord): ProviderLiveEventCandidate['teams'] {
        const home = this.firstString(record, ['home', 'homeTeam', 'teamHome']);
        const away = this.firstString(record, ['away', 'awayTeam', 'teamAway']);
        if (!home && !away) {
            return undefined;
        }
        return { home, away };
    }

    private sourceCountFromRecord(record: JsonRecord): number {
        const fields = ['links', 'streams', 'sources', 'channels'];
        return fields.reduce((count, field) => {
            const value = record[field];
            return count + (Array.isArray(value) ? value.length : value ? 1 : 0);
        }, 0);
    }

    private contextFromContainerKey(
        key: string,
        context: DiscoveryContext
    ): DiscoveryContext {
        const label = this.cleanText(key);
        if (!label || /^\d+$/.test(label)) {
            return context;
        }

        if (['data', 'schedule', 'events', 'result', 'results'].includes(label.toLowerCase())) {
            return context;
        }

        if (this.looksLikeDateHeader(label)) {
            return {
                ...context,
                dateLabel: label
            };
        }

        return {
            ...context,
            league: label
        };
    }

    private looksLikeDateHeader(value: string): boolean {
        return (
            /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(value) ||
            /\b\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\s+\d{4}\b/i.test(value) ||
            /\b\d{4}-\d{2}-\d{2}\b/.test(value)
        );
    }

    private normalizeSourceType(type: Source['type'] | undefined, url: string): Source['type'] {
        if (type && SOURCE_TYPES.includes(type)) {
            return type;
        }

        const inferred = this.inferType(url);
        return SOURCE_TYPES.includes(inferred as Source['type']) ? (inferred as Source['type']) : 'hls';
    }

    private looksLikeJson(body: string): boolean {
        const trimmed = body.trim();
        return trimmed.startsWith('{') || trimmed.startsWith('[');
    }

    private isRecord(value: unknown): value is JsonRecord {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    private cleanText(value: string): string {
        return value.replace(/\s+/g, ' ').trim();
    }

    private stripLeadingTime(value: string): string {
        return value.replace(/^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-|:]\s*/i, '').trim();
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
