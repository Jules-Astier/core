import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderMediaObject } from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import {
    resolveVideasyServers,
    VIDEASY_ACTIVE_SERVERS,
    VIDEASY_DISABLED_LEAVES
} from './videasy.config.js';
import { VideasyProvider } from './videasy.js';

const movie = {
    type: 'movie',
    tmdbId: 'fixture-42',
    imdbId: 'tt0000042',
    title: 'Fixture',
    releaseYear: '2026'
} as ProviderMediaObject;

function fixtureProvider(options: {
    failed?: ReadonlySet<string>;
    sameUrl?: boolean;
    environment?: Record<string, string>;
    quality?: string;
}) {
    const failed = options.failed ?? new Set<string>();
    const requests: string[] = [];
    const fetchFixture: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push(url);
        const leaf = VIDEASY_ACTIVE_SERVERS.find(({ url: endpoint }) =>
            url.startsWith(endpoint)
        );
        assert.ok(leaf, 'fixture received an unexpected request');
        assert.deepEqual(init?.headers, {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'application/json, */*; q=0.01',
            Referer: 'https://player.videasy.net/',
            Origin: 'https://player.videasy.net'
        });
        if (failed.has(leaf.name)) {
            throw new Error(
                'synthetic https://private.invalid/?token=do-not-log'
            );
        }
        return new Response(`fixture-blob-${leaf.name}`, { status: 200 });
    };

    return {
        provider: new VideasyProvider({
            environment: options.environment ?? {},
            fetch: fetchFixture,
            decrypt: async (blob) => {
                const leaf = blob.slice('fixture-blob-'.length);
                const url = options.sameUrl
                    ? 'https://media.invalid/shared/master.m3u8'
                    : `https://media.invalid/${leaf}/master.m3u8`;
                return {
                    sources: [
                        {
                            url,
                            type: 'hls',
                            quality: options.quality ?? '1080p'
                        }
                    ],
                    subtitles: [
                        {
                            url: `https://subtitle.invalid/${leaf}.vtt`,
                            lang: 'English'
                        }
                    ]
                };
            }
        }),
        requests
    };
}

test('maps all six active leaves to canonical identities in legacy order', async () => {
    const result = await fixtureProvider({}).provider.getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    assert.deepEqual(
        sources.map((source) => ({
            id: source.provider.id,
            name: source.provider.name,
            family: source.providerFamilyId,
            upstream: source.upstreamId,
            type: source.type,
            quality: source.quality
        })),
        VIDEASY_ACTIVE_SERVERS.map((leaf) => ({
            id: `videasy:${leaf.name}`,
            name: 'Videasy',
            family: 'videasy',
            upstream: `videasy:${leaf.name}`,
            type: 'hls',
            quality: '1080p'
        }))
    );
    assert.equal(result.subtitles.length, 6);
});

test('records exactly nine reviewed leaves as immutable seed-needed candidates', () => {
    assert.deepEqual(
        VIDEASY_DISABLED_LEAVES.map(({ name, status, enabled }) => ({
            name,
            status,
            enabled
        })),
        [
            'primesrcme',
            'm4uhd',
            'meine-de',
            'meine-it',
            'meine-fr',
            'overflix',
            'visioncine',
            'hdmovie',
            'primewire'
        ].map((name) => ({ name, status: 'seed-needed', enabled: false }))
    );
});

test('normalizes language-like quality without changing source type', async () => {
    const result = await fixtureProvider({
        quality: 'Hindi'
    }).provider.getMovieSources(movie);
    assert.ok(result.sources.every((source) => source.quality === 'unknown'));
    assert.ok(result.sources.every((source) => source.type === 'hls'));
});

test('keeps identical URLs distinct across leaves', async () => {
    const result = await fixtureProvider({
        sameUrl: true
    }).provider.getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    assert.equal(new Set(result.sources.map(({ url }) => url)).size, 1);
    assert.equal(new Set(sources.map(({ upstreamId }) => upstreamId)).size, 6);
});

test('one failed leaf preserves sibling order and produces redacted partial diagnostics', async () => {
    const result = await fixtureProvider({
        failed: new Set(['cdn'])
    }).provider.getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    assert.deepEqual(
        sources.map(({ upstreamId }) => upstreamId),
        VIDEASY_ACTIVE_SERVERS.filter(({ name }) => name !== 'cdn').map(
            ({ name }) => `videasy:${name}`
        )
    );
    assert.equal(result.diagnostics[0]?.code, 'PARTIAL_SCRAPE');
    const serialized = JSON.stringify(result.diagnostics);
    assert.ok(!serialized.includes('private.invalid'));
    assert.ok(!serialized.includes('do-not-log'));
});

test('allow and deny switches isolate leaves and defaults preserve legacy fanout', async () => {
    assert.deepEqual(
        resolveVideasyServers({}).map(({ name }) => name),
        VIDEASY_ACTIVE_SERVERS.map(({ name }) => name)
    );
    const { provider, requests } = fixtureProvider({
        environment: {
            VIDEASY_LEAF_ALLOWLIST:
                'videasy:cuevana,videasy:cdn,videasy:lamovie',
            VIDEASY_LEAF_DENYLIST: 'videasy:cdn'
        }
    });
    const result = await provider.getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    assert.deepEqual(
        sources.map(({ upstreamId }) => upstreamId),
        ['videasy:cuevana', 'videasy:lamovie']
    );
    assert.equal(requests.length, 2);
});

test('startup validation rejects disabled, unknown, and duplicate values without echoing secrets', () => {
    assert.throws(
        () =>
            new VideasyProvider({
                environment: { VIDEASY_LEAF_ALLOWLIST: 'hdmovie' }
            }),
        /authorized seed review/
    );
    const secret = 'unknown-super-secret-token';
    assert.throws(
        () =>
            new VideasyProvider({
                environment: { VIDEASY_LEAF_DENYLIST: secret }
            }),
        (error: Error) =>
            error.message.includes('VIDEASY_LEAF_DENYLIST') &&
            !error.message.includes(secret)
    );
    assert.throws(
        () => resolveVideasyServers({ VIDEASY_LEAF_ALLOWLIST: 'cdn,cdn' }),
        /duplicate/
    );
    assert.throws(
        () =>
            resolveVideasyServers({
                VIDEASY_LEAF_ALLOWLIST: 'cdn,videasy:cdn'
            }),
        /duplicate/
    );
});

test('retains top-level registry identity and proxy header behavior', async () => {
    const provider = fixtureProvider({
        environment: { VIDEASY_LEAF_ALLOWLIST: 'cuevana' }
    }).provider;
    assert.deepEqual(
        { id: provider.id, name: provider.name, enabled: provider.enabled },
        { id: 'Videasy', name: 'Videasy', enabled: true }
    );
    const result = await provider.getMovieSources(movie);
    const proxyData = new URL(result.sources[0].url).searchParams.get('data');
    assert.ok(proxyData);
    const payload = JSON.parse(proxyData);
    assert.equal(payload.url, 'https://media.invalid/cuevana/master.m3u8');
    assert.equal(payload.headers.Referer, 'https://player.videasy.net/');
});
