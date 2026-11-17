import { BaseProvider } from '@omss/framework';
import type {
    LiveEventManifest,
    LiveProvider,
    ProviderCapabilities,
    ProviderLiveEventCandidate,
    ProviderResult,
    Source
} from '@omss/framework';
import { envFlag } from '../../live/live-metadata-provider.js';

type Game = { id: number; external_id: string; status: string };
type Feed = {
    id: number;
    game_id: number;
    title: string;
    status: string;
    order?: number;
};
type Flavor = { id: string; entitlements: unknown; media_event_ids: number[] };
type Snapshot = { games: Game[]; media_events: Feed[]; flavors: Flavor[] };
const SITE = 'https://nhl24all.ir/';
const API = 'https://api.nhl24all.ir/api/v2/generate_stream_info';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' };
const SNAPSHOT_TTL_MS = 30_000;

/** Parse data, never evaluate upstream JavaScript or authenticate to premium feeds. */
export function parseNhl24AllSnapshot(html: string): Snapshot {
    const json = html.match(
        /\bvar\s+stateshot\s*=\s*(\{.*?\});\s*<\/script>/s
    )?.[1];
    if (!json) throw new Error('NHL24ALL schedule data missing');
    const value = JSON.parse(json) as Snapshot;
    if (
        !Array.isArray(value.games) ||
        !Array.isArray(value.media_events) ||
        !Array.isArray(value.flavors)
    ) {
        throw new Error('NHL24ALL schedule schema changed');
    }
    return {
        games: value.games.filter(
            (g) =>
                Number.isSafeInteger(g?.id) &&
                /^\d{10}$/.test(String(g.external_id)) &&
                typeof g.status === 'string'
        ),
        media_events: value.media_events.filter(
            (f) =>
                Number.isSafeInteger(f?.id) &&
                Number.isSafeInteger(f.game_id) &&
                typeof f.status === 'string' &&
                typeof f.title === 'string'
        ),
        flavors: value.flavors.filter(
            (f) => typeof f?.id === 'string' && Array.isArray(f.media_event_ids)
        )
    };
}

export function publicLiveFeeds(
    snapshot: Snapshot,
    gameId: number
): Array<{ feed: Feed; flavor: Flavor }> {
    return snapshot.media_events
        .filter((feed) => feed.game_id === gameId && feed.status === 'L')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id)
        .flatMap((feed) => {
            const flavor = snapshot.flavors.find(
                (f) =>
                    f.entitlements === null &&
                    f.media_event_ids.includes(feed.id)
            );
            return flavor ? [{ feed, flavor }] : [];
        })
        .slice(0, 4);
}

/** Explicit media origin boundary. No arbitrary URL, IP, credential or redirect fetching. */
export function nhl24AllMediaUrl(value: string, base?: string): string {
    const url = new URL(value, base);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !(url.hostname === 'mlb9.com' || url.hostname.endsWith('.mlb9.com'))
    ) {
        throw new Error('NHL24ALL returned an unsupported media host');
    }
    url.hash = '';
    return url.toString();
}

/** Preserve URI boundaries before proxy rewriting, including encryption/rendition tags. */
export function validateNhl24AllPlaylist(text: string, url: string): void {
    if (!text.trimStart().startsWith('#EXTM3U'))
        throw new Error('NHL24ALL did not return HLS');
    // Do not attempt license acquisition or encrypted stream handling for this adapter.
    if (/#EXT-X-(?:SESSION-)?KEY:/.test(text))
        throw new Error('NHL24ALL encrypted feed is unsupported');
    for (const line of text.split(/\r?\n/)) {
        const entry = line.trim();
        if (entry && !entry.startsWith('#')) nhl24AllMediaUrl(entry, url);
        for (const match of entry.matchAll(/\bURI="([^"]+)"/g))
            nhl24AllMediaUrl(match[1], url);
    }
}

export class Nhl24AllProvider extends BaseProvider implements LiveProvider {
    readonly id = 'nhl24all';
    readonly name = 'NHL24ALL';
    readonly enabled = envFlag('NHL24ALL_ENABLED', true);
    readonly BASE_URL = SITE;
    readonly HEADERS = HEADERS;
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['live']
    };
    private snapshot?: { value: Snapshot; expiresAt: number };
    private pendingSnapshot?: Promise<Snapshot>;

    async getMovieSources(): Promise<ProviderResult> {
        return this.empty('NHL24ALL only supports live NHL games.');
    }
    async getTVSources(): Promise<ProviderResult> {
        return this.empty('NHL24ALL only supports live NHL games.');
    }

    // Schedule discovery belongs to NHL Web. Exact NHL IDs avoid fuzzy title/time joins.
    async matchLiveEvent(
        event: LiveEventManifest
    ): Promise<ProviderLiveEventCandidate | undefined> {
        const externalId = this.nhlId(event);
        if (!this.enabled || !externalId) return undefined;
        const snapshot = await this.getSnapshot();
        const game = snapshot.games.find(
            (g) => String(g.external_id) === externalId
        );
        if (!game || ['F', 'P', 'C'].includes(game.status)) return undefined;
        return {
            providerId: this.id,
            internalEventId: `nhl:${externalId}`,
            title: event.title,
            sport: event.sport,
            league: event.league,
            startsAt: event.startsAt,
            teams: event.teams,
            sourceCount: publicLiveFeeds(snapshot, game.id).length
        };
    }

    async getLiveEventSources(
        event: LiveEventManifest
    ): Promise<ProviderResult> {
        if (!this.enabled) return this.empty('NHL24ALL is disabled.');
        const externalId = this.nhlId(event);
        if (!externalId)
            return this.empty('NHL24ALL requires an exact NHL game identity.');
        try {
            const snapshot = await this.getSnapshot();
            const game = snapshot.games.find(
                (g) => String(g.external_id) === externalId
            );
            if (!game || game.status !== 'L')
                return this.empty('This NHL game is not live on NHL24ALL.');
            const feeds = publicLiveFeeds(snapshot, game.id);
            if (!feeds.length)
                return this.empty(
                    'No public live feed is listed for this NHL game.'
                );
            const sources: Source[] = [];
            // Bound upstream concurrency to two; a failed feed must not discard another.
            for (let i = 0; i < feeds.length; i += 2) {
                const results = await Promise.allSettled(
                    feeds
                        .slice(i, i + 2)
                        .map(({ feed, flavor }) =>
                            this.resolveFeed(feed, flavor)
                        )
                );
                for (const result of results)
                    if (result.status === 'fulfilled')
                        sources.push(result.value);
            }
            return sources.length
                ? {
                      sources,
                      subtitles: [],
                      diagnostics:
                          sources.length < feeds.length
                              ? [
                                    {
                                        code: 'PARTIAL_SCRAPE',
                                        message:
                                            'Some NHL24ALL public live feeds are unavailable.',
                                        severity: 'warning',
                                        field: ''
                                    }
                                ]
                              : []
                  }
                : this.empty(
                      'NHL24ALL public live feeds are not ready or could not be validated. Refresh sources to try again.'
                  );
        } catch {
            // Upstream errors/URLs may contain opaque access strings: never log them.
            return this.empty(
                'NHL24ALL is temporarily unavailable. Refresh sources to try again.'
            );
        }
    }

    private nhlId(event: LiveEventManifest): string | undefined {
        return event.providers
            .filter(
                (p) => p.providerId === 'nhlweb' || p.providerId === this.id
            )
            .map((p) => p.internalEventId?.match(/^nhl:(\d{10})$/)?.[1])
            .find(Boolean);
    }

    private async getSnapshot(): Promise<Snapshot> {
        if (this.snapshot && this.snapshot.expiresAt > Date.now())
            return this.snapshot.value;
        if (this.pendingSnapshot) return this.pendingSnapshot;
        this.pendingSnapshot = (async () => {
            const value = parseNhl24AllSnapshot(
                await this.requestText(SITE, 1024 * 1024)
            );
            this.snapshot = { value, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
            return value;
        })();
        try {
            return await this.pendingSnapshot;
        } finally {
            this.pendingSnapshot = undefined;
        }
    }

    private async resolveFeed(feed: Feed, flavor: Flavor): Promise<Source> {
        // No URL cache: each source-cache miss/refresh obtains a fresh upstream URL.
        const response = JSON.parse(
            await this.requestText(API, 16 * 1024, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    media_event_id: feed.id,
                    flavor_id: flavor.id
                })
            })
        ) as { url?: unknown; wait?: unknown };
        if (response.wait || typeof response.url !== 'string')
            throw new Error('Feed warming up');
        const url = nhl24AllMediaUrl(response.url);
        const master = await this.requestText(url, 128 * 1024);
        validateNhl24AllPlaylist(master, url);
        const lines = master.split(/\r?\n/);
        const variantIndex = lines.findIndex((line) =>
            line.startsWith('#EXT-X-STREAM-INF:')
        );
        if (variantIndex >= 0) {
            const variant = nhl24AllMediaUrl(
                lines[variantIndex + 1]?.trim() ?? '',
                url
            );
            const media = await this.requestText(variant, 512 * 1024);
            validateNhl24AllPlaylist(media, variant);
            if (!media.includes('#EXTINF:') || media.includes('#EXT-X-ENDLIST'))
                throw new Error('Not a live media playlist');
        } else if (
            !master.includes('#EXTINF:') ||
            master.includes('#EXT-X-ENDLIST')
        )
            throw new Error('Not a live media playlist');
        const french = /french|français/i.test(feed.title);
        return {
            url: this.createProxyUrl(url, HEADERS),
            type: 'hls',
            // Stable feed identity survives generated URL changes in existing recovery matching.
            quality: `${feed.title} · ${feed.id}`,
            audioTracks: [
                {
                    language: french ? 'fra' : 'eng',
                    label: french ? 'French' : 'English'
                }
            ],
            provider: { id: this.id, name: this.name }
        };
    }

    private async requestText(
        url: string,
        maxBytes: number,
        init: RequestInit = {}
    ): Promise<string> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
            const response = await fetch(url, {
                ...init,
                headers: { ...HEADERS, ...init.headers },
                redirect: 'error',
                signal: controller.signal
            });
            if (!response.ok || !response.body)
                throw new Error('Upstream request failed');
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > maxBytes)
                        throw new Error('Upstream body limit exceeded');
                    chunks.push(value);
                }
            } finally {
                await reader.cancel();
            }
            return Buffer.concat(chunks).toString('utf8');
        } finally {
            clearTimeout(timer);
        }
    }

    private empty(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message,
                    severity: 'warning',
                    field: ''
                }
            ]
        };
    }
}
