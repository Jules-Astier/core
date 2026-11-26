import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import { HydraVipProvider } from './hydravip.js';

const contractModulePath = '../../../test/support/provider-contract.js';
const { assertProviderResultContract } = (await import(contractModulePath)) as {
    assertProviderResultContract: (
        result: ProviderResult,
        options: { providerId: string; allowedTypes: readonly SourceType[] }
    ) => void;
};

const PLAYER = 'http://headlessvidx:3202';
const MASTER = 'https://hls.shegu.net/mock.m3u8?token=fixture%2Btok&b=2';
const TMDB_KEY = 'fixture-key';
const EPISODE: ProviderMediaObject = {
    type: 'tv',
    tmdbId: '248830',
    imdbId: '',
    title: 'Fixture episode name',
    releaseYear: '2026',
    s: 2,
    e: 5
};

function relayPath(resource: string) {
    const url = new URL('/public-player/hydravip/media', PLAYER);
    url.searchParams.set('url', resource);
    return url.pathname + url.search;
}

const AUDIO = relayPath('https://hls.shegu.net/en/audio.m3u8');
const VIDEO = relayPath('https://hls.shegu.net/1080/index.m3u8');
const SEGMENTS = [
    '#EXTM3U',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",URI="${AUDIO}"`,
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="audio"',
    VIDEO
].join('\n');

function fixture({
    tmdb = () =>
        Response.json({
            id: 248830,
            name: 'Fixture series name',
            first_air_date: '2025-06-04'
        }),
    resolver = () => Response.json({ status: 'resolved', playlistUrl: MASTER }),
    manifest = SEGMENTS,
    environment = {
        CINEPRO_HEADLESSVIDX_BASE_URL: PLAYER,
        TMDB_API_KEY: TMDB_KEY
    }
}: {
    tmdb?: () => Response;
    resolver?: () => Response;
    manifest?: string;
    environment?: NodeJS.ProcessEnv;
} = {}) {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const provider = new HydraVipProvider({
        environment,
        fetch: async (input, init) => {
            const url = new URL(String(input));
            calls.push({ url, init });
            if (url.hostname === 'api.themoviedb.org') return tmdb();
            if (url.pathname === '/public-player/hydravip') return resolver();
            if (url.pathname === '/public-player/hydravip/media')
                return new Response(manifest);
            throw new Error('unexpected fixture request');
        }
    });
    return { provider, calls };
}

test('resolves the exact canonical series and emits the native HLS master with audio metadata', async () => {
    const { provider, calls } = fixture();
    assert.equal(provider.enabled, true);
    assert.deepEqual(provider.capabilities.supportedContentTypes, ['tv']);
    const result = await provider.getTVSources(EPISODE);
    assertProviderResultContract(result, {
        providerId: 'hydravip',
        allowedTypes: ['hls']
    });
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].quality, '1080p');
    assert.deepEqual(result.sources[0].audioTracks, [
        { language: 'en', label: 'English' }
    ]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url.pathname, '/3/tv/248830');
    assert.equal(calls[0].url.searchParams.get('api_key'), TMDB_KEY);
    assert.equal(calls[1].url.href, `${PLAYER}/public-player/hydravip`);
    assert.equal(calls[1].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
        tmdbId: '248830',
        seriesTitle: 'Fixture series name',
        firstAirYear: 2025,
        season: 2,
        episode: 5
    });
    assert.doesNotMatch(
        JSON.stringify(calls.slice(1)),
        /fixture-key|Fixture episode name/
    );
    assert.equal(calls[2].url.searchParams.get('url'), MASTER);
    assert.ok(
        calls.every(({ init }) => init?.redirect === 'error' && init.signal)
    );
    const proxyData = new URL(result.sources[0].url).searchParams.get('data');
    assert.ok(proxyData);
    const target: { url: string; headers: Record<string, string> } =
        JSON.parse(proxyData);
    assert.equal(target.url, PLAYER + relayPath(MASTER));
    assert.deepEqual(Object.keys(target.headers), ['Accept']);
});

test('requires configured service and key and honors an explicit opt-out', async () => {
    const configured = {
        CINEPRO_HEADLESSVIDX_BASE_URL: PLAYER,
        TMDB_API_KEY: TMDB_KEY
    };
    for (const environment of [
        { ...configured, HYDRAVIP_ENABLED: 'false' },
        { ...configured, TMDB_API_KEY: undefined },
        { ...configured, HYDRAVIP_HEADLESSVIDX_BASE_URL: '' },
        { ...configured, HYDRAVIP_HEADLESSVIDX_BASE_URL: `${PLAYER}/invalid` }
    ]) {
        assert.equal(fixture({ environment }).provider.enabled, false);
    }

    const dedicated = fixture({
        environment: {
            ...configured,
            CINEPRO_HEADLESSVIDX_BASE_URL: 'http://unused.example',
            HYDRAVIP_HEADLESSVIDX_BASE_URL: PLAYER
        }
    });
    assert.equal(dedicated.provider.enabled, true);
    assert.equal(
        (await dedicated.provider.getTVSources(EPISODE)).sources.length,
        1
    );
    assert.equal(dedicated.calls[1].url.origin, PLAYER);
});

test('rejects ambiguous inputs and skips an unconfigured installation', async () => {
    const { provider, calls } = fixture({ environment: {} });
    assert.equal(provider.enabled, false);
    assert.deepEqual((await provider.getMovieSources()).sources, []);
    assert.match(
        (await provider.getTVSources({ ...EPISODE, e: 0 })).diagnostics[0]
            .message,
        /season and episode/
    );
    assert.match(
        (await provider.getTVSources(EPISODE)).diagnostics[0].message,
        /service origin/
    );
    assert.deepEqual(calls, []);

    const wrongSeries = fixture({
        tmdb: () =>
            Response.json({
                id: 44006,
                name: 'Another show',
                first_air_date: '2012-01-01'
            })
    });
    const result = await wrongSeries.provider.getTVSources(EPISODE);
    assert.match(
        result.diagnostics[0].message,
        /canonical TMDB series metadata/
    );
    assert.equal(wrongSeries.calls.length, 1);
});

test('does not follow unavailable, blocked or untrusted player responses', async () => {
    for (const [response, diagnostic] of [
        [() => Response.json({ status: 'not-found' }), /exact episode/],
        [() => Response.json({ status: 'blocked' }), /blocked/],
        [
            () => new Response('discard-this', { status: 403 }),
            /blocked \(403\)/
        ],
        [
            () =>
                Response.json({
                    status: 'resolved',
                    playlistUrl: 'https://untrusted.invalid/hls.m3u8'
                }),
            /unexpected playlist/
        ],
        [
            () =>
                Response.json({
                    status: 'resolved',
                    playlistUrl: MASTER.replace('https:', 'http:')
                }),
            /unexpected playlist/
        ],
        [
            () =>
                Response.json({
                    status: 'resolved',
                    playlistUrl: MASTER.replace(
                        'hls.shegu.net',
                        'hls.shegu.net.untrusted.invalid'
                    )
                }),
            /unexpected playlist/
        ],
        [
            () =>
                Response.json({
                    status: 'resolved',
                    playlistUrl: MASTER.replace(
                        'hls.shegu.net',
                        'private@hls.shegu.net'
                    )
                }),
            /unexpected playlist/
        ]
    ] as const) {
        const { provider, calls } = fixture({ resolver: response });
        const result = await provider.getTVSources(EPISODE);
        assert.deepEqual(result.sources, []);
        assert.match(result.diagnostics[0].message, diagnostic);
        assert.doesNotMatch(
            JSON.stringify(result.diagnostics),
            /discard-this|fixture-key/
        );
        assert.equal(calls.length, 2);
    }
});

test('rejects audio-only masters and prevents untrusted child URLs entering the proxy', async () => {
    for (const manifest of [
        SEGMENTS.replace(VIDEO, 'https://hls.shegu.net/unwrapped.m3u8'),
        SEGMENTS.replace(
            AUDIO,
            relayPath('https://untrusted.invalid/audio.m3u8')
        ),
        SEGMENTS.replace(
            AUDIO,
            relayPath('https://hls.shegu.net.evil.invalid/audio.m3u8')
        ),
        SEGMENTS.replace(VIDEO, `https://untrusted.invalid${VIDEO}`),
        SEGMENTS.replace(',RESOLUTION=1920x1080', ',CODECS="mp4a.40.2"')
    ]) {
        const { provider } = fixture({ manifest });
        const result = await provider.getTVSources(EPISODE);
        assert.deepEqual(result.sources, []);
        assert.match(result.diagnostics[0].message, /valid video master/);
    }
});
