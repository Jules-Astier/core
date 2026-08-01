import type { LiveEventManifest } from '@omss/framework';
import * as cheerio from 'cheerio';

export type WatchPageDiscoveryFailure = {
    pageUrl: string;
    error: string;
};

export type WatchPageDiscoveryResult = {
    links: string[];
    inspectedPages: number;
    matchedRows: number;
    failures: WatchPageDiscoveryFailure[];
};

type WatchPageCandidate = {
    title: string;
    hrefs: string[];
    startsAt?: string;
};

type WatchPagePayload = {
    body: string;
    contentType: string;
};

type WatchPageCacheEntry = WatchPagePayload & {
    expiresAt: number;
};

type WatchPageLinkDiscoveryOptions = {
    headers?: Record<string, string>;
    hrefPatterns?: string[];
    rowSelector?: string;
    matchMinScore?: number;
    timeWindowHours?: number;
    cacheTtlSeconds?: number;
    renderWithPlaywright?: boolean;
    playwrightPackage?: string;
    browserExecutablePath?: string;
    playwrightTimeoutMs?: number;
};

const DEFAULT_ROW_SELECTOR =
    'tr, li, article, section, .event, .event-row, .match, .match-row, .fixture, .fixture-row, .game, .game-row, .card, .panel, .item, .accordion-item';
const DEFAULT_HREF_PATTERNS = [
    'watch',
    'stream',
    'live',
    'embed',
    'event',
    'game'
];
const DEFAULT_MATCH_MIN_SCORE = 0.45;
const DEFAULT_TIME_WINDOW_HOURS = 18;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_PLAYWRIGHT_TIMEOUT_MS = 20_000;

export class WatchPageLinkDiscovery {
    private readonly headers: Record<string, string>;
    private readonly hrefPatterns: string[];
    private readonly rowSelector?: string;
    private readonly matchMinScore: number;
    private readonly timeWindowHours: number;
    private readonly cacheTtlSeconds: number;
    private readonly renderWithPlaywright: boolean;
    private readonly playwrightPackage: string;
    private readonly browserExecutablePath?: string;
    private readonly playwrightTimeoutMs: number;
    private readonly pageCache = new Map<string, WatchPageCacheEntry>();

    constructor(options: WatchPageLinkDiscoveryOptions = {}) {
        this.headers = options.headers ?? {};
        this.hrefPatterns = options.hrefPatterns?.length
            ? options.hrefPatterns
            : DEFAULT_HREF_PATTERNS;
        this.rowSelector = options.rowSelector;
        this.matchMinScore = options.matchMinScore ?? DEFAULT_MATCH_MIN_SCORE;
        this.timeWindowHours =
            options.timeWindowHours ?? DEFAULT_TIME_WINDOW_HOURS;
        this.cacheTtlSeconds =
            options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
        this.renderWithPlaywright = options.renderWithPlaywright ?? false;
        this.playwrightPackage = options.playwrightPackage ?? 'playwright-core';
        this.browserExecutablePath = options.browserExecutablePath;
        this.playwrightTimeoutMs =
            options.playwrightTimeoutMs ?? DEFAULT_PLAYWRIGHT_TIMEOUT_MS;
    }

    async discover(
        event: LiveEventManifest,
        pageUrls: string[]
    ): Promise<WatchPageDiscoveryResult> {
        const inspectedPages = this.unique(pageUrls)
            .map((pageUrl) => this.normalizeHref(pageUrl))
            .filter((pageUrl): pageUrl is string => Boolean(pageUrl));
        const results = await Promise.allSettled(
            inspectedPages.map((pageUrl) => this.discoverPage(event, pageUrl))
        );
        const failures: WatchPageDiscoveryFailure[] = [];
        const links: string[] = [];
        let matchedRows = 0;

        for (const [index, result] of results.entries()) {
            if (result.status === 'rejected') {
                failures.push({
                    pageUrl: inspectedPages[index],
                    error:
                        result.reason instanceof Error
                            ? result.reason.message
                            : String(result.reason)
                });
                continue;
            }

            links.push(...result.value.links);
            matchedRows += result.value.matchedRows;
        }

        return {
            links: this.unique(links),
            inspectedPages: inspectedPages.length,
            matchedRows,
            failures
        };
    }

    private async discoverPage(
        event: LiveEventManifest,
        pageUrl: string
    ): Promise<{ links: string[]; matchedRows: number }> {
        const payload = await this.fetchPage(pageUrl);
        if (
            payload.contentType.includes('json') ||
            this.looksLikeJson(payload.body)
        ) {
            return { links: [], matchedRows: 0 };
        }

        const candidates = this.candidatesFromHtml(payload.body, pageUrl);
        const matches = candidates
            .map((candidate) => ({
                candidate,
                score: this.matchScore(event, candidate)
            }))
            .filter(
                ({ candidate, score }) =>
                    candidate.hrefs.length && score >= this.matchMinScore
            )
            .sort((left, right) => right.score - left.score);

        return {
            links: this.unique(
                matches.flatMap(({ candidate }) => candidate.hrefs)
            ),
            matchedRows: matches.length
        };
    }

    private async fetchPage(pageUrl: string): Promise<WatchPagePayload> {
        const cached = this.pageCache.get(pageUrl);
        const now = Date.now();
        if (cached && cached.expiresAt > now) {
            return cached;
        }

        const payload = this.renderWithPlaywright
            ? {
                  body: await this.renderPage(pageUrl),
                  contentType: 'text/html'
              }
            : await this.fetchStaticPage(pageUrl);

        this.pageCache.set(pageUrl, {
            ...payload,
            expiresAt: now + this.cacheTtlSeconds * 1000
        });

        return payload;
    }

    private async fetchStaticPage(pageUrl: string): Promise<WatchPagePayload> {
        const response = await fetch(pageUrl, { headers: this.headers });
        if (!response.ok) {
            throw new Error(`Watch page failed with ${response.status}`);
        }

        return {
            body: await response.text(),
            contentType: response.headers.get('content-type') ?? ''
        };
    }

    private async renderPage(pageUrl: string): Promise<string> {
        const { chromium } = await import(this.playwrightPackage);
        const browser = await chromium.launch({
            headless: true,
            executablePath: this.browserExecutablePath,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage({
            userAgent: this.headers['User-Agent']
        });

        try {
            await page.goto(pageUrl, {
                waitUntil: 'networkidle',
                timeout: this.playwrightTimeoutMs
            });
            return await page.content();
        } finally {
            await browser.close();
        }
    }

    private candidatesFromHtml(
        body: string,
        baseUrl: string
    ): WatchPageCandidate[] {
        const $ = cheerio.load(body);
        const rows = this.candidateRows($, baseUrl);
        const candidates: WatchPageCandidate[] = [];

        for (const element of rows) {
            const node = $(element);
            const hrefs = this.hrefsFromNode($, node, baseUrl);
            const title = this.titleFromHtmlNode($, node);
            if (!title || title.length < 4 || !hrefs.length) {
                continue;
            }

            candidates.push({
                title,
                hrefs,
                startsAt: this.parseEventDate(
                    node.attr('data-start') ?? node.attr('data-time') ?? title,
                    node.attr('data-date')
                )
            });
        }

        return candidates;
    }

    private candidateRows($: cheerio.CheerioAPI, baseUrl: string): any[] {
        const rows: any[] = [];

        $('a[href]').each((_, anchor) => {
            const href = $(anchor).attr('href');
            const normalized = href
                ? this.normalizeHref(href, baseUrl)
                : undefined;
            if (
                !normalized ||
                !this.isPotentialWatchHref(normalized, baseUrl)
            ) {
                return;
            }

            const row =
                $(anchor)
                    .closest(this.rowSelector ?? DEFAULT_ROW_SELECTOR)
                    .get(0) ?? anchor;
            rows.push(row);
        });

        return this.uniqueElements(rows);
    }

    private hrefsFromNode(
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
                if (
                    normalized &&
                    this.isPotentialWatchHref(normalized, baseUrl)
                ) {
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
        for (const attr of [
            'data-event',
            'data-title',
            'data-name',
            'title',
            'aria-label'
        ]) {
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

    private matchScore(
        event: LiveEventManifest,
        candidate: WatchPageCandidate
    ): number {
        if (
            candidate.startsAt &&
            !this.isWithinTimeWindow(event.startsAt, candidate.startsAt)
        ) {
            return 0;
        }

        const textScore = Math.max(
            ...this.searchQueriesForEvent(event).map((query) =>
                this.textSimilarity(query, candidate.title)
            )
        );
        const teamScore = this.teamMatchScore(event, candidate.title);
        const leagueScore = this.textSimilarity(event.league, candidate.title);
        return Math.min(1, Math.max(textScore, teamScore) + leagueScore * 0.1);
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

    private teamMatchScore(event: LiveEventManifest, title: string): number {
        const home = event.teams?.home;
        const away = event.teams?.away;
        if (!home || !away) {
            return 0;
        }

        const titleText = this.normalizeSearchText(title);
        return titleText.includes(this.normalizeSearchText(home)) &&
            titleText.includes(this.normalizeSearchText(away))
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
            'streams',
            'sports',
            'game',
            'schedule'
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
            .replace(/\bufc\b/g, 'mma')
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

        return (
            Math.abs(leftTime - rightTime) <=
            this.timeWindowHours * 60 * 60 * 1000
        );
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
        return Number.isFinite(direct.getTime())
            ? direct.toISOString()
            : undefined;
    }

    private normalizeHref(value: string, baseUrl?: string): string | undefined {
        try {
            const url = new URL(value, baseUrl);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                return undefined;
            }
            url.hash = '';
            return url.toString();
        } catch {
            return undefined;
        }
    }

    private isPotentialWatchHref(href: string, baseUrl: string): boolean {
        try {
            const url = new URL(href);
            const base = new URL(baseUrl);
            if (url.toString() === base.toString()) {
                return false;
            }
            if (
                /\.(?:css|js|json|png|jpe?g|webp|avif|gif|svg|ico|pdf|xml|txt)$/i.test(
                    url.pathname
                )
            ) {
                return false;
            }
            if (this.isGenericLookupPath(url.pathname)) {
                return false;
            }

            const normalized = `${url.pathname}${url.search}`.toLowerCase();
            return (
                this.hrefPatterns.some((pattern) =>
                    normalized.includes(pattern.toLowerCase())
                ) ||
                (url.hostname === base.hostname &&
                    url.pathname !== '/' &&
                    url.pathname !== base.pathname)
            );
        } catch {
            return false;
        }
    }

    private isGenericLookupPath(pathname: string): boolean {
        return /\/(?:league|category|schedule)\/(?:soccerstreams|nflstreams|nbastreams|wnbastreams|nhlstreams|mmastreams|boxingcasino|ncaa|wwestreams|wwe-aew|f1streams|nfl|nba|wnba|mlb|nhl|cfl|cfb|ncaab|ufc|boxing|soccer|f1|wwe|motogp|mma|boxingstreams2|mmastreams2|nflstreams2|nbastreams2|nhlstreams2|cfbstreams2|ncaastreams|f1streams2|mlb-live-streams|soccer-live-streams)\/?$/i.test(
            pathname
        );
    }

    private cleanText(value: string): string {
        return value.replace(/\s+/g, ' ').trim();
    }

    private cleanEventTitle(value: string): string | undefined {
        const cleaned = this.cleanText(value)
            .replace(/\bwatch\b/gi, ' ')
            .replace(/\blink\s*\d+\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned || undefined;
    }

    private unique(values: Array<string | undefined>): string[] {
        return Array.from(
            new Set(values.filter((value): value is string => Boolean(value)))
        );
    }

    private uniqueElements(elements: any[]): any[] {
        return Array.from(new Set(elements));
    }

    private looksLikeJson(body: string): boolean {
        const trimmed = body.trim();
        return trimmed.startsWith('{') || trimmed.startsWith('[');
    }
}
