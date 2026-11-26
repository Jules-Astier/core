import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { parsePapadustreamManifest } from '../papadustream/papadustream.js';

const PLAYER_ROUTE = '/public-player/hydravip';
const MEDIA_ROUTE = `${PLAYER_ROUTE}/media`;
const HLS_ACCEPT = 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*';
const RESOLVER_DEADLINE_MS = 24_000;
const MAX_PLAYLIST_URL_LENGTH = 8 * 1024;

type Dependencies = { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv };
type SeriesDetails = { id?: unknown; name?: unknown; first_air_date?: unknown };
type PlayerResponse = { status?: unknown; playlistUrl?: unknown };

class HydraVipError extends Error {}

export class HydraVipProvider extends BaseProvider {
    readonly id = 'hydravip';
    readonly name = 'HydraVip';
    readonly BASE_URL = 'https://hydrahd.gd';
    readonly HEADERS = {};
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['tv']
    };
    readonly enabled: boolean;

    private readonly fetchImpl: typeof fetch;
    private readonly tmdbApiKey?: string;
    private readonly playerOrigin?: string;

    constructor(dependencies: Dependencies = {}) {
        super();
        const environment = dependencies.environment ?? process.env;
        this.enabled = environment.HYDRAVIP_ENABLED === 'true';
        this.tmdbApiKey = environment.TMDB_API_KEY;
        this.playerOrigin = environment.HYDRAVIP_HEADLESSVIDX_BASE_URL;
        this.fetchImpl = dependencies.fetch ?? fetch;
    }

    async getMovieSources(): Promise<ProviderResult> {
        return { sources: [], subtitles: [], diagnostics: [] };
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        const { tmdbId, s: season, e: episode } = media;
        if (
            media.type !== 'tv' ||
            !/^[1-9]\d{0,9}$/.test(tmdbId) ||
            season === undefined ||
            episode === undefined ||
            !Number.isInteger(season) ||
            !Number.isInteger(episode) ||
            season < 0 ||
            season > 9999 ||
            episode < 1 ||
            episode > 9999
        ) {
            return this.empty(
                'a valid TMDB series, season and episode are required'
            );
        }

        const player = this.playerOrigin && URL.parse(this.playerOrigin);
        if (
            !player ||
            !['http:', 'https:'].includes(player.protocol) ||
            player.username ||
            player.password ||
            player.pathname !== '/' ||
            player.search ||
            player.hash
        ) {
            return this.empty(
                'HYDRAVIP_HEADLESSVIDX_BASE_URL must be a service origin'
            );
        }
        if (!this.tmdbApiKey) return this.empty('TMDB_API_KEY is required');

        const signal = AbortSignal.timeout(RESOLVER_DEADLINE_MS);
        try {
            const series = new URL(`https://api.themoviedb.org/3/tv/${tmdbId}`);
            series.searchParams.set('api_key', this.tmdbApiKey);
            const details = JSON.parse(
                await this.read(series, signal, 256 * 1024)
            ) as SeriesDetails | null;
            const seriesTitle =
                typeof details?.name === 'string' ? details.name.trim() : '';
            const date =
                typeof details?.first_air_date === 'string' &&
                /^\d{4}-\d{2}-\d{2}$/.test(details.first_air_date)
                    ? details.first_air_date
                    : '';
            if (
                String(details?.id) !== tmdbId ||
                !seriesTitle ||
                seriesTitle.length > 200 ||
                !Number.isFinite(Date.parse(date))
            ) {
                return this.empty('canonical TMDB series metadata is missing');
            }

            const resolved = JSON.parse(
                await this.read(
                    new URL(PLAYER_ROUTE, player),
                    signal,
                    24 * 1024,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            tmdbId,
                            seriesTitle,
                            firstAirYear: Number(date.slice(0, 4)),
                            season,
                            episode
                        })
                    }
                )
            ) as PlayerResponse | null;
            if (resolved?.status !== 'resolved') {
                return this.empty(
                    resolved?.status === 'not-found'
                        ? 'the exact episode was not found'
                        : resolved?.status === 'blocked'
                          ? 'the public player was blocked'
                          : 'the public player did not resolve a source'
                );
            }
            const masterUrl = resolved.playlistUrl;
            if (
                typeof masterUrl !== 'string' ||
                !isSheguResource(masterUrl) ||
                URL.parse(masterUrl)?.hostname !== 'hls.shegu.net'
            ) {
                return this.empty(
                    'the public player returned an unexpected playlist URL'
                );
            }

            const relay = new URL(MEDIA_ROUTE, player);
            relay.searchParams.set('url', masterUrl);
            const headers = { Accept: HLS_ACCEPT };
            const body = await this.read(relay, signal, 512 * 1024, {
                headers
            });
            const manifest = parsePapadustreamManifest(body);
            if (!manifest || !isRelayedVideoMaster(body, relay)) {
                return this.empty(
                    'the media relay did not return a valid video master'
                );
            }

            return {
                sources: [
                    {
                        url: this.createProxyUrl(relay.href, headers),
                        type: 'hls',
                        quality: manifest.quality,
                        audioTracks:
                            manifest.audio.length > 0
                                ? manifest.audio.map(({ language, label }) => ({
                                      language,
                                      label
                                  }))
                                : [{ language: 'und', label: 'Unknown audio' }],
                        provider: { id: this.id, name: this.name }
                    }
                ],
                subtitles: [],
                diagnostics: []
            };
        } catch (error) {
            return this.empty(
                error instanceof HydraVipError
                    ? error.message
                    : 'the public player or media relay was unavailable'
            );
        }
    }

    private async read(
        url: URL,
        signal: AbortSignal,
        limit: number,
        init?: RequestInit
    ) {
        const response = await this.fetchImpl(url, {
            ...init,
            redirect: 'error',
            signal
        });
        if (!response.ok || !response.body) {
            await response.body?.cancel().catch(() => undefined);
            if ([401, 403, 429].includes(response.status)) {
                throw new HydraVipError(
                    `upstream request was blocked (${response.status})`
                );
            }
            throw new HydraVipError('upstream response was unavailable');
        }
        if (Number(response.headers.get('content-length')) > limit) {
            await response.body.cancel().catch(() => undefined);
            throw new HydraVipError('upstream response was too large');
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return Buffer.concat(chunks, size).toString('utf8');
                size += value.byteLength;
                if (size > limit)
                    throw new HydraVipError('upstream response was too large');
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
    }

    private empty(message: string): ProviderResult {
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

function isSheguResource(value: string): boolean {
    const url =
        value.length <= MAX_PLAYLIST_URL_LENGTH && /^[\x21-\x7e]+$/.test(value)
            ? URL.parse(value)
            : null;
    return Boolean(
        url &&
        url.protocol === 'https:' &&
        url.hostname.endsWith('.shegu.net') &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.hash
    );
}

function isRelayedVideoMaster(text: string, relay: URL): boolean {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const hasVideo = lines.some(
        (line, index) =>
            line.startsWith('#EXT-X-STREAM-INF:') &&
            (/\bRESOLUTION=[1-9]\d*x[1-9]\d*/.test(line) ||
                /\bCODECS="[^"]*(?:avc[13]|hev1|hvc1|dvhe|dvh1|vp09|av01)\./i.test(
                    line
                )) &&
            Boolean(lines[index + 1] && !lines[index + 1].startsWith('#'))
    );
    const targets = lines
        .filter(Boolean)
        .flatMap((line) =>
            line.startsWith('#')
                ? Array.from(
                      line.matchAll(/\bURI\s*=\s*["']([^"']+)["']/gi),
                      (match) => match[1]
                  )
                : [line]
        );
    return (
        hasVideo &&
        targets.every((target) => {
            const url = URL.parse(target, relay);
            if (
                !url ||
                url.origin !== relay.origin ||
                url.pathname !== MEDIA_ROUTE ||
                url.username ||
                url.password ||
                url.hash
            )
                return false;
            const urls = url.searchParams.getAll('url');
            return (
                urls.length === 1 &&
                [...url.searchParams.keys()].length === 1 &&
                isSheguResource(urls[0])
            );
        })
    );
}
