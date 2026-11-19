import { BaseProvider } from '@omss/framework';
import type {
    LiveEventManifest,
    LiveProvider,
    ProviderCapabilities,
    ProviderLiveEventCandidate,
    ProviderResult
} from '@omss/framework';
import { load } from 'cheerio';
import { envFlag } from '../../live/live-metadata-provider.js';

const SITE = 'https://slapstreams.com/';
const MEDIA_ORIGINS = new Set([
    'https://webcast-origin.b-cdn.net',
    'https://s3.thegamehd.top'
]);
const USER_AGENT = 'Mozilla/5.0';

function matchesTeam(full: string | undefined, short: string): boolean {
    const normalize = (value: string) =>
        value
            .normalize('NFKD')
            .replace(/\p{Diacritic}/gu, '')
            .replace(/[^a-z0-9 ]/gi, '')
            .trim()
            .toLowerCase();
    const name = normalize(full ?? '');
    const alias = normalize(short);
    return Boolean(alias && (name === alias || name.endsWith(' ' + alias)));
}

export function slapTeamPage(
    html: string,
    event: LiveEventManifest
): string | undefined {
    const startsAt = new Date(event.startsAt);
    if (!Number.isFinite(startsAt.getTime())) return undefined;
    const date = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    }).format(startsAt);
    const $ = load(html);
    const pages = new Set<string>();
    $('td.teamvs a').each((_, link) => {
        const entry = $(link);
        if (entry.find('.mtdate').text().trim() !== date) return;
        const [away, home, extra] = entry
            .clone()
            .find('.mtdate')
            .remove()
            .end()
            .text()
            .split('@');
        if (
            extra !== undefined ||
            !home ||
            !matchesTeam(event.teams?.away, away) ||
            !matchesTeam(event.teams?.home, home)
        )
            return;
        const href = entry.attr('href');
        if (!href) return;
        const page = new URL(href, SITE);
        if (
            page.origin === new URL(SITE).origin &&
            /^\/[a-z0-9-]+-live\/$/.test(page.pathname)
        ) {
            pages.add(new URL(page.pathname, SITE).href);
        }
    });
    return pages.size === 1 ? [...pages][0] : undefined;
}

/**
 * NHL Web's status comes from a cached schedule (NHLWEB_CACHE_TTL_SECONDS,
 * 15 minutes in Saucy), so a game that has just started can still read
 * `scheduled`. Treat it as in play once its start time has passed; ended and
 * postponed games never match.
 */
export function slapEventInPlay(
    event: Pick<LiveEventManifest, 'status' | 'startsAt'>,
    now = Date.now()
): boolean {
    if (event.status === 'live') return true;
    if (event.status !== 'scheduled') return false;
    const startsAt = new Date(event.startsAt).getTime();
    return Number.isFinite(startsAt) && startsAt <= now;
}

function mediaUrl(value: string, base?: string): URL {
    const url = new URL(value, base);
    if (!MEDIA_ORIGINS.has(url.origin) || url.username || url.password) {
        throw new Error('Unexpected SlapStreams media origin');
    }
    return url;
}

async function requestText(
    url: string,
    referer: string,
    cap: number,
    onMediaUrl?: (url: URL) => void
): Promise<string> {
    const init = {
        headers: { 'User-Agent': USER_AGENT, Referer: referer },
        redirect: 'manual' as const,
        signal: AbortSignal.timeout(8_000)
    };
    let response = await fetch(url, init);
    let resolved = new URL(url);
    const redirect = response.headers.get('location');
    if (
        onMediaUrl &&
        response.status >= 300 &&
        response.status < 400 &&
        redirect
    ) {
        await response.body?.cancel();
        resolved = mediaUrl(redirect, url);
        response = await fetch(resolved, init);
    }
    if (onMediaUrl) onMediaUrl(resolved);
    if (!response.ok || !response.body)
        throw new Error('SlapStreams request failed');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > cap) throw new Error('SlapStreams response too large');
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        await reader.cancel();
    }
}

export class SlapStreamsProvider extends BaseProvider implements LiveProvider {
    readonly id = 'slapstreams';
    readonly name = 'SlapStreams';
    readonly enabled = envFlag('SLAPSTREAMS_ENABLED', false);
    readonly BASE_URL = SITE;
    readonly HEADERS = { 'User-Agent': USER_AGENT };
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['live']
    };

    async getMovieSources(): Promise<ProviderResult> {
        return { sources: [], subtitles: [], diagnostics: [] };
    }
    async getTVSources(): Promise<ProviderResult> {
        return { sources: [], subtitles: [], diagnostics: [] };
    }

    async matchLiveEvent(
        event: LiveEventManifest
    ): Promise<ProviderLiveEventCandidate | undefined> {
        const identity = event.providers.find(
            (p) => p.providerId === 'nhlweb'
        )?.internalEventId;
        if (
            !this.enabled ||
            !slapEventInPlay(event) ||
            !/^nhl:\d{10}$/.test(identity ?? '')
        )
            return;
        try {
            const page = slapTeamPage(
                await requestText(SITE, SITE, 512 * 1024),
                event
            );
            if (page)
                return {
                    providerId: this.id,
                    internalEventId: identity,
                    title: event.title,
                    startsAt: event.startsAt,
                    teams: event.teams,
                    league: event.league,
                    href: page,
                    sourceCount: 1
                };
        } catch {
            // Public listing may be unavailable. Do not retry access denials.
        }
    }

    async getLiveEventSources(
        event: LiveEventManifest
    ): Promise<ProviderResult> {
        const empty = { sources: [], subtitles: [], diagnostics: [] };
        try {
            const match = await this.matchLiveEvent(event);
            if (!match?.href) return empty;
            const $ = load(await requestText(match.href, SITE, 512 * 1024));
            const frames = $('iframe[src]')
                .toArray()
                .flatMap((frame) => {
                    const src = $(frame).attr('src');
                    if (!src) return [];
                    const url = new URL(src, SITE);
                    return url.origin === new URL(SITE).origin &&
                        /^\/stream\/(?!hd\.html$)[a-z0-9-]+\.html$/.test(
                            url.pathname
                        )
                        ? [url]
                        : [];
                });
            if (frames.length !== 1) return empty;
            const frame = frames[0];
            const player = await requestText(frame.href, match.href, 64 * 1024);
            const config =
                /\bvar\s+_d\s*=\s*\[(\d+),'(\d+)','([a-f0-9]+)'\]/i.exec(
                    player
                );
            if (!config) return empty;
            const endpoint = new URL('check_stream.php', frame);
            endpoint.search = new URLSearchParams({
                id: config[1],
                ts: config[2],
                pt: config[3]
            }).toString();
            const raw = JSON.parse(
                await requestText(endpoint.href, frame.href, 16 * 1024)
            );
            if (typeof raw.url !== 'string') return empty;
            let stream = mediaUrl(raw.url);
            const playlist = await requestText(
                stream.href,
                frame.href,
                512 * 1024,
                (url) => {
                    stream = url;
                }
            );
            if (
                !playlist.startsWith('#EXTM3U') ||
                !playlist.includes('#EXTINF:') ||
                /#EXT-X-(?:ENDLIST|(?:SESSION-)?KEY):?/.test(playlist)
            )
                return empty;
            for (const line of playlist.split(/\r?\n/)) {
                const value = line.trim();
                if (value && !value.startsWith('#'))
                    mediaUrl(value, stream.href);
                for (const match of value.matchAll(/\bURI="([^"]+)"/g))
                    mediaUrl(match[1], stream.href);
            }
            return {
                sources: [
                    {
                        url: this.createProxyUrl(stream.href, {
                            ...this.HEADERS,
                            Referer: frame.href
                        }),
                        type: 'hls',
                        quality: 'Auto',
                        audioTracks: [],
                        provider: { id: this.id, name: this.name }
                    }
                ],
                subtitles: [],
                diagnostics: []
            };
        } catch {
            return empty;
        }
    }
}
