import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import { decryptVidKingPayload } from './decrypt.js';
import {
    createVidKingLeafPolicy,
    VIDKING_ALLOW_ENV,
    VIDKING_DENY_ENV
} from './vidking.config.js';
import { VIDKING_LEAVES } from './vidking.identity.js';
import { VidKingProvider } from './vidking.js';

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

const API_URL = 'https://api.vidking.invalid';
const FRONTEND_URL = 'https://player.vidking.invalid';
const NOW = 1_700_000_000_000;
const FIXTURE_SEED = 'fixture-seed-2026';
const FIXTURE_PAYLOAD =
    'S828RiF6jI2iBYLhxFXmmJNP2Iio6yXASj7pMXxDqSzG8fTwi8HmTRZx0Dh2triI87RP4EktaGtkHBdfIWp84fHW2oMgZ8UcDxPh7CYvtcS4g5hfjd53QFlwryvySL52sbixevI38u2QYyEOGGCccWLN-_o2BTBzx6h1UdwkP-FvURTuA9FAd9nbQR8eIszGtood1T7D37s';

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
} {
    const encoded = new URL(url).searchParams.get('data');
    assert.ok(encoded, 'proxy URL must contain data');
    return JSON.parse(encoded);
}

function fixtureProvider(options: {
    policy?: ReturnType<typeof createVidKingLeafPolicy>;
    failedEndpoint?: string;
} = {}) {
    const requests: URL[] = [];
    const fetchFixture: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        assert.equal(
            (init?.headers as Record<string, string>).Referer,
            `${FRONTEND_URL}/`
        );
        if (url.pathname === '/seed') {
            return Response.json({ seed: FIXTURE_SEED, ttlMs: 30_000 });
        }
        if (options.failedEndpoint && url.pathname.includes(options.failedEndpoint)) {
            return new Response('unavailable', { status: 503 });
        }
        return new Response(url.pathname);
    };
    const decryptFixture = (payload: string) =>
        JSON.stringify({
            sources: payload.includes('/hdmovie/')
                ? [
                      {
                          url: 'https://media.invalid/english/master.m3u8',
                          quality: 'English'
                      },
                      {
                          url: 'https://media.invalid/hindi/master.m3u8',
                          quality: 'Hindi'
                      }
                  ]
                : [
                      {
                          url: `https://media.invalid${payload}/master.m3u8`,
                          quality: '1080p'
                      }
                  ],
            subtitles: [
                {
                    url: 'https://media.invalid/subtitles/en.vtt',
                    display: 'English'
                }
            ]
        });

    return {
        provider: new VidKingProvider({
            apiUrl: API_URL,
            frontendUrl: FRONTEND_URL,
            fetch: fetchFixture,
            decryptPayload: decryptFixture,
            now: () => NOW,
            leafPolicy:
                options.policy ?? createVidKingLeafPolicy(Object.create(null))
        }),
        requests
    };
}

test('decrypts a sanitized version-2 payload fixture', () => {
    const plaintext = decryptVidKingPayload(
        FIXTURE_PAYLOAD,
        FIXTURE_SEED,
        603
    );
    assert.deepEqual(JSON.parse(plaintext), {
        sources: [
            {
                url: 'https://media.invalid/master.m3u8',
                quality: '1080p'
            }
        ],
        subtitles: [
            {
                url: 'https://media.invalid/en.vtt',
                display: 'English'
            }
        ]
    });
    assert.throws(
        () => decryptVidKingPayload(FIXTURE_PAYLOAD, 'wrong-seed', 603),
        /failed validation/
    );
});

test('maps all active upstreams to stable leaf identities', async () => {
    const { provider, requests } = fixtureProvider();
    const result = await provider.getMovieSources(movie);

    assertProviderResultContract(result, {
        providerId: 'vidking',
        allowedTypes: ['hls'],
        minimumSources: VIDKING_LEAVES.length
    });
    const sources = result.sources as IdentifiedSource[];
    assert.deepEqual(
        sources.map(({ provider, providerFamilyId, upstreamId }) => ({
            id: provider.id,
            family: providerFamilyId,
            upstream: upstreamId
        })),
        VIDKING_LEAVES.map((leaf) => ({
            id: `vidking:${leaf}`,
            family: 'vidking',
            upstream: `vidking:${leaf}`
        }))
    );
    assert.equal(requests[0].pathname, '/seed');
    assert.equal(requests.length, VIDKING_LEAVES.length + 1);
    assert.ok(
        requests.slice(1).every(
            (url) =>
                url.searchParams.get('tmdbId') === '603' &&
                url.searchParams.get('mediaType') === 'movie' &&
                url.searchParams.get('title') === 'The Matrix' &&
                url.searchParams.get('year') === '1999' &&
                url.searchParams.get('imdbId') === 'tt0133093' &&
                url.searchParams.get('enc') === '2' &&
                url.searchParams.get('_t') === String(NOW)
        )
    );
    assert.equal(result.subtitles.length, 1, 'shared subtitles are deduplicated');

    const source = proxyPayload(result.sources[0].url);
    assert.equal(source.headers.Referer, `${FRONTEND_URL}/`);
    assert.equal(source.headers.Origin, FRONTEND_URL);
});

test('constructs the TV identity query with season and episode', async () => {
    const policy = createVidKingLeafPolicy({
        [VIDKING_ALLOW_ENV]: 'vidking:yoru'
    });
    const { provider, requests } = fixtureProvider({ policy });
    const result = await provider.getTVSources(episode);

    assertProviderResultContract(result, {
        providerId: 'vidking',
        allowedTypes: ['hls']
    });
    const request = requests.at(-1)!;
    assert.equal(request.searchParams.get('mediaType'), 'tv');
    assert.equal(request.searchParams.get('seasonId'), '1');
    assert.equal(request.searchParams.get('episodeId'), '1');
});

test('one failed leaf returns successful siblings and a partial diagnostic', async () => {
    const { provider } = fixtureProvider({ failedEndpoint: '/downloader2/' });
    const result = await provider.getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];

    assert.equal(sources.length, VIDKING_LEAVES.length - 1);
    assert.ok(
        sources.every(({ upstreamId }) => upstreamId !== 'vidking:cypher')
    );
    assert.ok(result.diagnostics.some(({ code }) => code === 'PARTIAL_SCRAPE'));
});

test('malformed seed and source responses fail closed without leaking payloads', async () => {
    const malformedSeed = new VidKingProvider({
        apiUrl: API_URL,
        frontendUrl: FRONTEND_URL,
        fetch: async () => Response.json({ seed: 'short' })
    });
    const seedResult = await malformedSeed.getMovieSources(movie);
    assert.equal(seedResult.sources.length, 0);
    assert.equal(seedResult.diagnostics[0].code, 'PROVIDER_ERROR');

    const malformedSource = new VidKingProvider({
        apiUrl: API_URL,
        frontendUrl: FRONTEND_URL,
        leafPolicy: createVidKingLeafPolicy({
            [VIDKING_ALLOW_ENV]: 'yoru'
        }),
        fetch: async (input) =>
            String(input).includes('/seed')
                ? Response.json({ seed: FIXTURE_SEED })
                : new Response('encrypted-private-value'),
        decryptPayload: () => '{not-json'
    });
    const sourceResult = await malformedSource.getMovieSources(movie);
    assert.equal(sourceResult.sources.length, 0);
    assert.equal(sourceResult.diagnostics[0].code, 'PROVIDER_ERROR');
    assert.doesNotMatch(
        JSON.stringify(sourceResult.diagnostics),
        /encrypted-private-value/
    );
});

test('allow and deny switches select exact VidKing leaves', async () => {
    const policy = createVidKingLeafPolicy({
        [VIDKING_ALLOW_ENV]: 'VIDKING:YORU, cypher, neon',
        [VIDKING_DENY_ENV]: 'cypher'
    });
    const { provider } = fixtureProvider({ policy });
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(({ upstreamId }) => upstreamId),
        ['vidking:yoru', 'vidking:neon']
    );
});

test('invalid leaf configuration is rejected without echoing its value', () => {
    const secret = 'unknown-leaf-private-value';
    assert.throws(
        () => createVidKingLeafPolicy({ [VIDKING_DENY_ENV]: secret }),
        (error: Error) =>
            error.message.includes(VIDKING_DENY_ENV) &&
            !error.message.includes(secret)
    );
});
