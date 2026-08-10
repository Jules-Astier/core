import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderMediaObject } from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import {
    createVidnestLeafPolicy,
    VIDNEST_ALLOW_ENV,
    VIDNEST_DENY_ENV,
    VIDNEST_DISABLED_LEAVES,
    VIDNEST_ELIGIBLE_LEAVES,
    VIDNEST_MISSING_HANDLERS
} from './vidnest.config.js';
import { VidNestProvider } from './vidnest.js';

const movie = {
    type: 'movie',
    tmdbId: 'fixture-42'
} as ProviderMediaObject;

function payload(leaf: string, sameUrl: boolean): unknown {
    const url = sameUrl
        ? 'https://media.invalid/shared/master.m3u8'
        : `https://media.invalid/${leaf}/master.m3u8`;
    switch (leaf) {
        case 'moviebox':
            return {
                headers: {},
                needConfig: false,
                provider: 'moviebox',
                proxy: true,
                url: [
                    {
                        lang: 'English',
                        link: url,
                        resolution: '1080p',
                        type: 'hls'
                    }
                ]
            };
        case 'allmovies':
            return {
                streams: [
                    {
                        headers: {},
                        language: 'English',
                        type: 'hls',
                        url
                    }
                ],
                totalLanguages: 1
            };
        case 'purstream':
            return {
                purstream_id: 1,
                title: 'Fixture',
                sources: [{ format: 'hls', name: '1080p', url }]
            };
        case 'hollymoviehd':
            return {
                streams: [
                    {
                        headers: { Referer: 'https://holly.invalid/' },
                        language: 'English',
                        type: 'hls',
                        url
                    }
                ],
                totalLanguages: 1
            };
        case 'vidlink':
            return {
                headers: { Referer: 'https://vidlink.invalid/' },
                provider: 'vidlink',
                data: {
                    sourceId: 'fixture',
                    stream: {
                        TTL: 1,
                        captions: [],
                        flags: [],
                        id: 'fixture',
                        qualities: {
                            '1080': {
                                headers: {
                                    Referer: 'https://cdn.vidlink.invalid/'
                                },
                                type: 'hls',
                                url
                            }
                        },
                        type: 'hls'
                    }
                }
            };
        case 'onehd':
            return {
                headers: { Referer: 'https://onehd.invalid/' },
                subtitles: [],
                url
            };
        case 'klikxxi':
            return {
                sources: [{ quality: '1080p', type: 'hls', url }],
                title: 'Fixture',
                year: '2026'
            };
        default:
            throw new Error('fixture attempted to decrypt an unsupported leaf');
    }
}

function fixtureProvider(
    options: {
        failed?: ReadonlySet<string>;
        malformed?: ReadonlySet<string>;
        sameUrl?: boolean;
        environment?: Record<string, string>;
    } = {}
) {
    const requests: string[] = [];
    const failed = options.failed ?? new Set<string>();
    const fetchFixture: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push(url);
        assert.deepEqual(init?.headers, {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://vidnest.fun/',
            Origin: 'https://vidnest.fun'
        });
        const leaf = new URL(url).pathname.split('/')[1]!;
        if (failed.has(leaf)) {
            throw new Error(
                'synthetic https://private.invalid/?token=do-not-log'
            );
        }
        return new Response(
            JSON.stringify({ encrypted: true, data: `fixture:${leaf}` }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        );
    };

    return {
        provider: new VidNestProvider({
            environment: options.environment ?? {},
            fetch: fetchFixture,
            decrypt: <T>(blob: string) =>
                options.malformed?.has(blob.slice('fixture:'.length))
                    ? (() => {
                          throw new Error(
                              'synthetic https://private.invalid/?token=do-not-log'
                          );
                      })()
                    : (payload(
                          blob.slice('fixture:'.length),
                          options.sameUrl ?? false
                      ) as T)
        }),
        requests
    };
}

test('maps every eligible handler to exact canonical identity in legacy order', async () => {
    const result = await fixtureProvider().provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map((source) => ({
            id: source.provider.id,
            name: source.provider.name,
            family: source.providerFamilyId,
            upstream: source.upstreamId,
            type: source.type
        })),
        VIDNEST_ELIGIBLE_LEAVES.map((leaf) => ({
            id: `vidnest:${leaf}`,
            name: 'VidNest',
            family: 'vidnest',
            upstream: `vidnest:${leaf}`,
            type: 'hls'
        }))
    );
});

test('maps current HollyMovieHD and VidLink schemas with required headers', async () => {
    const result = await fixtureProvider({
        environment: {
            [VIDNEST_ALLOW_ENV]: 'hollymoviehd,vidlink'
        }
    }).provider.getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    assert.deepEqual(
        sources.map(({ upstreamId, quality }) => ({ upstreamId, quality })),
        [
            { upstreamId: 'vidnest:hollymoviehd', quality: 'Auto' },
            { upstreamId: 'vidnest:vidlink', quality: '1080' }
        ]
    );
    const payloads = sources.map(({ url }) => {
        const encoded = new URL(url).searchParams.get('data');
        assert.ok(encoded);
        return JSON.parse(encoded);
    });
    assert.equal(payloads[0].headers.Referer, 'https://holly.invalid/');
    assert.equal(payloads[1].headers.Referer, 'https://cdn.vidlink.invalid/');
});

test('records exact seed-gated missing handlers and disabled delta set', () => {
    assert.deepEqual(VIDNEST_MISSING_HANDLERS, [
        { name: 'catflix', status: 'seed-needed', enabled: false },
        { name: 'lamda', status: 'seed-needed', enabled: false },
        { name: 'flixhq', status: 'seed-needed', enabled: false }
    ]);
    assert.deepEqual(VIDNEST_DISABLED_LEAVES, [
        { name: 'delta', status: 'disabled', enabled: false }
    ]);
});

test('keeps identical URLs distinct across eligible leaves', async () => {
    const result = await fixtureProvider({
        sameUrl: true
    }).provider.getMovieSources(movie);
    assert.equal(
        new Set(
            result.sources.map(({ url }) => {
                const encoded = new URL(url).searchParams.get('data');
                assert.ok(encoded);
                return JSON.parse(encoded).url;
            })
        ).size,
        1
    );
    assert.equal(
        new Set(
            (result.sources as IdentifiedSource[]).map(
                ({ upstreamId }) => upstreamId
            )
        ).size,
        VIDNEST_ELIGIBLE_LEAVES.length
    );
});

test('one failed handler preserves sibling order with one partial diagnostic', async () => {
    const result = await fixtureProvider({
        failed: new Set(['purstream'])
    }).provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        VIDNEST_ELIGIBLE_LEAVES.filter((leaf) => leaf !== 'purstream').map(
            (leaf) => `vidnest:${leaf}`
        )
    );
    assert.equal(result.diagnostics.length, 1);
    assert.ok(
        result.diagnostics.some(({ message }) =>
            message.includes('1/7 upstream requests failed')
        )
    );
    const serialized = JSON.stringify(result.diagnostics);
    assert.ok(!serialized.includes('private.invalid'));
    assert.ok(!serialized.includes('do-not-log'));
});

test('one malformed fulfilled handler preserves good siblings and redacts parser failures', async () => {
    const result = await fixtureProvider({
        malformed: new Set(['onehd'])
    }).provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        VIDNEST_ELIGIBLE_LEAVES.filter((leaf) => leaf !== 'onehd').map(
            (leaf) => `vidnest:${leaf}`
        )
    );
    assert.ok(
        result.diagnostics.some(({ message }) =>
            message.includes('onehd returned an unusable response')
        )
    );
    const serialized = JSON.stringify(result.diagnostics);
    assert.ok(!serialized.includes('private.invalid'));
    assert.ok(!serialized.includes('do-not-log'));
});

test('all failed requests report the exact failed count without raw errors', async () => {
    const result = await fixtureProvider({
        failed: new Set(VIDNEST_ELIGIBLE_LEAVES)
    }).provider.getMovieSources(movie);
    assert.equal(result.sources.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.match(
        result.diagnostics[0]?.message ?? '',
        new RegExp(
            `${VIDNEST_ELIGIBLE_LEAVES.length}/${VIDNEST_ELIGIBLE_LEAVES.length} upstream requests failed`
        )
    );
    assert.equal(result.diagnostics[0]?.severity, 'error');
});

test('allow and deny switches isolate eligible requests and deny wins', async () => {
    const { provider, requests } = fixtureProvider({
        environment: {
            [VIDNEST_ALLOW_ENV]: 'moviebox,onehd,klikxxi',
            [VIDNEST_DENY_ENV]: 'onehd'
        }
    });
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        ['vidnest:moviebox', 'vidnest:klikxxi']
    );
    assert.deepEqual(
        requests.map((url) => new URL(url).pathname.split('/')[1]),
        ['moviebox', 'klikxxi']
    );
});

test('startup validation rejects ineligible, unknown, and duplicate leaves without echoing values', () => {
    for (const leaf of ['catflix', 'lamda', 'flixhq', 'delta']) {
        assert.throws(
            () => createVidnestLeafPolicy({ [VIDNEST_ALLOW_ENV]: leaf }),
            /ineligible/
        );
    }
    const secret = 'unknown-super-secret-token';
    assert.throws(
        () => createVidnestLeafPolicy({ [VIDNEST_DENY_ENV]: secret }),
        (error: Error) =>
            error.message.includes(VIDNEST_DENY_ENV) &&
            !error.message.includes(secret)
    );
    assert.throws(
        () =>
            createVidnestLeafPolicy({
                [VIDNEST_ALLOW_ENV]: 'moviebox,moviebox'
            }),
        /duplicate/
    );
});

test('unset test switches request only implemented eligible leaves', async () => {
    const { provider, requests } = fixtureProvider();
    assert.deepEqual(
        { id: provider.id, name: provider.name, enabled: provider.enabled },
        { id: 'vidnest', name: 'VidNest', enabled: true }
    );
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(
        requests.map((url) => new URL(url).pathname.split('/')[1]),
        VIDNEST_ELIGIBLE_LEAVES
    );
    assert.equal(result.diagnostics.length, 0);
    const moviebox = (result.sources as IdentifiedSource[]).find(
        ({ upstreamId }) => upstreamId === 'vidnest:moviebox'
    );
    assert.ok(moviebox);
    const proxyData = new URL(moviebox.url).searchParams.get('data');
    assert.ok(proxyData);
    const proxyPayload = JSON.parse(proxyData);
    assert.equal(
        proxyPayload.url,
        'https://media.invalid/moviebox/master.m3u8'
    );
    assert.equal(proxyPayload.headers.Referer, 'https://vidnest.fun/');
});
