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
import {
    WatchPageSourceResolver,
    type ResolvedWatchSource
} from './watch-page.resolver.js';

type JsonRecord = Record<string, unknown>;
type DiscoveryContext = Partial<ProviderLiveEventCandidate> & {
    dateLabel?: string;
};

type DaddyLiveScheduleRow = {
    title: string;
    league?: string;
    sport?: string;
    startsAt?: string;
    teams?: ProviderLiveEventCandidate['teams'];
    internalEventId: string;
    hrefs: string[];
    sourceCount: number;
};

type ScheduleRowsCache = {
    expiresAt: number;
    rows: DaddyLiveScheduleRow[];
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

const DEFAULT_SCHEDULE_CACHE_TTL_SECONDS = 15 * 60;
const DEFAULT_MATCH_MIN_SCORE = 0.45;
const DEFAULT_MATCH_TIME_WINDOW_HOURS = 18;
const DEFAULT_PLAYWRIGHT_TIMEOUT_MS = 20_000;

function envValue(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value) {
            return value;
        }
    }
    return undefined;
}

function envEnabled(...names: string[]): boolean {
    return names.some((name) => {
        const value = process.env[name]?.trim().toLowerCase();
        return (
            value === 'true' ||
            value === '1' ||
            value === 'yes' ||
            value === 'on'
        );
    });
}

function envNumber(defaultValue: number, ...names: string[]): number {
    for (const name of names) {
        const value = Number(process.env[name]);
        if (Number.isFinite(value)) {
            return value;
        }
    }
    return defaultValue;
}

export class DaddyLiveProvider extends BaseProvider implements LiveProvider {
    readonly id = 'daddylive';
    readonly name = 'DaddyLive';
    readonly enabled = envEnabled(
        'WATCHPAGE_ENABLED',
        'LIVE_WATCH_ENABLED',
        'DADDYLIVE_ENABLED'
    );
    readonly BASE_URL = this.scheduleUrl()
        ? new URL(this.scheduleUrl()!).origin
        : 'https://daddylive.invalid';
    readonly HEADERS = {
        'User-Agent':
            envValue(
                'WATCHPAGE_USER_AGENT',
                'LIVE_WATCH_USER_AGENT',
                'DADDYLIVE_USER_AGENT'
            ) ??
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['live']
    };

    private scheduleRowsCache?: ScheduleRowsCache;
    private scheduleRowsPromise?: Promise<DaddyLiveScheduleRow[]>;
    private watchResolver?: WatchPageSourceResolver;

    async getMovieSources(): Promise<ProviderResult> {
        return this.emptyResult('DaddyLive only supports live events.');
    }

    async getTVSources(): Promise<ProviderResult> {
        return this.emptyResult('DaddyLive only supports live events.');
    }

    async getLiveEvents(): Promise<ProviderLiveEventCandidate[]> {
        if (
            !envEnabled(
                'WATCHPAGE_DISCOVERY_ENABLED',
                'LIVE_WATCH_DISCOVERY_ENABLED',
                'DADDYLIVE_DISCOVERY_ENABLED'
            )
        ) {
            return [];
        }

        const events = (await this.loadScheduleRows()).map((row) =>
            this.candidateFromScheduleRow(row)
        );

        return this.dedupeEvents(events);
    }

    async matchLiveEvent(
        event: LiveEventManifest
    ): Promise<ProviderLiveEventCandidate | undefined> {
        const rows = await this.loadScheduleRows();
        let best: { row: DaddyLiveScheduleRow; score: number } | undefined;

        for (const row of rows) {
            if (!row.hrefs.length) {
                continue;
            }

            const score = this.matchScore(event, row);
            if (!best || score > best.score) {
                best = { row, score };
            }
        }

        const minimumScore = envNumber(
            DEFAULT_MATCH_MIN_SCORE,
            'WATCHPAGE_MATCH_MIN_SCORE',
            'LIVE_WATCH_MATCH_MIN_SCORE',
            'DADDYLIVE_MATCH_MIN_SCORE'
        );
        if (!best || best.score < minimumScore) {
            return undefined;
        }

        return {
            ...this.candidateFromScheduleRow(best.row),
            title: event.title,
            league: event.league,
            sport: event.sport,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            status: event.status,
            teams: event.teams ?? best.row.teams
        };
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
                this.sourceResolutionEnabled()
                    ? 'Event was discovered from DaddyLive, but no authorized source mapping or watch-page source could be resolved.'
                    : 'Event was discovered from DaddyLive, but no authorized source mapping is configured.'
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

    private async resolveWatchSources(
        event: LiveEventManifest
    ): Promise<ResolvedWatchSource[]> {
        if (!this.sourceResolutionEnabled()) {
            return [];
        }

        const hrefs = event.providers
            .filter((provider) => provider.providerId === this.id)
            .flatMap((provider) => [provider.href, ...(provider.hrefs ?? [])])
            .filter((href): href is string => Boolean(href));

        if (!hrefs.length) {
            return [];
        }

        const resolver = this.getWatchResolver();
        const results = await Promise.allSettled(
            this.unique(hrefs).map((href) => resolver.resolveWatchPage(href))
        );

        for (const result of results) {
            if (result.status === 'rejected') {
                this.console.warn(
                    `Watch-page source resolution failed: ${this.errorMessage(result.reason)}`
                );
            }
        }

        return results.flatMap((result) =>
            result.status === 'fulfilled' ? result.value : []
        );
    }

    private getWatchResolver(): WatchPageSourceResolver {
        this.watchResolver ??= new WatchPageSourceResolver({
            baseUrl: envValue(
                'WATCHPAGE_HEADLESSVIDX_BASE_URL',
                'LIVE_WATCH_HEADLESSVIDX_BASE_URL',
                'DADDYLIVE_HEADLESSVIDX_BASE_URL'
            ),
            cacheTtlSeconds: envNumber(
                30,
                'WATCHPAGE_SOURCE_CACHE_TTL_SECONDS',
                'LIVE_WATCH_SOURCE_CACHE_TTL_SECONDS',
                'DADDYLIVE_SOURCE_CACHE_TTL_SECONDS'
            )
        });

        return this.watchResolver;
    }

    private sourceResolutionEnabled(): boolean {
        return envEnabled(
            'WATCHPAGE_SOURCE_RESOLUTION_ENABLED',
            'LIVE_WATCH_SOURCE_RESOLUTION_ENABLED',
            'DADDYLIVE_SOURCE_RESOLUTION_ENABLED'
        );
    }

    private scheduleUrl(): string | undefined {
        return envValue(
            'WATCHPAGE_URL',
            'WATCHPAGE_PAGE_URL',
            'LIVE_WATCH_PAGE_URL',
            'LIVE_WATCH_SCHEDULE_URL',
            'DADDYLIVE_SCHEDULE_URL'
        );
    }

    private async loadScheduleRows(): Promise<DaddyLiveScheduleRow[]> {
        const now = Date.now();
        if (this.scheduleRowsCache && this.scheduleRowsCache.expiresAt > now) {
            return this.scheduleRowsCache.rows;
        }

        if (!this.scheduleRowsPromise) {
            this.scheduleRowsPromise = this.fetchScheduleRows();
        }

        try {
            const rows = await this.scheduleRowsPromise;
            this.scheduleRowsCache = {
                rows,
                expiresAt:
                    now +
                    envNumber(
                        DEFAULT_SCHEDULE_CACHE_TTL_SECONDS,
                        'WATCHPAGE_CACHE_TTL_SECONDS',
                        'WATCHPAGE_SCHEDULE_CACHE_TTL_SECONDS',
                        'LIVE_WATCH_SCHEDULE_CACHE_TTL_SECONDS',
                        'DADDYLIVE_SCHEDULE_CACHE_TTL_SECONDS'
                    ) *
                        1000
            };
            return rows;
        } finally {
            this.scheduleRowsPromise = undefined;
        }
    }

    private async fetchScheduleRows(): Promise<DaddyLiveScheduleRow[]> {
        const url = this.scheduleUrl();
        if (!url) {
            return [];
        }

        const payload = await this.fetchSchedulePayload(url);
        const events =
            payload.contentType.includes('json') ||
            this.looksLikeJson(payload.body)
                ? this.eventsFromJson(JSON.parse(payload.body))
                : this.eventsFromHtml(payload.body, url);

        return this.dedupeScheduleRows(
            events.map((event) => this.scheduleRowFromCandidate(event))
        );
    }

    private async fetchSchedulePayload(
        url: string
    ): Promise<{ body: string; contentType: string }> {
        if (
            envEnabled(
                'WATCHPAGE_RENDER_WITH_PLAYWRIGHT',
                'LIVE_WATCH_RENDER_WITH_PLAYWRIGHT',
                'DADDYLIVE_RENDER_WITH_PLAYWRIGHT'
            )
        ) {
            return {
                body: await this.renderWithPlaywright(url),
                contentType: 'text/html'
            };
        }

        const response = await fetch(url, {
            headers: this.HEADERS
        });

        if (!response.ok) {
            throw new Error(
                `DaddyLive schedule failed with ${response.status}`
            );
        }

        return {
            body: await response.text(),
            contentType: response.headers.get('content-type') ?? ''
        };
    }

    private async renderWithPlaywright(url: string): Promise<string> {
        const packageName =
            envValue(
                'WATCHPAGE_PLAYWRIGHT_PACKAGE',
                'LIVE_WATCH_PLAYWRIGHT_PACKAGE',
                'DADDYLIVE_PLAYWRIGHT_PACKAGE'
            ) ?? 'playwright-core';
        const timeout = envNumber(
            DEFAULT_PLAYWRIGHT_TIMEOUT_MS,
            'WATCHPAGE_PLAYWRIGHT_TIMEOUT_MS',
            'LIVE_WATCH_PLAYWRIGHT_TIMEOUT_MS',
            'DADDYLIVE_PLAYWRIGHT_TIMEOUT_MS'
        );

        try {
            const { chromium } = await import(packageName);
            const browser = await chromium.launch({
                headless: true,
                executablePath: envValue(
                    'WATCHPAGE_BROWSER_EXECUTABLE_PATH',
                    'LIVE_WATCH_BROWSER_EXECUTABLE_PATH',
                    'DADDYLIVE_BROWSER_EXECUTABLE_PATH'
                ),
                args: ['--no-sandbox', '--disable-dev-shm-usage']
            });
            const page = await browser.newPage({
                userAgent: this.HEADERS['User-Agent']
            });

            try {
                await page.goto(url, {
                    waitUntil: 'networkidle',
                    timeout
                });
                return await page.content();
            } finally {
                await browser.close();
            }
        } catch (error) {
            throw new Error(
                `Watch-page Playwright rendering failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    private candidateFromScheduleRow(
        row: DaddyLiveScheduleRow
    ): ProviderLiveEventCandidate {
        return {
            providerId: this.id,
            internalEventId: row.internalEventId,
            title: row.title,
            league:
                row.league ??
                envValue(
                    'WATCHPAGE_DEFAULT_LEAGUE',
                    'LIVE_WATCH_DEFAULT_LEAGUE',
                    'DADDYLIVE_DEFAULT_LEAGUE'
                ) ??
                'live',
            sport:
                row.sport ??
                envValue(
                    'WATCHPAGE_DEFAULT_SPORT',
                    'LIVE_WATCH_DEFAULT_SPORT',
                    'DADDYLIVE_DEFAULT_SPORT'
                ) ??
                'live',
            startsAt: row.startsAt,
            teams: row.teams,
            href: row.hrefs[0],
            hrefs: row.hrefs,
            sourceCount: row.sourceCount
        };
    }

    private scheduleRowFromCandidate(
        candidate: ProviderLiveEventCandidate
    ): DaddyLiveScheduleRow {
        const hrefs = this.unique([candidate.href, ...(candidate.hrefs ?? [])]);
        return {
            title: candidate.title,
            league: candidate.league,
            sport: candidate.sport,
            startsAt: candidate.startsAt,
            teams: candidate.teams,
            internalEventId:
                candidate.internalEventId ??
                hrefs[0] ??
                `${candidate.title}:${candidate.startsAt ?? ''}`,
            hrefs,
            sourceCount: Math.max(candidate.sourceCount ?? 0, hrefs.length)
        };
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
            league:
                this.firstString(value, [
                    'league',
                    'competition',
                    'category'
                ]) ?? context.league,
            sport:
                this.firstString(value, ['sport', 'sportName']) ?? context.sport
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
            this.firstString(record, [
                'title',
                'event',
                'name',
                'match',
                'fixture'
            ]) ?? this.titleFromTeams(record);

        if (!title || title.length < 4) {
            return undefined;
        }

        const hrefs = this.hrefsFromRecord(record);
        const href =
            this.firstString(record, ['href', 'url', 'link']) ?? hrefs[0];
        const startsAt = this.parseEventDate(
            this.firstString(record, [
                'startsAt',
                'startAt',
                'startTime',
                'datetime',
                'time'
            ]),
            this.firstString(record, ['date', 'eventDate', 'day']) ??
                context.dateLabel
        );
        const internalEventId =
            this.firstScalar(record, [
                'id',
                'eventId',
                'event_id',
                'channelId',
                'channel_id'
            ]) ??
            href ??
            `${title}:${startsAt ?? ''}`;

        return {
            providerId: this.id,
            internalEventId,
            title,
            league:
                this.firstString(record, [
                    'league',
                    'competition',
                    'category'
                ]) ?? context.league,
            sport:
                this.firstString(record, ['sport', 'sportName']) ??
                context.sport ??
                'live',
            startsAt,
            teams: this.teamsFromRecord(record),
            href,
            hrefs,
            sourceCount: Math.max(
                this.sourceCountFromRecord(record),
                hrefs.length
            )
        };
    }

    private eventsFromHtml(
        body: string,
        baseUrl: string
    ): ProviderLiveEventCandidate[] {
        const $ = cheerio.load(body);
        const events: ProviderLiveEventCandidate[] = [];
        const rowSelector = envValue(
            'WATCHPAGE_EVENT_ROW_SELECTOR',
            'LIVE_WATCH_EVENT_ROW_SELECTOR',
            'DADDYLIVE_EVENT_ROW_SELECTOR'
        );
        const rows = rowSelector
            ? $(rowSelector).toArray()
            : this.watchLinkRows($);

        for (const element of rows) {
            const node = $(element);
            const hrefs = this.watchHrefsFromNode($, node, baseUrl);
            const title = this.titleFromHtmlNode($, node);
            if (!title || title.length < 4) {
                continue;
            }

            const hrefValue =
                node.attr('href') ??
                node.attr('data-href') ??
                node.attr('data-url');
            const href = hrefValue
                ? this.normalizeHref(hrefValue, baseUrl)
                : hrefs[0];
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
                league:
                    envValue(
                        'WATCHPAGE_DEFAULT_LEAGUE',
                        'LIVE_WATCH_DEFAULT_LEAGUE',
                        'DADDYLIVE_DEFAULT_LEAGUE'
                    ) ?? 'live',
                sport:
                    envValue(
                        'WATCHPAGE_DEFAULT_SPORT',
                        'LIVE_WATCH_DEFAULT_SPORT',
                        'DADDYLIVE_DEFAULT_SPORT'
                    ) ?? 'live',
                startsAt,
                href,
                hrefs,
                sourceCount: hrefs.length
            });
        }

        return events;
    }

    private watchLinkRows($: cheerio.CheerioAPI): any[] {
        const rowSelector =
            'tr, li, article, section, .event, .event-row, .match, .match-row, .fixture, .fixture-row, .game, .game-row, .card, .panel, .item, .accordion-item';
        const rows: any[] = [];

        $('a[href]').each((_, anchor) => {
            const href = $(anchor).attr('href');
            if (!href || !this.isWatchHref(href)) {
                return;
            }

            const row = $(anchor).closest(rowSelector).get(0) ?? anchor;
            rows.push(row);
        });

        return this.uniqueElements(rows);
    }

    private watchHrefsFromNode(
        $: cheerio.CheerioAPI,
        node: cheerio.Cheerio<any>,
        baseUrl: string
    ): string[] {
        const hrefs: string[] = [];
        const collect = (selection: cheerio.Cheerio<any>) => {
            selection.each((_, element) => {
                const href = $(element).attr('href');
                const normalized = href
                    ? this.normalizeHref(href, baseUrl)
                    : undefined;
                if (normalized && this.isWatchHref(normalized)) {
                    hrefs.push(normalized);
                }
            });
        };

        collect(node);
        collect(node.find('a[href]'));
        return this.unique(hrefs);
    }

    private titleFromHtmlNode(
        $: cheerio.CheerioAPI,
        node: cheerio.Cheerio<any>
    ): string | undefined {
        const attrs = [
            'data-event',
            'data-title',
            'data-name',
            'title',
            'aria-label'
        ];
        for (const attr of attrs) {
            const value = node.attr(attr);
            if (value) {
                return this.cleanEventTitle(value);
            }
        }

        const heading = node
            .find('h1,h2,h3,h4,.title,.event-title,.match-title')
            .first()
            .text();
        if (heading) {
            return this.cleanEventTitle(heading);
        }

        let anchorText: string | undefined;
        node.find('a[href]').each((_, anchor) => {
            if (anchorText) {
                return;
            }

            const text = this.cleanEventTitle($(anchor).text());
            if (text && !/^watch(?:\s+\d+)?$/i.test(text) && text.length >= 4) {
                anchorText = text;
            }
        });

        return anchorText ?? this.cleanEventTitle(node.text());
    }

    private async loadAuthorizedSourceMap(): Promise<AuthorizedSourceMap> {
        const inline = envValue(
            'WATCHPAGE_AUTHORIZED_SOURCE_MAP',
            'LIVE_WATCH_AUTHORIZED_SOURCE_MAP',
            'DADDYLIVE_AUTHORIZED_SOURCE_MAP'
        );
        if (inline) {
            return JSON.parse(inline) as AuthorizedSourceMap;
        }

        const path = envValue(
            'WATCHPAGE_AUTHORIZED_SOURCE_MAP_PATH',
            'LIVE_WATCH_AUTHORIZED_SOURCE_MAP_PATH',
            'DADDYLIVE_AUTHORIZED_SOURCE_MAP_PATH'
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

    private parseEventDate(
        timeValue?: string,
        dateValue?: string
    ): string | undefined {
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

        const offsetMinutes = envNumber(
            0,
            'WATCHPAGE_TIMEZONE_OFFSET_MINUTES',
            'LIVE_WATCH_TIMEZONE_OFFSET_MINUTES',
            'DADDYLIVE_TIMEZONE_OFFSET_MINUTES'
        );
        const utcMs =
            Date.UTC(
                date.getUTCFullYear(),
                date.getUTCMonth(),
                date.getUTCDate(),
                hour,
                minute
            ) -
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

        const match = value.match(
            /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/
        );
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

    private firstString(
        record: JsonRecord,
        keys: string[]
    ): string | undefined {
        for (const key of keys) {
            const value = record[key];
            if (typeof value === 'string' && value.trim()) {
                return this.cleanText(value);
            }
        }
        return undefined;
    }

    private firstScalar(
        record: JsonRecord,
        keys: string[]
    ): string | undefined {
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

    private teamsFromRecord(
        record: JsonRecord
    ): ProviderLiveEventCandidate['teams'] {
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
            return (
                count + (Array.isArray(value) ? value.length : value ? 1 : 0)
            );
        }, 0);
    }

    private hrefsFromRecord(record: JsonRecord): string[] {
        return this.unique(this.hrefsFromUnknown(record));
    }

    private hrefsFromUnknown(value: unknown): string[] {
        if (typeof value === 'string') {
            return this.isWatchHref(value) ? [value] : [];
        }

        if (Array.isArray(value)) {
            return value.flatMap((item) => this.hrefsFromUnknown(item));
        }

        if (!this.isRecord(value)) {
            return [];
        }

        const hrefs: string[] = [];
        for (const [key, child] of Object.entries(value)) {
            if (['href', 'url', 'link', 'watch', 'watchUrl'].includes(key)) {
                hrefs.push(...this.hrefsFromUnknown(child));
                continue;
            }

            if (['links', 'streams', 'sources', 'channels'].includes(key)) {
                hrefs.push(...this.hrefsFromUnknown(child));
            }
        }

        return hrefs;
    }

    private dedupeScheduleRows(
        rows: DaddyLiveScheduleRow[]
    ): DaddyLiveScheduleRow[] {
        const byKey = new Map<string, DaddyLiveScheduleRow>();
        for (const row of rows) {
            const key = [row.internalEventId, row.title, row.startsAt]
                .filter(Boolean)
                .join(':');
            const existing = byKey.get(key);
            if (!existing) {
                byKey.set(key, row);
                continue;
            }

            const hrefs = this.unique([...existing.hrefs, ...row.hrefs]);
            byKey.set(key, {
                ...existing,
                hrefs,
                sourceCount: Math.max(
                    existing.sourceCount,
                    row.sourceCount,
                    hrefs.length
                )
            });
        }

        return Array.from(byKey.values());
    }

    private contextFromContainerKey(
        key: string,
        context: DiscoveryContext
    ): DiscoveryContext {
        const label = this.cleanText(key);
        if (!label || /^\d+$/.test(label)) {
            return context;
        }

        if (
            ['data', 'schedule', 'events', 'result', 'results'].includes(
                label.toLowerCase()
            )
        ) {
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
            /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
                value
            ) ||
            /\b\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\s+\d{4}\b/i.test(value) ||
            /\b\d{4}-\d{2}-\d{2}\b/.test(value)
        );
    }

    private matchScore(
        event: LiveEventManifest,
        row: DaddyLiveScheduleRow
    ): number {
        if (
            row.startsAt &&
            !this.isWithinTimeWindow(event.startsAt, row.startsAt)
        ) {
            return 0;
        }

        const textScore = Math.max(
            ...this.searchQueriesForEvent(event).map((query) =>
                this.textSimilarity(query, row.title)
            )
        );
        const teamScore = this.teamMatchScore(event, row);
        const leagueScore = this.textSimilarity(
            event.league,
            row.league ?? row.title
        );
        const timeScore = row.startsAt ? 0.15 : 0;
        return Math.min(
            1,
            Math.max(textScore, teamScore) + leagueScore * 0.1 + timeScore
        );
    }

    private searchQueriesForEvent(event: LiveEventManifest): string[] {
        const queries = [event.title];
        if (event.teams?.away && event.teams.home) {
            queries.push(`${event.teams.away} vs ${event.teams.home}`);
            queries.push(`${event.teams.home} vs ${event.teams.away}`);
        }

        const withoutSession = event.title
            .replace(
                /\b(?:practice|qualifying|sprint|race|grand prix)\b/gi,
                ' '
            )
            .trim();
        if (withoutSession && withoutSession !== event.title) {
            queries.push(withoutSession);
        }

        return this.unique(queries);
    }

    private teamMatchScore(
        event: LiveEventManifest,
        row: DaddyLiveScheduleRow
    ): number {
        const home = event.teams?.home;
        const away = event.teams?.away;
        if (!home || !away) {
            return 0;
        }

        const rowText = this.normalizeSearchText(row.title);
        return rowText.includes(this.normalizeSearchText(home)) &&
            rowText.includes(this.normalizeSearchText(away))
            ? 0.95
            : 0;
    }

    private textSimilarity(left: string, right: string): number {
        const leftTokens = this.tokens(left);
        const rightTokens = this.tokens(right);
        if (!leftTokens.length || !rightTokens.length) {
            return 0;
        }

        const leftText = leftTokens.join(' ');
        const rightText = rightTokens.join(' ');
        if (leftText.includes(rightText) || rightText.includes(leftText)) {
            return 0.9;
        }

        const rightSet = new Set(rightTokens);
        const intersection = leftTokens.filter((token) =>
            rightSet.has(token)
        ).length;
        const union = new Set([...leftTokens, ...rightTokens]).size;
        return intersection / union;
    }

    private tokens(value: string): string[] {
        const stopWords = new Set([
            'at',
            'the',
            'and',
            'vs',
            'v',
            'live',
            'watch',
            'link',
            'stream',
            'sports',
            'game'
        ]);
        return this.normalizeSearchText(value)
            .split(' ')
            .filter((token) => token.length > 1 && !stopWords.has(token));
    }

    private normalizeSearchText(value: string): string {
        return value
            .toLowerCase()
            .replace(/\bformula\s*(?:1|one)\b/g, 'f1')
            .replace(/\bgrand\s+prix\b/g, 'gp')
            .replace(/\bnew york\b/g, 'ny')
            .replace(/&/g, ' and ')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private isWithinTimeWindow(left: string, right: string): boolean {
        const leftTime = new Date(left).getTime();
        const rightTime = new Date(right).getTime();
        if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
            return true;
        }

        const windowMs =
            envNumber(
                DEFAULT_MATCH_TIME_WINDOW_HOURS,
                'WATCHPAGE_MATCH_TIME_WINDOW_HOURS',
                'LIVE_WATCH_MATCH_TIME_WINDOW_HOURS',
                'DADDYLIVE_MATCH_TIME_WINDOW_HOURS'
            ) *
            60 *
            60 *
            1000;
        return Math.abs(leftTime - rightTime) <= windowMs;
    }

    private normalizeHref(value: string, baseUrl: string): string | undefined {
        try {
            return new URL(value, baseUrl).toString();
        } catch {
            return undefined;
        }
    }

    private isWatchHref(value: string): boolean {
        const patterns = this.csv(
            envValue(
                'WATCHPAGE_HREF_PATTERNS',
                'LIVE_WATCH_HREF_PATTERNS',
                'DADDYLIVE_WATCH_HREF_PATTERNS'
            ) ?? 'watch.php?id=,/watch,/stream,/embed,/play'
        );
        const normalized = value.toLowerCase();
        return patterns.some((pattern) =>
            normalized.includes(pattern.toLowerCase())
        );
    }

    private unique(values: Array<string | undefined>): string[] {
        return Array.from(
            new Set(values.filter((value): value is string => Boolean(value)))
        );
    }

    private uniqueElements(elements: any[]): any[] {
        return Array.from(new Set(elements));
    }

    private csv(value: string): string[] {
        return value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
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

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private looksLikeJson(body: string): boolean {
        const trimmed = body.trim();
        return trimmed.startsWith('{') || trimmed.startsWith('[');
    }

    private isRecord(value: unknown): value is JsonRecord {
        return (
            Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        );
    }

    private cleanText(value: string): string {
        return value.replace(/\s+/g, ' ').trim();
    }

    private cleanEventTitle(value: string): string | undefined {
        const cleaned = this.cleanText(value)
            .replace(/\bwatch\b/gi, ' ')
            .replace(/\blink\s*\d+\b/gi, ' ')
            .replace(/\bchannel\s*\d+\b/gi, ' ')
            .replace(/\bhd\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return cleaned || undefined;
    }

    private stripLeadingTime(value: string): string {
        return value
            .replace(/^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-|:]\s*/i, '')
            .trim();
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
