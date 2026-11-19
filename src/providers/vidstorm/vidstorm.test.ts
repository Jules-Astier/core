import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import { decodeVidstormUrl, VidstormProvider } from './vidstorm.js';

const contractModulePath = '../../../test/support/provider-contract.js';
const { assertProviderResultContract } = (await import(contractModulePath)) as {
    assertProviderResultContract: (
        result: ProviderResult,
        options: {
            providerId: string;
            allowedTypes?: readonly SourceType[];
            minimumSources?: number;
        }
    ) => void;
};

const movie: ProviderMediaObject = {
    type: 'movie',
    tmdbId: '27205',
    imdbId: 'tt1375666',
    title: 'Inception',
    releaseYear: '2010'
};
const episode: ProviderMediaObject = {
    type: 'tv',
    tmdbId: '260458',
    imdbId: 'tt33049767',
    title: 'Adults',
    releaseYear: '2025',
    s: 1,
    e: 8
};
const helium = 'https://cdn2.ngcloud.tech/demo/master.m3u8?signature=fixture';
const lithium = 'https://cosmicexplorer.xyz/fixture/index.m3u8';

function fixture({
    environment = {},
    response
}: {
    environment?: NodeJS.ProcessEnv;
    response?: Response;
} = {}) {
    const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const provider = new VidstormProvider({
        environment,
        fetch: async (input, init) => {
            requests.push({ url: new URL(String(input)), init });
            return (
                response ??
                Response.json({
                    Helium: { type: 'hls', url: helium, language: 'English' },
                    Lithium: { type: 'hls', url: lithium },
                    Boron: {
                        type: 'hls',
                        url: 'https://vercetti.org/demo.m3u8'
                    },
                    Hydrogen: {
                        type: 'hls',
                        url: 'https://cdn.ngcloud.tech/clip.m3u8'
                    }
                })
            );
        }
    });
    return { provider, requests };
}

test('decodes authenticated public player envelopes using a synthetic key', () => {
    const key = Buffer.alloc(32, 23);
    const iv = Buffer.alloc(12, 1);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const envelope = Buffer.concat([
        iv,
        cipher.update(helium),
        cipher.final(),
        cipher.getAuthTag()
    ]);
    assert.equal(
        decodeVidstormUrl(envelope.toString('base64url'), key)?.href,
        helium
    );
    envelope[envelope.length - 1] ^= 1;
    assert.equal(decodeVidstormUrl(envelope.toString('base64url'), key), null);
});

for (const media of [movie, episode])
    test(`resolves the exact ${media.type} request to attributed HLS`, async () => {
        const { provider, requests } = fixture();
        const result = await (media.type === 'movie'
            ? provider.getMovieSources(media)
            : provider.getTVSources(media));
        assertProviderResultContract(result, {
            providerId: 'vidstorm',
            allowedTypes: ['hls'],
            minimumSources: 1
        });
        assert.deepEqual(
            result.sources.map((source) => source.provider?.id),
            ['vidstorm:helium']
        );
        assert.equal(requests.length, 1);
        assert.equal(
            requests[0].url.pathname,
            media.type === 'movie' ? '/api/movie/27205' : '/api/tv/260458/1/8'
        );
        assert.equal(requests[0].init?.redirect, 'error');
        const proxy = new URL(result.sources[0].url, 'http://localhost:3000');
        assert.deepEqual(JSON.parse(proxy.searchParams.get('data')!), {
            url: helium,
            headers: {
                Origin: 'https://vidstorm.to',
                Referer: 'https://vidstorm.to/'
            }
        });
        assert.equal(result.sources[0].audioTracks[0].language, 'eng');
    });

test('enables VidStorm by default and honours the opt-out and leaf controls', async () => {
    assert.equal(fixture().provider.enabled, true);
    assert.equal(
        fixture({ environment: { VIDSTORM_ENABLED: 'false' } }).provider.enabled,
        false
    );
    const onlyHelium = fixture({
        environment: {
            VIDSTORM_ENABLED: 'true',
            CINEPRO_PROVIDER_LEAF_ALLOWLIST: 'vidstorm:helium'
        }
    });
    assert.equal(onlyHelium.provider.enabled, true);
    const result = await onlyHelium.provider.getTVSources(episode);
    assert.deepEqual(
        result.sources.map((source) => source.provider?.id),
        ['vidstorm:helium']
    );
    const disabled = fixture({
        environment: {
            CINEPRO_PROVIDER_LEAF_DENYLIST: 'vidstorm:helium'
        }
    });
    assert.deepEqual(
        (await disabled.provider.getTVSources(episode)).sources,
        []
    );
    assert.equal(disabled.requests.length, 0);
    const onlyLithium = fixture({
        environment: { CINEPRO_PROVIDER_LEAF_ALLOWLIST: 'vidstorm:lithium' }
    });
    assert.deepEqual(
        (await onlyLithium.provider.getTVSources(episode)).sources,
        []
    );
    assert.equal(onlyLithium.requests.length, 0);
});

test('reports invalid, missing, or untrusted streams without proxying them', async () => {
    for (const response of [
        new Response('blocked', { status: 403 }),
        new Response('<html>not JSON</html>'),
        Response.json(null),
        Response.json({
            Helium: {
                type: 'hls',
                url: 'https://unexpected.example/master.m3u8'
            },
            Lithium: {
                type: 'hls',
                url: lithium
            }
        })
    ]) {
        const { provider } = fixture({ response });
        const result = await provider.getTVSources(episode);
        assert.deepEqual(result.sources, []);
        assert.equal(result.diagnostics[0].code, 'PROVIDER_ERROR');
    }
    const { provider, requests } = fixture();
    assert.equal(
        (await provider.getTVSources({ ...episode, s: -1 })).sources.length,
        0
    );
    assert.equal(requests.length, 0);
});

test('reports an empty Helium slot without an upstream failure', async () => {
    const { provider } = fixture({
        response: Response.json({ Helium: { type: '', url: '' } })
    });
    assert.deepEqual(await provider.getTVSources({ ...episode, e: 9 }), {
        sources: [],
        subtitles: [],
        diagnostics: []
    });
});
