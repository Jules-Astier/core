import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import {
    createVidLoveLeafPolicy,
    VIDLOVE_ALLOW_ENV,
    VIDLOVE_DENY_ENV
} from './vidlove.config.js';
import { VIDLOVE_LEAVES } from './vidlove.identity.js';
import { VidLoveProvider } from './vidlove.js';

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

const PLAYER_URL = 'https://player.vidlove.invalid';
const API_URL = 'https://api.vidlove.invalid';
const manifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480
https://media.vidlove.invalid/480/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080
https://media.vidlove.invalid/1080/playlist.m3u8
`;

const movie = {
    type: 'movie',
    tmdbId: '603',
    imdbId: 'tt0133093',
    title: 'The Matrix',
    releaseYear: '1999'
} as ProviderMediaObject;

const episode = {
    type: 'tv',
    tmdbId: '1396',
    imdbId: 'tt0903747',
    title: 'Breaking Bad',
    releaseYear: '2008',
    s: 1,
    e: 1
} as ProviderMediaObject;

function proxyPayload(url: string): {
    url: string;
    headers: Record<string, string>;
    responseTransform?: 'strip-png-ts-prefix';
} {
    const encoded = new URL(url).searchParams.get('data');
    assert.ok(encoded, 'proxy URL must contain data');
    return JSON.parse(encoded);
}

function fixtureProvider(
    options: {
        policy?: ReturnType<typeof createVidLoveLeafPolicy>;
        missingLeaf?: string;
        failedLeaf?: string;
    } = {}
) {
    const requests: URL[] = [];
    const fetchFixture: typeof fetch = async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        const leaf = url.searchParams.get('sources');
        if (leaf === options.failedLeaf) {
            return new Response('private-upstream-value', { status: 503 });
        }
        if (leaf === options.missingLeaf) {
            return Response.json({ source: null, subtitles: [] });
        }
        if (!leaf) throw new Error('Fixture source leaf was missing');
        return Response.json({
            source: {
                source: leaf,
                label: leaf,
                url: `https://media.vidlove.invalid/${leaf}/master.m3u8`,
                manifest,
                headers: {
                    Referer: `${PLAYER_URL}/`,
                    Cookie: 'must-not-be-forwarded'
                }
            },
            subtitles: [
                {
                    file: 'https://media.vidlove.invalid/subtitles/en.vtt',
                    label: 'English'
                }
            ]
        });
    };

    return {
        provider: new VidLoveProvider({
            playerUrl: PLAYER_URL,
            apiUrl: API_URL,
            fetch: fetchFixture,
            leafPolicy:
                options.policy ?? createVidLoveLeafPolicy(Object.create(null))
        }),
        requests
    };
}

test('maps every VidLove source leaf to a stable direct-HLS identity', async () => {
    const { provider, requests } = fixtureProvider();
    const result = await provider.getMovieSources(movie);

    assertProviderResultContract(result, {
        providerId: 'vidlove',
        allowedTypes: ['hls'],
        minimumSources: VIDLOVE_LEAVES.length
    });
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ provider, providerFamilyId, upstreamId, quality }) => ({
                id: provider.id,
                family: providerFamilyId,
                upstream: upstreamId,
                quality
            })
        ),
        VIDLOVE_LEAVES.map((leaf) => ({
            id: `vidlove:${leaf}`,
            family: 'vidlove',
            upstream: `vidlove:${leaf}`,
            quality: '1080p'
        }))
    );
    assert.equal(requests.length, VIDLOVE_LEAVES.length);
    assert.ok(
        requests.every(
            (url) =>
                url.pathname === '/movie' &&
                url.searchParams.get('id') === '603' &&
                url.searchParams.get('mode') === 'json'
        )
    );
    assert.equal(result.subtitles.length, 1);

    const source = proxyPayload(result.sources[0].url);
    assert.equal(
        source.url,
        'https://media.vidlove.invalid/1080/playlist.m3u8'
    );
    assert.equal(source.headers.Referer, `${PLAYER_URL}/`);
    assert.equal(source.headers.Origin, PLAYER_URL);
    assert.equal(source.headers.Cookie, undefined);
    const ipcloudSource = (result.sources as IdentifiedSource[]).find(
        ({ upstreamId }) => upstreamId === 'vidlove:ipcloud'
    );
    assert.ok(ipcloudSource);
    assert.equal(
        proxyPayload(ipcloudSource.url).responseTransform,
        'strip-png-ts-prefix'
    );
});

test('constructs the TV route with season and episode', async () => {
    const policy = createVidLoveLeafPolicy({
        [VIDLOVE_ALLOW_ENV]: 'ipcloud'
    });
    const { provider, requests } = fixtureProvider({ policy });
    const result = await provider.getTVSources(episode);

    assertProviderResultContract(result, {
        providerId: 'vidlove',
        allowedTypes: ['hls']
    });
    assert.equal(requests[0].pathname, '/tv');
    assert.equal(requests[0].searchParams.get('id'), '1396');
    assert.equal(requests[0].searchParams.get('season'), '1');
    assert.equal(requests[0].searchParams.get('episode'), '1');
});

test('normalization is scoped to IPCloud and the provider is enabled by default', async () => {
    const policy = createVidLoveLeafPolicy({
        [VIDLOVE_ALLOW_ENV]: 'moviebox,ipcloud'
    });
    const { provider } = fixtureProvider({ policy });
    const result = await provider.getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    const moviebox = sources.find(
        ({ upstreamId }) => upstreamId === 'vidlove:moviebox'
    );
    const ipcloud = sources.find(
        ({ upstreamId }) => upstreamId === 'vidlove:ipcloud'
    );
    assert.ok(moviebox && ipcloud);
    assert.equal(provider.enabled, true);
    assert.equal(proxyPayload(moviebox.url).responseTransform, undefined);
    assert.equal(
        proxyPayload(ipcloud.url).responseTransform,
        'strip-png-ts-prefix'
    );
});

test('discovers the current API origin from the public player bundle', async () => {
    const requests: URL[] = [];
    const provider = new VidLoveProvider({
        playerUrl: PLAYER_URL,
        leafPolicy: createVidLoveLeafPolicy({
            [VIDLOVE_ALLOW_ENV]: 'ipcloud'
        }),
        fetch: async (input) => {
            const url = new URL(String(input));
            requests.push(url);
            if (url.pathname === '/embed/movie/603') {
                return new Response(
                    '<script type="module" src="/assets/index-fixture.js"></script>'
                );
            }
            if (url.pathname === '/assets/index-fixture.js') {
                return new Response(
                    `const api="${API_URL}";const route=api+"/movie?id=\${id}&mode=json";`
                );
            }
            return Response.json({
                source: {
                    source: 'ipcloud',
                    url: 'https://media.vidlove.invalid/ipcloud/master.m3u8',
                    manifest
                }
            });
        }
    });

    const result = await provider.getMovieSources(movie);
    assertProviderResultContract(result, {
        providerId: 'vidlove',
        allowedTypes: ['hls']
    });
    assert.deepEqual(
        requests.map(({ origin, pathname }) => `${origin}${pathname}`),
        [
            `${PLAYER_URL}/embed/movie/603`,
            `${PLAYER_URL}/assets/index-fixture.js`,
            `${API_URL}/movie`
        ]
    );
});

test('missing content is not treated as an upstream failure', async () => {
    const policy = createVidLoveLeafPolicy({
        [VIDLOVE_ALLOW_ENV]: 'moviebox,ipcloud'
    });
    const { provider } = fixtureProvider({
        policy,
        missingLeaf: 'moviebox'
    });
    const result = await provider.getMovieSources(movie);

    assert.equal(result.sources.length, 1);
    assert.equal(
        (result.sources[0] as IdentifiedSource).upstreamId,
        'vidlove:ipcloud'
    );
    assert.ok(
        !result.diagnostics.some(({ code }) => code === 'PARTIAL_SCRAPE')
    );
});

test('one failed request preserves successful siblings with redacted diagnostics', async () => {
    const policy = createVidLoveLeafPolicy({
        [VIDLOVE_ALLOW_ENV]: 'moviebox,ipcloud'
    });
    const { provider } = fixtureProvider({
        policy,
        failedLeaf: 'moviebox'
    });
    const result = await provider.getMovieSources(movie);

    assert.equal(result.sources.length, 1);
    assert.ok(result.diagnostics.some(({ code }) => code === 'PARTIAL_SCRAPE'));
    assert.doesNotMatch(
        JSON.stringify(result.diagnostics),
        /private-upstream-value/
    );
});

test('malformed and mismatched responses fail closed', async () => {
    for (const body of [
        null,
        { source: { source: 'other', url: 'https://media.invalid/a.m3u8' } },
        {
            source: {
                source: 'ipcloud',
                url: 'https://media.invalid/video.dash',
                manifest: 'not a playlist'
            }
        }
    ]) {
        const provider = new VidLoveProvider({
            playerUrl: PLAYER_URL,
            apiUrl: API_URL,
            leafPolicy: createVidLoveLeafPolicy({
                [VIDLOVE_ALLOW_ENV]: 'ipcloud'
            }),
            fetch: async () => Response.json(body)
        });
        const result = await provider.getMovieSources(movie);
        assert.equal(result.sources.length, 0);
        assert.ok(result.diagnostics.length > 0);
    }
});

test('allow and deny switches select exact VidLove leaves', () => {
    const policy = createVidLoveLeafPolicy({
        [VIDLOVE_ALLOW_ENV]: 'VIDLOVE:MOVIEBOX, ipcloud, vidnest',
        [VIDLOVE_DENY_ENV]: 'moviebox'
    });
    assert.deepEqual([...policy.enabledLeaves], ['ipcloud', 'vidnest']);

    const secret = 'unknown-private-leaf';
    assert.throws(
        () => createVidLoveLeafPolicy({ [VIDLOVE_DENY_ENV]: secret }),
        (error: Error) =>
            error.message.includes(VIDLOVE_DENY_ENV) &&
            !error.message.includes(secret)
    );
});
