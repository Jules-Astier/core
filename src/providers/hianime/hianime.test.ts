import assert from 'node:assert/strict';
import test from 'node:test';
import { HiAnimeProvider, absoluteEpisode, decodePlayer } from './hianime.js';

const media = {
    type: 'tv' as const,
    tmdbId: '37854',
    title: 'One Piece',
    releaseYear: '1999',
    imdbId: 'tt0388629',
    s: 2,
    e: 1
};
function player(value: unknown) {
    const raw = Buffer.from(JSON.stringify(value)),
        key = Buffer.from('otaku-embed-v1');
    for (let i = 0; i < raw.length; i++) raw[i] ^= key[i % key.length];
    return `window.__P="${raw.toString('base64')}";`;
}
function fixture(
    options: {
        ambiguous?: boolean;
        badMedia?: boolean;
        htmlMedia?: boolean;
        premium?: boolean;
    } = {}
) {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
        const u = new URL(String(input));
        calls.push(u.href);
        if (u.hostname === 'api.themoviedb.org')
            return Response.json({
                genres: [{ id: 16 }],
                original_language: 'ja',
                seasons: [
                    { season_number: 1, episode_count: 61 },
                    { season_number: 2, episode_count: 16 }
                ]
            });
        if (u.pathname === '/search')
            return new Response(
                `<h3 class="film-name"><a title="One Piece" href="/one-piece-1">One Piece</a></h3>${options.ambiguous ? '<h3 class="film-name"><a title="One Piece" href="/one-piece-2">One Piece</a></h3>' : ''}`
            );
        if (u.pathname.includes('/episode/list/'))
            return Response.json({
                status: true,
                html: '<a class="ep-item" data-number="1" data-id="wrong"></a><a class="ep-item" data-number="62" data-id="2062"></a>'
            });
        if (u.pathname.includes('/episode/servers')) {
            assert.equal(u.searchParams.get('episodeId'), '2062');
            const hash = Buffer.from(
                'https://zokoanime.video/stream/mal/21/62/sub'
            ).toString('base64');
            return Response.json({
                status: true,
                html: `<div class="server-item" data-type="sub" data-hash="${hash}"></div>`
            });
        }
        if (u.hostname === 'zokoanime.video')
            return new Response(
                player({
                    src: options.badMedia
                        ? 'https://127.0.0.1/private.m3u8'
                        : 'https://hls.dramahot.top/synthetic/master.m3u8',
                    subtitles: [
                        {
                            src: 'https://hls.dramahot.top/synthetic/en.vtt',
                            label: 'English'
                        }
                    ]
                })
            );
        if (u.hostname === 'hls.dramahot.top')
            return new Response(
                options.htmlMedia
                    ? '<html>Error</html>'
                    : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8'
            );
        throw new Error('Unexpected request');
    };
    return {
        calls,
        provider: new HiAnimeProvider({
            fetch: fetchImpl,
            environment: {
                HIANIME_ENABLED: 'true',
                TMDB_API_KEY: 'fixture-secret'
            }
        })
    };
}
test('absolute numbering sums only known preceding seasons and excludes specials', () => {
    const series = {
        seasons: [
            { season_number: 0, episode_count: 10 },
            { season_number: 1, episode_count: 61 },
            { season_number: 2, episode_count: 16 }
        ]
    };
    assert.equal(absoluteEpisode(series, 2, 1), 62);
    for (const [s, e] of [
        [0, 1],
        [2, 17],
        [3, 1],
        [1, 0],
        [1, 1.5]
    ])
        assert.equal(absoluteEpisode(series, s, e), null);
    assert.equal(
        absoluteEpisode(
            { seasons: [{ season_number: 2, episode_count: 20 }] },
            2,
            1
        ),
        null
    );
});
test('public serialization decoder is data-only and rejects script/malformed objects', () => {
    assert.deepEqual(decodePlayer(player({ src: 'synthetic' })), {
        src: 'synthetic'
    });
    assert.throws(() => decodePlayer('eval("bad")'));
    assert.throws(() => decodePlayer(player([])));
});
test('resolves exact absolute episode and wraps verified media and subtitles', async () => {
    const { provider } = fixture();
    const r = await provider.getTVSources(media);
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].type, 'hls');
    assert.equal(r.sources[0].audioTracks[0].language, 'ja');
    assert.equal(r.subtitles[0].format, 'vtt');
    const proxy = JSON.parse(
        new URL(r.sources[0].url).searchParams.get('data')!
    );
    assert.equal(proxy.headers.Referer, 'https://zokoanime.video/');
});
test('ambiguous titles never guess an anime', async () => {
    const { provider, calls } = fixture({ ambiguous: true });
    assert.equal((await provider.getTVSources(media)).sources.length, 0);
    assert.ok(!calls.some((u) => u.includes('/episode/list/')));
});
test('unknown media hosts cannot be fetched', async () => {
    const { provider, calls } = fixture({ badMedia: true });
    assert.equal((await provider.getTVSources(media)).sources.length, 0);
    assert.ok(!calls.some((u) => u.includes('127.0.0.1')));
});
test('HTML media errors fail verification without leaking keys or signed URLs', async () => {
    const { provider } = fixture({ htmlMedia: true });
    const r = await provider.getTVSources(media);
    assert.equal(r.sources.length, 0);
    assert.ok(!JSON.stringify(r).includes('fixture-secret'));
});
test('provider is opt-in; movies remain unsupported', async () => {
    const p = new HiAnimeProvider({ environment: {} });
    assert.equal(p.enabled, false);
    assert.equal((await p.getMovieSources()).sources.length, 0);
});
