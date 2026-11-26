import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { load } from 'cheerio';
import {
    ANIMATION_UA,
    animationMetadata,
    boundedText,
    publicHost,
    titleKey,
    titleSlug
} from '../animation-utils.js';
const ORIGIN = 'https://animeav1.com';
const PLAYER = 'https://player.zilla-networks.com';
export class AnimeAv1Provider extends BaseProvider {
    readonly id = 'animeav1';
    readonly name = 'AnimeAV1';
    readonly BASE_URL = ORIGIN;
    readonly HEADERS = { 'User-Agent': ANIMATION_UA, Referer: ORIGIN + '/' };
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['tv']
    };
    readonly enabled: boolean;
    private readonly fetchImpl: typeof fetch;
    private readonly key: string;
    constructor(
        deps: { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv } = {}
    ) {
        super();
        const env = deps.environment ?? process.env;
        this.enabled = (env.ANIMEAV1_ENABLED ?? 'true') === 'true';
        this.key = env.TMDB_API_KEY ?? '';
        this.fetchImpl = deps.fetch ?? fetch;
    }
    async getMovieSources(): Promise<ProviderResult> {
        return { sources: [], subtitles: [], diagnostics: [] };
    }
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        const empty = (reason?: string): ProviderResult => ({
            sources: [],
            subtitles: [],
            diagnostics: reason
                ? [
                      {
                          code: 'PROVIDER_ERROR',
                          field: '',
                          message: 'AnimeAV1: ' + reason,
                          severity: 'warning'
                      }
                  ]
                : []
        });
        const signal = AbortSignal.timeout(20000);
        try {
            const identity = await animationMetadata(
                media,
                this.key,
                this.fetchImpl,
                signal
            );
            if (!identity?.absolute) return empty();
            if (!identity.seriesTitle)
                return empty('canonical TMDB series name unavailable');
            const slug = titleSlug(identity.seriesTitle);
            const path = '/media/' + slug;
            const series = load(
                await boundedText(
                    this.fetchImpl,
                    new URL(path, ORIGIN),
                    ['animeav1.com'],
                    signal,
                    this.HEADERS
                )
            );
            if (
                titleKey(series('h1').first().text()) !==
                titleKey(identity.seriesTitle)
            )
                return empty('series title does not match exactly');
            const page = load(
                await boundedText(
                    this.fetchImpl,
                    new URL(path + '/' + identity.absolute, ORIGIN),
                    ['animeav1.com'],
                    signal,
                    this.HEADERS
                )
            );
            if (
                !new RegExp(
                    '^Episodio\\s+' + identity.absolute + '$',
                    'i'
                ).test(page('h1').first().text().trim())
            )
                return empty('episode identity mismatch');
            const embed = page('iframe[src]').first().attr('src');
            if (!embed) return empty('public HLS player unavailable');
            const u = new URL(embed);
            if (
                u.origin !== PLAYER ||
                !/^\/play\/[a-f0-9]{32}$/.test(u.pathname)
            )
                return empty('unrecognized public player');
            const stream = new URL(
                '/m3u8/' + u.pathname.split('/').pop(),
                PLAYER
            );
            if (!publicHost(stream, ['player.zilla-networks.com']))
                return empty('unrecognized media host');
            const headers = {
                'User-Agent': ANIMATION_UA,
                Referer: u.href,
                Origin: PLAYER
            };
            const master = await boundedText(
                this.fetchImpl,
                stream,
                ['player.zilla-networks.com'],
                signal,
                headers
            );
            if (!master.trimStart().startsWith('#EXTM3U'))
                return empty('HLS verification failed');
            return {
                sources: [
                    {
                        url: this.createProxyUrl(stream.href, headers),
                        type: 'hls',
                        quality: 'Auto',
                        audioTracks: [
                            {
                                language: identity.language,
                                label: 'Original audio · Spanish subtitles'
                            }
                        ],
                        provider: {
                            id: this.id,
                            name: this.name + ' / Spanish subtitles'
                        }
                    }
                ],
                subtitles: [],
                diagnostics: []
            };
        } catch {
            return empty(
                signal.aborted
                    ? 'discovery deadline exceeded'
                    : 'upstream lookup failed or format changed'
            );
        }
    }
}
