import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';

type Dependencies = { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv };
export type ManifestAudioEvidence = {
    language: string;
    label: string;
    original: true | null;
    uri?: string;
};
export type PapadustreamManifest = {
    audio: ManifestAudioEvidence[];
    subtitleLanguages: string[];
    quality: string;
};
const DEFAULT_ORIGIN = 'https://www.papadustream.club';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36';
const VALID_IMDB = /^tt\d+$/;
const HLS_PATH =
    /^\/hls\/(?:p\/\d+\/[A-Za-z0-9_-]+\/)?s\d+\/(?:serial|movie)\/tt\d+\/(?:\d+\/\d+\/)?playlist\.m3u8$/;

export class PapadustreamProvider extends BaseProvider {
    readonly id = 'papadustream';
    readonly name = 'Papadustream';
    readonly BASE_URL: string;
    readonly HEADERS: Record<string, string>;
    readonly enabled: boolean;
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };
    private readonly fetchImpl: typeof fetch;

    constructor(dependencies: Dependencies = {}) {
        super();
        const environment = dependencies.environment ?? process.env;
        const base = new URL(
            environment.PAPADUSTREAM_BASE_URL ?? DEFAULT_ORIGIN
        );
        if (
            base.protocol !== 'https:' ||
            base.username ||
            base.password ||
            base.search ||
            base.hash ||
            base.pathname !== '/'
        )
            throw new TypeError(
                'PAPADUSTREAM_BASE_URL must be an HTTPS origin'
            );
        this.BASE_URL = base.origin;
        this.enabled = environment.PAPADUSTREAM_ENABLED === 'true';
        this.HEADERS = {
            'User-Agent': USER_AGENT,
            Referer: `${this.BASE_URL}/`,
            Origin: this.BASE_URL
        };
        this.fetchImpl = dependencies.fetch ?? fetch;
    }

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        if (!VALID_IMDB.test(media.imdbId ?? ''))
            return this.empty('an exact IMDb identity is required');
        if (
            media.type === 'tv' &&
            (!Number.isInteger(media.s) ||
                !Number.isInteger(media.e) ||
                media.s! < 1 ||
                media.e! < 1)
        )
            return this.empty('invalid season or episode');
        const signal = AbortSignal.timeout(18_000);
        const path = `/${media.type === 'movie' ? 'films' : 'series'}/${media.imdbId}`;
        const pageUrl = new URL(path, this.BASE_URL);
        try {
            // Public pages supply short-lived media URLs; refresh at most once
            // after an expired/unavailable playlist, never reuse a captured token.
            for (let attempt = 0; attempt < 2; attempt++) {
                const page = await this.fetchImpl(pageUrl, {
                    headers: {
                        ...this.HEADERS,
                        Accept: 'text/html',
                        'Cache-Control': 'no-cache'
                    },
                    signal
                });
                if (!page.ok)
                    return this.empty(`page returned HTTP ${page.status}`);
                const playlistPath = extractPapadustreamPlaylist(
                    await page.text(),
                    media
                );
                if (!playlistPath)
                    return this.empty(
                        'the exact movie or episode was not found'
                    );
                const playlistUrl = new URL(playlistPath, this.BASE_URL);
                if (
                    playlistUrl.origin !== this.BASE_URL ||
                    !HLS_PATH.test(playlistUrl.pathname)
                )
                    return this.empty('unexpected playlist origin or path');
                const headers = {
                    ...this.HEADERS,
                    Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
                    Referer: pageUrl.href
                };
                const response = await this.fetchImpl(playlistUrl, {
                    headers,
                    signal
                });
                if (!response.ok) continue;
                const manifest = parsePapadustreamManifest(
                    await response.text()
                );
                if (!manifest) continue;
                const frenchOriginal = manifest.audio
                    .filter(
                        (track) =>
                            ['fr', 'fra', 'fre'].includes(
                                track.language.split('-')[0]
                            ) &&
                            track.original === true &&
                            !/audio[ -]?description/i.test(track.label)
                    )
                    .sort(
                        (a, b) =>
                            Number(/stereo/i.test(b.label)) -
                            Number(/stereo/i.test(a.label))
                    )[0];
                const audio = frenchOriginal
                    ? [
                          frenchOriginal,
                          ...manifest.audio.filter(
                              (track) => track !== frenchOriginal
                          )
                      ]
                    : manifest.audio;
                return {
                    sources: [
                        {
                            url: this.createProxyUrl(
                                playlistUrl.href,
                                headers,
                                {
                                    preferredAudioLanguage: frenchOriginal
                                        ? 'fr'
                                        : undefined
                                }
                            ),
                            type: 'hls',
                            quality: manifest.quality,
                            audioTracks: audio.length
                                ? audio.map(({ language, label }) => ({
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
            }
            return this.empty('no current HLS playlist was returned');
        } catch {
            return this.empty('upstream request or playlist parsing failed');
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

    async healthCheck(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(this.BASE_URL, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(5_000)
            });
            return response.ok && /Papadustream/i.test(await response.text());
        } catch {
            return false;
        }
    }
}

export function extractPapadustreamPlaylist(
    html: string,
    media: Pick<ProviderMediaObject, 'type' | 'imdbId' | 's' | 'e'>
): string | null {
    if (!VALID_IMDB.test(media.imdbId ?? '')) return null;
    if (media.type === 'movie') {
        const matches =
            html.match(
                /\/hls\/(?:p\/\d+\/[A-Za-z0-9_-]+\/)?s\d+\/movie\/tt\d+\/playlist\.m3u8/g
            ) ?? [];
        return (
            matches.find((path) => path.includes(`/movie/${media.imdbId}/`)) ??
            null
        );
    }
    const match = /\bEPISODES\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
    if (!match) return null;
    try {
        const episodes = JSON.parse(match[1]) as unknown;
        if (!Array.isArray(episodes)) return null;
        const target = episodes.find((entry: unknown) => {
            if (!entry || typeof entry !== 'object') return false;
            const record = entry as Record<string, unknown>;
            return (
                Number(record.season) === media.s &&
                Number(record.episode) === media.e &&
                typeof record.url === 'string' &&
                record.url.includes(
                    `/serial/${media.imdbId}/${media.s}/${media.e}/`
                )
            );
        }) as { url: string } | undefined;
        return target?.url ?? null;
    } catch {
        return null;
    }
}

function attributes(line: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const match of line.matchAll(
        /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g
    )) {
        const value = match[2];
        result[match[1]] = value.startsWith('"')
            ? value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
            : value;
    }
    return result;
}

export function parsePapadustreamManifest(
    text: string
): PapadustreamManifest | null {
    if (!/^\uFEFF?\s*#EXTM3U(?:\r?\n|$)/.test(text)) return null;
    const audio: ManifestAudioEvidence[] = [];
    const subtitles = new Set<string>();
    let height = 0;
    let hasMedia = false;
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) hasMedia = true;
        if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
            const resolution =
                attributes(trimmed).RESOLUTION?.match(/^\d+x(\d+)$/);
            if (resolution) height = Math.max(height, Number(resolution[1]));
        }
        if (!trimmed.startsWith('#EXT-X-MEDIA:')) continue;
        const attrs = attributes(trimmed);
        const language = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(
            attrs.LANGUAGE ?? ''
        )
            ? attrs.LANGUAGE.toLowerCase()
            : 'und';
        if (attrs.TYPE === 'AUDIO')
            audio.push({
                language,
                label:
                    attrs.NAME ||
                    (language === 'und' ? 'Unknown audio' : language),
                original: /\[original\]/i.test(attrs.NAME ?? '') ? true : null,
                ...(attrs.URI ? { uri: attrs.URI } : {})
            });
        if (attrs.TYPE === 'SUBTITLES' && language !== 'und')
            subtitles.add(language);
    }
    return hasMedia
        ? {
              audio,
              subtitleLanguages: [...subtitles],
              quality: height ? `${height}p` : 'Auto'
          }
        : null;
}
