import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { generateRandomUserAgent } from '../../utils/ua.js';
import { TulnexApiResponse } from './tulnex.types.js';
import { decryptPayload } from './decrypt.js';
import { extractUrl } from './tulnex.mapper.js';
import {
    TULNEX_FAMILY_ID,
    TULNEX_LEAVES,
    tulnexIdentityCatalog,
    tulnexUpstreamId,
    type TulnexLeaf
} from './tulnex.identity.js';
import { TULNEX_LEAF_POLICY, type TulnexLeafPolicy } from './tulnex.config.js';

type TulnexDependencies = {
    fetch?: typeof fetch;
    decryptPayload?: typeof decryptPayload;
    leafPolicy?: TulnexLeafPolicy;
};

export class TulnexProvider extends BaseProvider {
    readonly id = 'tulnex';
    readonly name = 'Tulnex';
    readonly enabled = process.env.TULNEX_ENABLED === 'true';

    readonly BASE_URL = 'https://api.tulnex.com';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache'
    };

    readonly SERVERS = TULNEX_LEAVES;

    private readonly fetchImpl: typeof fetch;
    private readonly decryptPayloadImpl: typeof decryptPayload;
    private readonly leafPolicy: TulnexLeafPolicy;

    constructor(dependencies: TulnexDependencies = {}) {
        super();
        this.fetchImpl = dependencies.fetch ?? fetch;
        this.decryptPayloadImpl = dependencies.decryptPayload ?? decryptPayload;
        this.leafPolicy = dependencies.leafPolicy ?? TULNEX_LEAF_POLICY;
    }

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return await this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return await this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        try {
            const results = await Promise.allSettled(
                this.SERVERS.filter((server) =>
                    this.leafPolicy.enabledLeaves.has(server)
                ).map((server) => this.doScrape(server, media))
            );

            const successful = results
                .filter(
                    (
                        r
                    ): r is PromiseFulfilledResult<
                        Awaited<ReturnType<typeof this.doScrape>>
                    > => r.status === 'fulfilled' && r.value != null
                )
                .map((r) => r.value);

            return {
                sources: successful
                    .filter((r) => r !== null)
                    .map((r) =>
                        tulnexIdentityCatalog.identifySource(
                            {
                                url: this.createProxyUrl(
                                    r.stream.url,
                                    r.stream.headers ? r.stream.headers : {}
                                ),
                                type:
                                    r.stream.url.includes('mkv') ||
                                    r.stream.url.includes('mp4')
                                        ? 'mp4'
                                        : 'hls',
                                audioTracks: [
                                    {
                                        label: 'Original',
                                        language: 'Original'
                                    }
                                ],
                                quality: 'Auto'
                            },
                            {
                                familyId: TULNEX_FAMILY_ID,
                                upstreamId: tulnexUpstreamId(r.leaf),
                                providerName: this.name
                            }
                        )
                    ),
                subtitles: [],
                diagnostics: []
            };
        } catch (e) {
            return this.emptyResult(
                e instanceof Error ? e.message : 'Unknown provider error'
            );
        }
    }

    private async doScrape(serverName: TulnexLeaf, media: ProviderMediaObject) {
        const url =
            media.type === 'movie'
                ? this.BASE_URL + '/' + serverName + '/movie/' + media.tmdbId
                : this.BASE_URL +
                  '/' +
                  serverName +
                  '/tv/' +
                  media.tmdbId +
                  '/' +
                  media.s +
                  '/' +
                  media.e;
        const req = await this.fetchImpl(url, {
            headers: { ...this.HEADERS, Accept: 'application/json, */*' }
        });
        if (!req.ok) {
            return null;
        }
        const data = (await req.json()) as unknown as TulnexApiResponse;
        if (data.payload === undefined) {
            return null;
        }
        const decrypted = await this.decryptPayloadImpl(data.payload);
        if (!decrypted) {
            return null;
        }
        const stream = extractUrl(decrypted);
        return stream === null ? null : { leaf: serverName, stream };
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

    async healthCheck(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }
}
