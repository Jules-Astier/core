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
    verifiedMp4
} from '../animation-utils.js';
const ORIGIN = 'https://www.supercartoons.net';
export class SuperCartoonsProvider extends BaseProvider {
    readonly id = 'supercartoons';
    readonly name = 'SuperCartoons';
    readonly BASE_URL = ORIGIN;
    readonly HEADERS = { 'User-Agent': ANIMATION_UA, Referer: ORIGIN + '/' };
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };
    readonly enabled: boolean;
    private readonly fetchImpl: typeof fetch;
    private readonly key: string;
    constructor(
        deps: { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv } = {}
    ) {
        super();
        const env = deps.environment ?? process.env;
        this.enabled = env.SUPERCARTOONS_ENABLED === 'true';
        this.fetchImpl = deps.fetch ?? fetch;
        this.key = env.TMDB_API_KEY ?? '';
    }
    async getMovieSources(media: ProviderMediaObject) {
        return this.resolve(media);
    }
    async getTVSources(media: ProviderMediaObject) {
        return this.resolve(media);
    }
    private async resolve(media: ProviderMediaObject): Promise<ProviderResult> {
        const empty = (reason?: string): ProviderResult => ({
            sources: [],
            subtitles: [],
            diagnostics: reason
                ? [
                      {
                          code: 'PROVIDER_ERROR',
                          field: '',
                          message: 'SuperCartoons: ' + reason,
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
            if (!identity) return empty();
            const search = load(
                await boundedText(
                    this.fetchImpl,
                    new URL(
                        '/?s=' + encodeURIComponent(identity.title),
                        ORIGIN
                    ),
                    ['www.supercartoons.net'],
                    signal,
                    this.HEADERS
                )
            );
            const matches = new Set<string>();
            search('a[href]').each((_, el) => {
                const a = search(el);
                if (titleKey(a.text()) !== titleKey(identity.title)) return;
                const u = new URL(a.attr('href') ?? '', ORIGIN);
                if (
                    u.origin === ORIGIN &&
                    /^\/cartoon\/[a-z0-9-]+\/?$/.test(u.pathname)
                )
                    matches.add(u.href);
            });
            if (matches.size !== 1)
                return empty('no unique exact cartoon-title match');
            const page = load(
                await boundedText(
                    this.fetchImpl,
                    new URL([...matches][0]),
                    ['www.supercartoons.net'],
                    signal,
                    this.HEADERS
                )
            );
            if (
                titleKey(page('h1').first().text()) !== titleKey(identity.title)
            )
                return empty('cartoon title mismatch');
            if (
                identity.seriesTitle &&
                ![...page('a[href]')].some(
                    (a) =>
                        titleKey(page(a).text()) ===
                        titleKey(identity.seriesTitle)
                )
            )
                return empty('series identity mismatch');
            const mediaUrls = new Map<string, string>();
            page('script[type="application/ld+json"]').each((_, el) => {
                try {
                    const parsed = JSON.parse(page(el).text());
                    const rows = Array.isArray(parsed)
                        ? parsed
                        : Array.isArray(parsed['@graph'])
                          ? parsed['@graph']
                          : [parsed];
                    for (const row of rows) {
                        if (
                            row['@type'] !== 'VideoObject' ||
                            typeof row.contentUrl !== 'string'
                        )
                            continue;
                        const u = new URL(row.contentUrl);
                        if (
                            publicHost(u, ['supercartoons.net']) &&
                            /\.mp4$/i.test(u.pathname)
                        )
                            mediaUrls.set(
                                u.href,
                                typeof row.inLanguage === 'string'
                                    ? row.inLanguage
                                    : 'und'
                            );
                    }
                } catch {
                    /* Ignore malformed structured metadata. */
                }
            });
            if (mediaUrls.size !== 1) return empty('no unique public MP4');
            const [url, language] = [...mediaUrls][0];
            if (
                !(await verifiedMp4(
                    this.fetchImpl,
                    new URL(url),
                    ['supercartoons.net'],
                    signal,
                    this.HEADERS
                ))
            )
                return empty('public MP4 verification failed');
            return {
                sources: [
                    {
                        url: this.createProxyUrl(url, this.HEADERS),
                        type: 'mp4',
                        quality: 'Auto',
                        audioTracks: [
                            {
                                language: language.toLowerCase().split('-')[0],
                                label:
                                    language === 'und'
                                        ? 'Audio'
                                        : 'Original audio'
                            }
                        ],
                        provider: { id: this.id, name: this.name }
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
