import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderMediaObject } from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import {
    createPoprLeafPolicy,
    POPR_ALLOW_ENV,
    POPR_DENY_ENV,
    POPR_LEAVES
} from './popr.config.js';
import { PoprProvider, redactPoprDiagnostic } from './popr.js';

const movie = { type: 'movie', tmdbId: 'fixture-42' } as ProviderMediaObject;
const identified = (source: unknown) => source as IdentifiedSource;

function fixtureProvider(
    options: {
        failed?: ReadonlySet<string>;
        sameUrl?: boolean;
        policy?: ReturnType<typeof createPoprLeafPolicy>;
    } = {}
) {
    const requests: string[] = [];
    const failed = options.failed ?? new Set<string>();
    const fetchFixture: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push(url);

        if (url.startsWith('https://media.invalid/')) {
            assert.equal(init?.redirect, 'follow');
            return new Response('#EXTM3U\nsegment.ts', {
                status: 200,
                headers: { 'content-type': 'application/vnd.apple.mpegurl' }
            });
        }

        const parsed = new URL(url);
        const requestName = parsed.searchParams.get('server') ?? 'default';
        const leaf = POPR_LEAVES.find(
            (candidate) => candidate.requestName === requestName
        );
        assert.ok(leaf, `unexpected fixture URL: ${url}`);
        if (failed.has(leaf.id)) throw new Error('synthetic leaf failure');

        const streamUrl = options.sameUrl
            ? 'https://media.invalid/shared/master.m3u8'
            : `https://media.invalid/${encodeURIComponent(leaf.id)}/master.m3u8`;
        return new Response(
            JSON.stringify({
                success: true,
                results: [
                    {
                        server: leaf.requestName,
                        serverName: leaf.displayName,
                        streams: [
                            {
                                url: streamUrl,
                                quality: '1080p',
                                isM3U8: true,
                                headers: {
                                    Referer: 'https://leaf.invalid/',
                                    Origin: 'https://leaf.invalid'
                                }
                            }
                        ],
                        subtitles: []
                    }
                ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        );
    };

    return {
        provider: new PoprProvider({
            fetch: fetchFixture,
            leafPolicy:
                options.policy ?? createPoprLeafPolicy(Object.create(null))
        }),
        requests
    };
}

test('maps all ten request spellings to exact identities in legacy order', async () => {
    const { provider, requests } = fixtureProvider();
    const result = await provider.getMovieSources(movie);

    assert.deepEqual(
        result.sources.map((source) => ({
            id: source.provider.id,
            name: source.provider.name,
            family: identified(source).providerFamilyId,
            upstream: identified(source).upstreamId
        })),
        POPR_LEAVES.map((leaf) => ({
            id: leaf.id,
            name: leaf.displayName,
            family: 'popr',
            upstream: leaf.id
        }))
    );
    assert.deepEqual(
        requests
            .filter((url) => url.includes('/api/vidnest'))
            .map((url) => new URL(url).searchParams.get('server') ?? 'default'),
        POPR_LEAVES.map((leaf) => leaf.requestName)
    );
});

test('keeps same-URL sources attributed to distinct leaves', async () => {
    const result = await fixtureProvider({
        sameUrl: true
    }).provider.getMovieSources(movie);
    assert.equal(new Set(result.sources.map((source) => source.url)).size, 1);
    assert.equal(
        new Set(result.sources.map((source) => identified(source).upstreamId))
            .size,
        POPR_LEAVES.length
    );
});

test('one rejected leaf does not disable or reorder siblings', async () => {
    const result = await fixtureProvider({
        failed: new Set(['popr:sigma'])
    }).provider.getMovieSources(movie);
    assert.deepEqual(
        result.sources.map((source) => identified(source).upstreamId),
        POPR_LEAVES.filter(({ id }) => id !== 'popr:sigma').map(({ id }) => id)
    );
    assert.deepEqual(result.diagnostics, []);
});

test('allow and deny switches accept exact catalog spellings and deny wins', async () => {
    const policy = createPoprLeafPolicy({
        [POPR_ALLOW_ENV]: 'Gama,Liligoon,Sigma,Prime,Alfa,Lamda,ynx_vidsrc',
        [POPR_DENY_ENV]: 'popr:sigma,ynx-vidsrc'
    });
    const result = await fixtureProvider({ policy }).provider.getMovieSources(
        movie
    );
    assert.deepEqual(
        result.sources.map((source) => identified(source).upstreamId),
        ['popr:gama', 'popr:liligoon', 'popr:prime', 'popr:alfa', 'popr:lamda']
    );
});

test('unset switches preserve the legacy ten-leaf behavior', async () => {
    const policy = createPoprLeafPolicy({});
    assert.ok(POPR_LEAVES.every(policy.enabled));
    assert.equal(
        (await fixtureProvider({ policy }).provider.getMovieSources(movie))
            .sources.length,
        10
    );
});

test('invalid startup policy and diagnostics redact deployment or URL secrets', () => {
    const secret = 'unknown-leaf-super-secret';
    assert.throws(
        () => createPoprLeafPolicy({ [POPR_DENY_ENV]: secret }),
        (error: Error) =>
            error.message.includes(POPR_DENY_ENV) &&
            !error.message.includes(secret)
    );
    assert.throws(
        () =>
            createPoprLeafPolicy({
                [POPR_ALLOW_ENV]: 'Gama,popr:gama'
            }),
        /duplicate/
    );
    const diagnostic = redactPoprDiagnostic(
        'failed https://media.invalid/master.m3u8?token=very-secret'
    );
    assert.equal(diagnostic, 'failed [redacted-url]');
    assert.ok(!diagnostic.includes('very-secret'));
});
