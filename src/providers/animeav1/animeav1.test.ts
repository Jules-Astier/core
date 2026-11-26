import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimeAv1Provider } from './animeav1.js';
const media = {
    type: 'tv' as const,
    tmdbId: '37854',
    title: 'One Piece',
    releaseYear: '1999',
    imdbId: '',
    s: 1,
    e: 1
};
function fixture(
    o: {
        wrongEpisode?: boolean;
        badPlayer?: boolean;
        html?: boolean;
        wrongTitle?: boolean;
    } = {}
) {
    const calls: string[] = [];
    const provider = new AnimeAv1Provider({
        environment: { TMDB_API_KEY: 'fixture', ANIMEAV1_ENABLED: 'true' },
        fetch: async (input) => {
            const u = new URL(String(input));
            calls.push(u.href);
            if (u.hostname === 'api.themoviedb.org')
                return Response.json(
                    u.pathname.includes('/episode/')
                        ? { name: 'Episode One' }
                        : {
                              name: 'One Piece',
                              genres: [{ id: 16 }],
                              original_language: 'ja',
                              seasons: [{ season_number: 1, episode_count: 61 }]
                          }
                );
            if (u.pathname === '/media/one-piece')
                return new Response(
                    `<h1>${o.wrongTitle ? 'Other anime' : 'One Piece'}</h1>`
                );
            if (u.pathname === '/media/one-piece/1')
                return new Response(
                    `<h1>Episodio ${o.wrongEpisode ? 2 : 1}</h1><iframe src="https://${o.badPlayer ? '127.0.0.1' : 'player.zilla-networks.com'}/play/0123456789abcdef0123456789abcdef"></iframe>`
                );
            if (u.hostname === 'player.zilla-networks.com')
                return new Response(
                    o.html
                        ? '<html>Error</html>'
                        : '#EXTM3U\n#EXTINF:6,\nsegment.ts'
                );
            throw new Error('Unexpected request');
        }
    });
    return { provider, calls };
}
test('public HLS keeps Japanese audio distinct from Spanish subtitles', async () => {
    const { provider } = fixture();
    const r = await provider.getTVSources(media);
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].type, 'hls');
    assert.equal(r.sources[0].audioTracks[0].language, 'ja');
    assert.match(r.sources[0].provider.name, /Spanish subtitles/);
    assert.deepEqual(r.subtitles, []);
});
test('wrong series or episode never selects the first available player', async () => {
    for (const o of [{ wrongTitle: true }, { wrongEpisode: true }])
        assert.equal(
            (await fixture(o).provider.getTVSources(media)).sources.length,
            0
        );
});
test('unknown player host and HTML playlists cannot become sources', async () => {
    for (const o of [{ badPlayer: true }, { html: true }]) {
        const { provider, calls } = fixture(o);
        assert.equal((await provider.getTVSources(media)).sources.length, 0);
        assert.ok(!calls.some((u) => u.includes('127.0.0.1')));
    }
});
test('movies are unsupported', async () => {
    const p = new AnimeAv1Provider({ environment: {} });
    assert.equal((await p.getMovieSources()).sources.length, 0);
});
test('framework episode-title input is not used as the series slug', async () => {
    const { provider } = fixture();
    assert.equal(
        (await provider.getTVSources({ ...media, title: 'An episode title' }))
            .sources.length,
        1
    );
});
