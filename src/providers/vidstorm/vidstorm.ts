import { createDecipheriv } from 'node:crypto';
import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { createProviderIdentityCatalog } from '../../provider-identity.js';
import { globalLeafSwitch } from '../provider-leaf-switches.js';

const ORIGIN = 'https://vidstorm.to';
// The anonymous player publishes this AES-GCM envelope key in its JavaScript.
const PUBLIC_ENVELOPE_KEY = Buffer.from(
    '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f',
    'hex'
);
const MEDIA_HEADERS = { Origin: ORIGIN, Referer: `${ORIGIN}/` };
const UPSTREAM_ID = 'helium';
const MANIFEST_HOST = 'cdn2.ngcloud.tech';
const identityCatalog = createProviderIdentityCatalog([
    { id: 'vidstorm', kind: 'aggregator' },
    {
        id: `vidstorm:${UPSTREAM_ID}`,
        familyId: 'vidstorm',
        kind: 'upstream'
    }
]);

type WireSource = { type?: string; url?: string; language?: string };
type Dependencies = { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv };

export function decodeVidstormUrl(
    value: string,
    key = PUBLIC_ENVELOPE_KEY
): URL | null {
    try {
        if (/^https:/i.test(value)) return new URL(value);
        if (!/^[\w-]+={0,2}$/.test(value) || value.length > 8192) return null;
        const envelope = Buffer.from(value, 'base64url');
        if (envelope.length < 29) return null;
        const iv = envelope.subarray(0, 12);
        const tag = envelope.subarray(-16);
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return new URL(
            Buffer.concat([
                decipher.update(envelope.subarray(12, -16)),
                decipher.final()
            ]).toString('utf8')
        );
    } catch {
        return null;
    }
}

export class VidstormProvider extends BaseProvider {
    readonly id = 'vidstorm';
    readonly name = 'VidStorm';
    readonly BASE_URL = ORIGIN;
    readonly HEADERS = { ...MEDIA_HEADERS, Accept: 'application/json' };
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };
    readonly enabled: boolean;
    private readonly fetchImpl: typeof fetch;
    private readonly heliumAllowed: boolean;

    constructor(dependencies: Dependencies = {}) {
        super();
        const environment = dependencies.environment ?? process.env;
        this.enabled = (environment.VIDSTORM_ENABLED ?? 'true') === 'true';
        this.fetchImpl = dependencies.fetch ?? fetch;
        const allow = globalLeafSwitch(environment, this.id, 'allow');
        const deny = globalLeafSwitch(environment, this.id, 'deny');
        this.heliumAllowed =
            (allow === undefined || allow.has(UPSTREAM_ID)) &&
            !deny?.has(UPSTREAM_ID);
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
        const { tmdbId, type, s, e } = media;
        if (!this.heliumAllowed)
            return { sources: [], subtitles: [], diagnostics: [] };
        if (
            !/^\d+$/.test(tmdbId) ||
            (type === 'tv' &&
                (!Number.isSafeInteger(s) ||
                    !Number.isSafeInteger(e) ||
                    s! < 0 ||
                    e! < 0))
        )
            return this.empty('invalid media identity');

        const path =
            type === 'tv'
                ? `/api/tv/${tmdbId}/${s}/${e}`
                : `/api/movie/${tmdbId}`;
        try {
            const response = await this.fetchImpl(new URL(path, ORIGIN), {
                headers: this.HEADERS,
                redirect: 'error',
                signal: AbortSignal.timeout(12_000)
            });
            if (!response.ok)
                return this.empty(`API returned HTTP ${response.status}`);
            const payload = (await response.json()) as {
                Helium?: WireSource;
            } | null;
            const row = payload?.Helium;
            if (row?.type === '' && row.url === '')
                return { sources: [], subtitles: [], diagnostics: [] };
            if (row?.type !== 'hls' || typeof row.url !== 'string')
                return this.empty('no supported HLS source for this identity');
            const url = decodeVidstormUrl(row.url);
            if (
                !url ||
                url.protocol !== 'https:' ||
                url.username ||
                url.password ||
                url.port ||
                url.hostname !== MANIFEST_HOST ||
                !url.pathname.toLowerCase().endsWith('.m3u8')
            )
                return this.empty('no supported HLS source for this identity');

            const audio =
                typeof row.language === 'string' ? row.language.trim() : '';
            return {
                sources: [
                    identityCatalog.identifySource(
                        {
                            url: this.createProxyUrl(url.href, MEDIA_HEADERS),
                            type: 'hls',
                            quality: 'Auto',
                            audioTracks: [
                                {
                                    language:
                                        audio.toLowerCase() === 'english'
                                            ? 'eng'
                                            : 'und',
                                    label: audio || 'Unknown audio'
                                }
                            ]
                        },
                        {
                            familyId: this.id,
                            upstreamId: UPSTREAM_ID,
                            providerName: 'VidStorm / Helium'
                        }
                    )
                ],
                subtitles: [],
                diagnostics: []
            };
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
                    field: '',
                    message: `${this.name}: ${message}`,
                    severity: 'error'
                }
            ]
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(ORIGIN, {
                redirect: 'error',
                signal: AbortSignal.timeout(5000)
            });
            return response.ok && /vidstorm/i.test(await response.text());
        } catch {
            return false;
        }
    }
}
