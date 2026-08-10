import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import {
    resolveVideasyServers,
    VIDEASY_ACTIVE_SERVERS,
    VIDEASY_DISABLED_LEAVES,
    VIDEASY_RETIRED_LEAVES
} from './videasy.config.js';
import {
    decodeVideasyResponse,
    decryptResponse,
    encodeVideasyFixture
} from './decryptor.js';
import { VideasyProvider } from './videasy.js';

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

const expectedHeaders = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, */*; q=0.01',
    Referer: 'https://player.videasy.to/',
    Origin: 'https://player.videasy.to'
};

function fixtureProvider(
    options: {
        environment?: Record<string, string>;
        unauthorizedPath?: string;
        failedPath?: string;
    } = {}
) {
    const requests: URL[] = [];
    const decryptSeeds: string[] = [];
    let seedRequests = 0;
    let unauthorizedReturned = false;

    const fetchFixture: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        assert.deepEqual(init?.headers, expectedHeaders);
        if (url.pathname === '/seed') {
            seedRequests += 1;
            return Response.json({
                seed: `synthetic-seed-${seedRequests}`,
                ttlMs: 60_000
            });
        }
        if (url.pathname === options.failedPath) {
            throw new Error('synthetic private upstream error');
        }
        if (
            url.pathname === options.unauthorizedPath &&
            !unauthorizedReturned
        ) {
            unauthorizedReturned = true;
            return new Response('', { status: 401 });
        }
        return new Response(url.pathname, { status: 200 });
    };

    return {
        provider: new VideasyProvider({
            environment: options.environment ?? {},
            fetch: fetchFixture,
            decrypt: (blob, seed) => {
                decryptSeeds.push(seed);
                const source = (suffix: string, quality = '1080p') => ({
                    url: `https://media.invalid${blob}/${suffix}.m3u8`,
                    type: 'hls',
                    quality
                });
                if (blob === '/hdmovie/sources-with-title') {
                    return {
                        sources: [
                            source('english', 'English'),
                            source('hindi', 'Hindi')
                        ],
                        subtitles: []
                    };
                }
                if (blob === '/vsrc/sources-with-title') {
                    return {
                        sources: [
                            {
                                url: 'https://media.invalid/neon/manifest.mpd',
                                type: 'dash',
                                quality: '1080p'
                            },
                            source('hls')
                        ],
                        subtitles: []
                    };
                }
                return {
                    sources: [source('master')],
                    subtitles: [
                        {
                            url: `https://subtitle.invalid${blob}.vtt`,
                            lang: 'English'
                        }
                    ]
                };
            }
        }),
        requests,
        decryptSeeds,
        get seedRequests() {
            return seedRequests;
        }
    };
}

test('maps every current leaf to a canonical identity and coalesces seed requests', async () => {
    const fixture = fixtureProvider();
    const result = await fixture.provider.getMovieSources(movie);

    assertProviderResultContract(result, {
        providerId: 'videasy',
        allowedTypes: ['hls'],
        minimumSources: VIDEASY_ACTIVE_SERVERS.length + 1
    });
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map((source) => ({
            id: source.provider.id,
            family: source.providerFamilyId,
            upstream: source.upstreamId,
            language: source.audioTracks[0]?.language
        })),
        VIDEASY_ACTIVE_SERVERS.flatMap((leaf) =>
            leaf.name === 'hdmovie'
                ? ['en', 'hi'].map((language) => ({
                      id: 'videasy:hdmovie',
                      family: 'videasy',
                      upstream: 'videasy:hdmovie',
                      language
                  }))
                : [
                      {
                          id: `videasy:${leaf.name}`,
                          family: 'videasy',
                          upstream: `videasy:${leaf.name}`,
                          language: leaf.language
                      }
                  ]
        )
    );
    assert.equal(fixture.seedRequests, 1);
    assert.ok(
        fixture.decryptSeeds.every((seed) => seed === 'synthetic-seed-1')
    );
});

test('constructs current movie and TV parameters without exposing the seed', async () => {
    const movieFixture = fixtureProvider({
        environment: { VIDEASY_LEAF_ALLOWLIST: 'yoru' }
    });
    await movieFixture.provider.getMovieSources(movie);
    const movieRequest = movieFixture.requests.find(
        ({ pathname }) => pathname === '/cdn/sources-with-title'
    )!;
    assert.equal(movieRequest.searchParams.get('title'), 'The%20Matrix');
    assert.equal(movieRequest.searchParams.get('mediaType'), 'movie');
    assert.equal(movieRequest.searchParams.get('year'), '1999');
    assert.equal(movieRequest.searchParams.get('tmdbId'), '603');
    assert.equal(movieRequest.searchParams.get('imdbId'), 'tt0133093');
    assert.equal(movieRequest.searchParams.get('enc'), '2');
    assert.ok(movieRequest.searchParams.has('seed'));

    const tvFixture = fixtureProvider({
        environment: { VIDEASY_LEAF_ALLOWLIST: 'yoru' }
    });
    await tvFixture.provider.getTVSources(episode);
    const tvRequest = tvFixture.requests.find(
        ({ pathname }) => pathname === '/cdn/sources-with-title'
    )!;
    assert.equal(tvRequest.searchParams.get('mediaType'), 'tv');
    assert.equal(tvRequest.searchParams.get('seasonId'), '1');
    assert.equal(tvRequest.searchParams.get('episodeId'), '1');
    assert.equal(tvRequest.searchParams.has('year'), false);
});

test('refreshes an expired seed exactly once after a 401', async () => {
    const fixture = fixtureProvider({
        environment: { VIDEASY_LEAF_ALLOWLIST: 'yoru' },
        unauthorizedPath: '/cdn/sources-with-title'
    });
    const result = await fixture.provider.getMovieSources(movie);

    assert.equal(result.sources.length, 1);
    assert.equal(fixture.seedRequests, 2);
    assert.deepEqual(fixture.decryptSeeds, ['synthetic-seed-2']);
});

test('preserves language-labelled HLS variants from the shared endpoint', async () => {
    const result = await fixtureProvider({
        environment: {
            VIDEASY_LEAF_ALLOWLIST: 'hdmovie'
        }
    }).provider.getMovieSources(movie);

    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map((source) => ({
            upstream: source.upstreamId,
            type: source.type,
            language: source.audioTracks[0]?.language
        })),
        [
            { upstream: 'videasy:hdmovie', type: 'hls', language: 'en' },
            { upstream: 'videasy:hdmovie', type: 'hls', language: 'hi' }
        ]
    );
});

test('supports canonical and legacy leaf switches while rejecting retired leaves', () => {
    assert.deepEqual(
        resolveVideasyServers({
            VIDEASY_LEAF_ALLOWLIST: 'cdn,m4uhd,omen'
        }).map(({ name }) => name),
        ['cdn', 'm4uhd', 'lamovie']
    );
    assert.deepEqual(
        VIDEASY_DISABLED_LEAVES.map(({ name }) => name),
        [
            'primesrcme',
            'overflix',
            'visioncine',
            'meine-it',
            'meine-fr',
            'primewire'
        ]
    );
    assert.deepEqual(
        VIDEASY_RETIRED_LEAVES.map(({ name }) => name),
        ['cuevana', 'mb-flix', '1movies']
    );
    assert.throws(
        () =>
            resolveVideasyServers({
                VIDEASY_LEAF_ALLOWLIST: 'cuevana'
            }),
        /retired or seed-gated/
    );
});

test('returns redacted partial diagnostics when a current leaf fails', async () => {
    const result = await fixtureProvider({
        failedPath: '/m4uhd/sources-with-title'
    }).provider.getMovieSources(movie);

    assert.equal(result.sources.length, VIDEASY_ACTIVE_SERVERS.length);
    assert.equal(result.diagnostics[0]?.code, 'PARTIAL_SCRAPE');
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /private upstream/);
});

test('locally decodes synthetic payloads through both decoder state branches', () => {
    const payload = {
        sources: [
            {
                url: 'https://media.invalid/master.m3u8',
                type: 'hls',
                quality: '1080p'
            }
        ],
        subtitles: []
    };
    for (const seed of ['xy', 'synthetic-seed']) {
        const encoded = encodeVideasyFixture(payload, seed, '603');
        assert.deepEqual(decryptResponse(encoded, seed, '603'), payload);
        assert.equal(
            JSON.parse(decodeVideasyResponse(encoded, seed, '603')).sources[0]
                .type,
            'hls'
        );
        assert.equal(decryptResponse(encoded, `${seed}-wrong`, '603'), null);
    }
});

test('retains top-level registry identity and current proxy headers', async () => {
    const provider = fixtureProvider({
        environment: { VIDEASY_LEAF_ALLOWLIST: 'yoru' }
    }).provider;
    assert.deepEqual(
        { id: provider.id, name: provider.name, enabled: provider.enabled },
        { id: 'Videasy', name: 'Videasy', enabled: true }
    );
    const result = await provider.getMovieSources(movie);
    const proxyData = new URL(result.sources[0].url).searchParams.get('data');
    assert.ok(proxyData);
    const decoded = JSON.parse(proxyData);
    assert.equal(decoded.headers.Referer, 'https://player.videasy.to/');
});
