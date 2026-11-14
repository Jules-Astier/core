import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import {
    createProviderIdentityCatalog,
    type IdentifiedSource
} from '../../provider-identity.js';
import { globalLeafSwitch } from '../provider-leaf-switches.js';

const LEAF = 'executioner';
const identityCatalog = createProviderIdentityCatalog([
    { id: 'framex', kind: 'aggregator' },
    { id: 'framex:executioner', familyId: 'framex', kind: 'upstream' }
]);
const DUPLICATE_CDNS = new Set([
    'cdn.slowcloud.live',
    'cdn1.slowcloud.live',
    'cdn2.slowcloud.live'
]);
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36';
type Dependencies = { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv };
type WireSource = {
    url?: string;
    type?: string;
    quality?: string;
    server?: string;
};

export class FramexProvider extends BaseProvider {
    readonly id = 'framex';
    readonly name = 'FrameX';
    readonly BASE_URL = 'https://api.framextv.tech';
    readonly HEADERS = {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Referer: 'https://framextv.tech/',
        Origin: 'https://framextv.tech'
    };
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };
    readonly enabled: boolean;
    private readonly fetchImpl: typeof fetch;
    private readonly leafEnabled: boolean;

    constructor(dependencies: Dependencies = {}) {
        super();
        const environment = dependencies.environment ?? process.env;
        this.enabled = environment.FRAMEX_ENABLED === 'true';
        this.fetchImpl = dependencies.fetch ?? fetch;
        const allow = globalLeafSwitch(environment, this.id, 'allow');
        const deny = globalLeafSwitch(environment, this.id, 'deny');
        this.leafEnabled =
            (allow === undefined || allow.has(LEAF)) && !deny?.has(LEAF);
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
        if (!this.leafEnabled)
            return { sources: [], subtitles: [], diagnostics: [] };
        const signal = AbortSignal.timeout(15_000);
        try {
            if (
                !/^\d+$/.test(media.tmdbId) ||
                (media.type === 'tv' &&
                    (!Number.isInteger(media.s) ||
                        !Number.isInteger(media.e) ||
                        media.s! < 1 ||
                        media.e! < 1))
            )
                return this.empty('invalid media identity');
            const url = new URL('/api/stream', this.BASE_URL);
            url.searchParams.set(
                'type',
                media.type === 'movie' ? 'movie' : 'tv'
            );
            url.searchParams.set('id', media.tmdbId);
            url.searchParams.set('provider', LEAF);
            if (media.type === 'tv') {
                url.searchParams.set('season', String(media.s));
                url.searchParams.set('episode', String(media.e));
            }
            const response = await this.fetchImpl(url, {
                headers: this.HEADERS,
                signal
            });
            if (!response.ok)
                return this.empty(`API returned HTTP ${response.status}`);
            const data = (await response.json()) as {
                success?: boolean;
                sources?: WireSource[];
            };
            if (data.success !== true || !Array.isArray(data.sources))
                return this.empty('no sources returned');
            const sources: IdentifiedSource[] = [];
            const seen = new Set<string>();
            let checked = 0;
            for (const candidate of data.sources.slice(0, 8)) {
                if (
                    candidate?.type !== 'hls' ||
                    typeof candidate.url !== 'string'
                )
                    continue;
                const target = playbackTarget(candidate.url);
                if (
                    !target ||
                    DUPLICATE_CDNS.has(new URL(target.url).hostname) ||
                    seen.has(target.url)
                )
                    continue;
                seen.add(target.url);
                if (++checked > 2) break;
                // Certify the primary independent transport only; relay variants and
                // Slowcloud cards are not additional provider coverage.
                const manifest = await this.fetchImpl(target.url, {
                    headers: target.headers,
                    signal
                });
                if (
                    !manifest.ok ||
                    !/^\uFEFF?\s*#EXTM3U(?:\r?\n|$)/.test(await manifest.text())
                )
                    continue;
                sources.push(
                    identityCatalog.identifySource(
                        {
                            url: this.createProxyUrl(
                                target.url,
                                target.headers
                            ),
                            type: 'hls',
                            quality: candidate.quality || 'Auto',
                            audioTracks: [{ language: 'und', label: 'Auto' }]
                        },
                        {
                            familyId: this.id,
                            upstreamId: LEAF,
                            providerName: 'FrameX / Executioner'
                        }
                    )
                );
                break;
            }
            return sources.length
                ? { sources, subtitles: [], diagnostics: [] }
                : this.empty('no independent playable HLS playlist');
        } catch {
            return this.empty('upstream request or response parsing failed');
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
            return (
                response.ok &&
                ((await response.json()) as { status?: string }).status === 'ok'
            );
        } catch {
            return false;
        }
    }
}

export function playbackTarget(
    value: string
): { url: string; headers: Record<string, string> } | null {
    try {
        let url = new URL(value.replace(/\\u0026/g, '&'));
        const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
        for (let depth = 0; depth < 3; depth++) {
            if (
                url.protocol !== 'https:' ||
                url.username ||
                url.password ||
                /[\r\n]/.test(url.href)
            )
                return null;
            const wrapped =
                /^[a-z0-9-]+\.hybrows\.workers\.dev$/.test(url.hostname) ||
                (url.hostname === 'api.framextv.tech' &&
                    url.pathname === '/api/proxy');
            if (!wrapped) return { url: url.href, headers };
            for (const [key, name] of [
                ['origin', 'Origin'],
                ['ref', 'Referer'],
                ['referer', 'Referer']
            ]) {
                const header = url.searchParams.get(key);
                if (header) {
                    if (/[\r\n]/.test(header) || !/^https:\/\//.test(header))
                        return null;
                    headers[name] = header;
                }
            }
            const target = url.searchParams.get('url');
            if (!target) return null;
            url = new URL(target);
        }
        return null;
    } catch {
        return null;
    }
}
