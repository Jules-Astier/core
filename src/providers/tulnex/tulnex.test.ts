import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderMediaObject } from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import {
    createTulnexLeafPolicy,
    TULNEX_ALLOW_ENV,
    TULNEX_DENY_ENV
} from './tulnex.config.js';
import { TULNEX_LEAVES, tulnexUpstreamId } from './tulnex.identity.js';
import { TulnexProvider } from './tulnex.js';

const movie = { type: 'movie', tmdbId: 'fixture-42' } as ProviderMediaObject;

function fixtureProvider(options: {
    failedLeaves?: ReadonlySet<string>;
    sameUrl?: boolean;
    policy?: ReturnType<typeof createTulnexLeafPolicy>;
}) {
    const failedLeaves = options.failedLeaves ?? new Set<string>();
    const fetchFixture: typeof fetch = async (input) => {
        const url = String(input);
        const leaf = TULNEX_LEAVES.find((candidate) =>
            url.includes(`/${candidate}/`)
        );
        assert.ok(leaf, `unexpected fixture URL: ${url}`);
        if (failedLeaves.has(leaf)) {
            throw new Error('synthetic leaf failure');
        }
        return new Response(JSON.stringify({ v: 'fixture', payload: leaf }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };

    return new TulnexProvider({
        fetch: fetchFixture,
        decryptPayload: async (leaf) => ({
            url: options.sameUrl
                ? 'https://media.invalid/shared/master.m3u8'
                : `https://media.invalid/${leaf}/master.m3u8`,
            headers: { Referer: 'https://fixture.invalid/' }
        }),
        leafPolicy:
            options.policy ?? createTulnexLeafPolicy(Object.create(null))
    });
}

test('maps all 14 leaves to exact canonical identities in catalog order', async () => {
    const result = await fixtureProvider({}).getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    assert.equal(result.sources.length, 14);
    assert.deepEqual(
        sources.map((source) => ({
            id: source.provider.id,
            name: source.provider.name,
            family: source.providerFamilyId,
            upstream: source.upstreamId,
            type: source.type
        })),
        TULNEX_LEAVES.map((leaf) => ({
            id: `tulnex:${leaf}`,
            name: 'Tulnex',
            family: 'tulnex',
            upstream: `tulnex:${leaf}`,
            type: 'hls'
        }))
    );
});

test('preserves exact catalog alias spellings', () => {
    assert.deepEqual(TULNEX_LEAVES.map(tulnexUpstreamId), [
        'tulnex:onion',
        'tulnex:vidzee',
        'tulnex:icefy',
        'tulnex:tik',
        'tulnex:vaplayer',
        'tulnex:vidfast-alpha',
        'tulnex:uniquestream',
        'tulnex:vidfast-mega',
        'tulnex:vidfast-vrapid',
        'tulnex:allmovies',
        'tulnex:vidlink',
        'tulnex:vidfast-vedge',
        'tulnex:vidfast-vfast',
        'tulnex:moviebox'
    ]);
});

test('keeps distinct leaf identities when upstream URLs are identical', async () => {
    const result = await fixtureProvider({ sameUrl: true }).getMovieSources(
        movie
    );
    const sources = result.sources as IdentifiedSource[];
    assert.equal(new Set(result.sources.map((source) => source.url)).size, 1);
    assert.equal(new Set(sources.map((source) => source.upstreamId)).size, 14);
});

test('a rejected leaf does not prevent successful siblings', async () => {
    const result = await fixtureProvider({
        failedLeaves: new Set(['icefy'])
    }).getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    assert.equal(result.sources.length, 13);
    assert.ok(sources.every((source) => source.upstreamId !== 'tulnex:icefy'));
});

test('allow and deny switches act per leaf with legacy-safe defaults', async () => {
    assert.deepEqual(
        [...createTulnexLeafPolicy({}).enabledLeaves],
        TULNEX_LEAVES
    );
    const policy = createTulnexLeafPolicy({
        [TULNEX_ALLOW_ENV]: 'Tulnex:Onion, VIDZEE, moviebox',
        [TULNEX_DENY_ENV]: 'vidzee'
    });
    const result = await fixtureProvider({ policy }).getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            (source) => source.upstreamId
        ),
        ['tulnex:onion', 'tulnex:moviebox']
    );
});

test('invalid startup configuration is rejected without leaking its value', () => {
    const secret = 'unknown-leaf-super-secret';
    assert.throws(
        () =>
            createTulnexLeafPolicy({
                [TULNEX_DENY_ENV]: secret
            }),
        (error: Error) =>
            error.message.includes(TULNEX_DENY_ENV) &&
            !error.message.includes(secret)
    );
});
