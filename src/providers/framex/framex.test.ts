import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import { FramexProvider, playbackTarget } from './framex.js';
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

const movie = {
    type: 'movie',
    tmdbId: '603',
    title: 'The Matrix',
    releaseYear: '1999'
} as ProviderMediaObject;
const episode = {
    type: 'tv',
    tmdbId: '208921',
    title: 'Rivals',
    releaseYear: '2024',
    s: 1,
    e: 1
} as ProviderMediaObject;
const target = 'https://media.example.test/master.m3u8?token=synthetic';
function wrapper(url: string) {
    return (
        'https://frappe.hybrows.workers.dev/?' +
        new URLSearchParams({
            url,
            origin: 'https://vidrock.to',
            ref: 'https://vidrock.to/'
        })
            .toString()
            .replace(/&/g, '\\u0026')
    );
}
function fixture(
    options: {
        environment?: NodeJS.ProcessEnv;
        sources?: unknown[];
        status?: number;
        body?: string;
    } = {}
) {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const provider = new FramexProvider({
        environment: options.environment ?? { FRAMEX_ENABLED: 'true' },
        fetch: async (input, init) => {
            const url = new URL(String(input));
            requests.push({ url, init });
            if (url.pathname === '/api/stream')
                return options.status
                    ? new Response('unavailable', { status: options.status })
                    : Response.json({
                          success: true,
                          sources: options.sources ?? [
                              {
                                  url: wrapper(
                                      'https://cdn2.slowcloud.live/duplicate.m3u8'
                                  ),
                                  type: 'hls'
                              },
                              {
                                  url: wrapper(target),
                                  type: 'hls',
                                  quality: 'Auto'
                              },
                              { url: wrapper(target), type: 'hls' }
                          ]
                      });
            return new Response(
                options.body ??
                    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nvideo.m3u8\n'
            );
        }
    });
    return { provider, requests };
}

for (const media of [movie, episode])
    test(`resolves ${media.type} identity into independent direct HLS with leaf attribution`, async () => {
        const f = fixture();
        const result = await (media.type === 'movie'
            ? f.provider.getMovieSources(media)
            : f.provider.getTVSources(media));
        assertProviderResultContract(result, {
            providerId: 'framex',
            allowedTypes: ['hls'],
            minimumSources: 1
        });
        assert.equal(result.sources.length, 1);
        const query = f.requests[0].url.searchParams;
        assert.equal(query.get('provider'), 'executioner');
        assert.equal(query.get('id'), media.tmdbId);
        assert.equal(query.get('type'), media.type);
        assert.equal(query.get('season'), media.type === 'tv' ? '1' : null);
        assert.equal(query.get('episode'), media.type === 'tv' ? '1' : null);
        assert.equal(
            f.requests.length,
            2,
            'duplicate CDN variants must not be requested'
        );
        const payload = JSON.parse(
            new URL(result.sources[0].url).searchParams.get('data')!
        );
        assert.equal(payload.url, target);
        assert.equal(payload.headers.Origin, 'https://vidrock.to');
        assert.equal(payload.headers.Referer, 'https://vidrock.to/');
        assert.equal(result.sources[0].provider.id, 'framex:executioner');
        assert.equal(
            (result.sources[0] as IdentifiedSource).providerFamilyId,
            'framex'
        );
        assert.equal(
            (result.sources[0] as IdentifiedSource).upstreamId,
            'framex:executioner'
        );
    });

test('requests strict normalization only for the verified Vercetti transport', async () => {
    const f = fixture({
        sources: [
            {
                type: 'hls',
                url: wrapper('https://vercetti.org/movie/master.m3u8')
            }
        ]
    });
    const result = await f.provider.getMovieSources(movie);
    const payload = JSON.parse(
        new URL(result.sources[0].url).searchParams.get('data')!
    );
    assert.equal(payload.responseTransform, 'strip-png-ts-prefix');
    const ordinary = await fixture().provider.getTVSources(episode);
    assert.equal(
        JSON.parse(new URL(ordinary.sources[0].url).searchParams.get('data')!)
            .responseTransform,
        undefined
    );
});

test('honors global leaf switches while the provider is enabled', async () => {
    for (const environment of [
        { CINEPRO_PROVIDER_LEAF_DENYLIST: 'framex:executioner' },
        { CINEPRO_PROVIDER_LEAF_ALLOWLIST: 'vidking:yoru' }
    ]) {
        const f = fixture({ environment });
        assert.equal(f.provider.enabled, true);
        const result = await f.provider.getTVSources(episode);
        assert.equal(result.sources.length, 0);
        assert.equal(f.requests.length, 0);
    }
});

test('fails closed on HTTP, HTML, malformed JSON, and empty sources', async () => {
    for (const options of [
        { status: 404 },
        { body: '<html>not a playlist</html>' },
        { sources: [] }
    ]) {
        const result = await fixture(options).provider.getTVSources(episode);
        assert.equal(result.sources.length, 0);
        assert.equal(result.diagnostics[0]?.code, 'PROVIDER_ERROR');
    }
    const provider = new FramexProvider({
        fetch: async () => new Response('{broken-json')
    });
    assert.equal((await provider.getMovieSources(movie)).sources.length, 0);
});

test('rejects invalid episode identity before fetching', async () => {
    const f = fixture();
    const result = await f.provider.getTVSources({ ...episode, s: 0 });
    assert.equal(result.sources.length, 0);
    assert.equal(f.requests.length, 0);
});

test('rejects unmeasured embeds and preserves signed target query data', async () => {
    assert.equal(
        (
            await fixture({
                sources: [
                    {
                        type: 'embed',
                        url: 'https://player.example.test/embed/1'
                    }
                ]
            }).provider.getTVSources(episode)
        ).sources.length,
        0
    );
    const url =
        'https://media.example.test/master.m3u8?token=a%2Fb&expires=123';
    assert.equal(playbackTarget(wrapper(url))?.url, url);
    for (const url of [
        'file:///tmp/media',
        'javascript:alert(1)',
        'https://user:pass@media.example.test/v.m3u8'
    ])
        assert.equal(playbackTarget(url), null);
    assert.equal(
        playbackTarget(
            'https://frappe.hybrows.workers.dev/?url=https%3A%2F%2Fmedia.example.test%2Fv.m3u8&ref=https%3A%2F%2Fplayer.example.test%2F%0D%0ACookie%3Asecret'
        ),
        null
    );
});
