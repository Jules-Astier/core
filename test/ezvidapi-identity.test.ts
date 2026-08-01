import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderMediaObject } from '@omss/framework';
import type { IdentifiedSource } from '../src/provider-identity.js';
import {
    EZVIDAPI_LEAVES,
    resolveEzVidApiLeaf
} from '../src/providers/ezvidapi/ezvidapi.config.js';
import { EzVidApiProvider } from '../src/providers/ezvidapi/ezvidapi.js';
import {
    GLOBAL_LEAF_ALLOW_ENV,
    GLOBAL_LEAF_DENY_ENV
} from '../src/providers/provider-leaf-switches.js';

const movie = { type: 'movie', tmdbId: 'fixture-42' } as ProviderMediaObject;

function fixture(options: {
    list?: string[];
    listFailure?: boolean;
    environment?: Record<string, string>;
    fail?: ReadonlySet<string>;
    responseNames?: Readonly<Record<string, string>>;
}) {
    const requests: string[] = [];
    const fetchFixture: typeof fetch = async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith('/list')) {
            if (options.listFailure) {
                return new Response(null, { status: 503 });
            }
            return Response.json({
                providers: (
                    options.list ?? EZVIDAPI_LEAVES.map((x) => x.label)
                ).map((name) => ({ name, types: ['movie'] }))
            });
        }
        const requested = decodeURIComponent(url.split('/').at(-2) ?? '');
        const leaf = resolveEzVidApiLeaf(requested);
        assert.ok(leaf, `unexpected leaf request ${requested}`);
        if (options.fail?.has(leaf.slug)) {
            throw new Error('synthetic private failure');
        }
        return Response.json({
            provider: options.responseNames?.[leaf.slug] ?? requested,
            stream_url: `https://media.invalid/${leaf.slug}/master.m3u8`,
            stream_type: 'hls'
        });
    };
    return {
        provider: new EzVidApiProvider({
            fetch: fetchFixture,
            environment: options.environment ?? {}
        }),
        requests
    };
}

test('runtime is disabled by default and requires an exact explicit opt-in', () => {
    assert.equal(fixture({ environment: {} }).provider.enabled, false);
    assert.equal(
        fixture({ environment: { EZVIDAPI_ENABLED: 'TRUE' } }).provider
            .enabled,
        false
    );
    assert.equal(
        fixture({ environment: { EZVIDAPI_ENABLED: 'true' } }).provider
            .enabled,
        true
    );
});

test('catalog-backed fallback emits the eight canonical leaves in stable order', async () => {
    const result = await fixture({
        listFailure: true
    }).provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        EZVIDAPI_LEAVES.map(({ id }) => id)
    );
});

test('maps case and punctuation variants only through canonical EzVid leaves', async () => {
    const { provider } = fixture({
        list: ['VID-SRC', 'vid rock', 'Vid.Zee', 'unknown dynamic 123']
    });
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map((source) => ({
            id: source.provider.id,
            family: source.providerFamilyId,
            upstream: source.upstreamId,
            label: source.provider.name
        })),
        [
            {
                id: 'ezvidapi:vidsrc',
                family: 'ezvidapi',
                upstream: 'ezvidapi:vidsrc',
                label: 'EzVidAPI / VID-SRC'
            },
            {
                id: 'ezvidapi:vidrock',
                family: 'ezvidapi',
                upstream: 'ezvidapi:vidrock',
                label: 'EzVidAPI / vid rock'
            },
            {
                id: 'ezvidapi:vidzee',
                family: 'ezvidapi',
                upstream: 'ezvidapi:vidzee',
                label: 'EzVidAPI / Vid.Zee'
            }
        ]
    );
});

test('unknown response identities fail closed without dropping siblings', async () => {
    const result = await fixture({
        list: ['VidSrc', 'VidRock'],
        responseNames: { vidsrc: 'runtime-unknown-999' }
    }).provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        ['ezvidapi:vidrock']
    );
    assert.equal(result.diagnostics[0]?.code, 'PARTIAL_SCRAPE');
    assert.match(result.diagnostics[0]?.message ?? '', /1 of 2/);
});

test('duplicate aliases request and return each canonical leaf once', async () => {
    const { provider, requests } = fixture({
        list: ['VidSrc', 'vid-src', 'VID SRC', 'Popr']
    });
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        ['ezvidapi:vidsrc', 'ezvidapi:popr']
    );
    assert.equal(requests.filter((url) => !url.endsWith('/list')).length, 2);
});

test('global leaf allow and deny switches prevent requests and returned leaves', async () => {
    const { provider, requests } = fixture({
        environment: {
            [GLOBAL_LEAF_ALLOW_ENV]:
                'ezvidapi:vidsrc,ezvidapi:vidrock,other:leaf',
            [GLOBAL_LEAF_DENY_ENV]: 'ezvidapi:vidrock'
        },
        responseNames: { vidsrc: 'VidRock' }
    });
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(result.sources, []);
    assert.equal(
        requests.some((url) => url.includes('/movie/VidRock/')),
        false
    );
});

test('cross-family allowlist disables EzVid leaf fan-out while retaining family provider behavior', async () => {
    const { provider, requests } = fixture({
        environment: {
            [GLOBAL_LEAF_ALLOW_ENV]: 'tulnex:onion'
        }
    });
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(requests, ['https://api.ezvidapi.com/list']);
});

test('one failed leaf preserves successful sibling order and partial diagnostics', async () => {
    const result = await fixture({
        list: ['VidSrc', 'VidRock', 'Popr'],
        fail: new Set(['vidrock'])
    }).provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        ['ezvidapi:vidsrc', 'ezvidapi:popr']
    );
    assert.equal(result.diagnostics[0]?.code, 'PARTIAL_SCRAPE');
    assert.match(result.diagnostics[0]?.message ?? '', /1 of 3/);
});
