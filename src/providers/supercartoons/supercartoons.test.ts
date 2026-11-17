import test from 'node:test';
import assert from 'node:assert/strict';
import { SuperCartoonsProvider } from './supercartoons.js';
const movie = {
    type: 'movie' as const,
    tmdbId: '1234',
    title: 'The Cat Concerto',
    releaseYear: '1947',
    imdbId: ''
};
function fixture(
    o: {
        wrongSeries?: boolean;
        badUrl?: boolean;
        notAnimation?: boolean;
        duplicate?: boolean;
    } = {}
) {
    const calls: string[] = [];
    const provider = new SuperCartoonsProvider({
        environment: { TMDB_API_KEY: 'fixture', SUPERCARTOONS_ENABLED: 'true' },
        fetch: async (input) => {
            const u = new URL(String(input));
            calls.push(u.href);
            if (u.hostname === 'api.themoviedb.org') {
                if (u.pathname.includes('/episode/'))
                    return Response.json({ name: 'The Cat Concerto' });
                return Response.json({
                    name: 'Tom and Jerry',
                    title: 'The Cat Concerto',
                    genres: [{ id: o.notAnimation ? 18 : 16 }],
                    original_language: 'en',
                    seasons: [{ season_number: 1, episode_count: 10 }]
                });
            }
            if (u.searchParams.has('s'))
                return new Response(
                    `<a href="/cartoon/the-cat-concerto/">The Cat Concerto</a>${o.duplicate ? '<a href="/cartoon/the-cat-concerto-remake/">The Cat Concerto</a>' : ''}`
                );
            if (u.pathname.startsWith('/cartoon/'))
                return new Response(
                    `<h1>The Cat Concerto</h1><a href="/series/tom-and-jerry/">${o.wrongSeries ? 'Other Series' : 'Tom and Jerry'}</a><script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'VideoObject', contentUrl: o.badUrl ? 'https://127.0.0.1/private.mp4' : 'https://ww.supercartoons.net/synthetic.mp4', inLanguage: 'en-US' }] })}</script>`
                );
            if (u.hostname === 'ww.supercartoons.net')
                return new Response(
                    Buffer.from([
                        0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109
                    ]),
                    { status: 206 }
                );
            throw new Error('Unexpected request');
        }
    });
    return { provider, calls };
}
test('public classic movie is verified as MP4 and attributed to declared language', async () => {
    const { provider } = fixture();
    const r = await provider.getMovieSources(movie);
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].audioTracks[0].language, 'en');
    assert.equal(r.sources[0].type, 'mp4');
});
test('TV lookup uses episode title and refuses a foreign series', async () => {
    const { provider } = fixture({ wrongSeries: true });
    const r = await provider.getTVSources({
        ...movie,
        type: 'tv',
        title: 'Tom and Jerry',
        s: 1,
        e: 2
    });
    assert.equal(r.sources.length, 0);
    assert.match(r.diagnostics[0].message, /series identity/);
});
test('ambiguous classic titles and foreign media hosts fail closed', async () => {
    for (const options of [{ duplicate: true }, { badUrl: true }]) {
        const { provider, calls } = fixture(options);
        assert.equal((await provider.getMovieSources(movie)).sources.length, 0);
        assert.ok(!calls.some((u) => u.includes('127.0.0.1')));
    }
});
test('non-animation records are skipped and provider defaults disabled', async () => {
    const { provider } = fixture({ notAnimation: true });
    assert.equal((await provider.getMovieSources(movie)).sources.length, 0);
    assert.equal(new SuperCartoonsProvider({ environment: {} }).enabled, false);
});
test('TV episode lookup keeps canonical TMDB series and episode names separate', async () => {
    const { provider } = fixture();
    const result = await provider.getTVSources({
        ...movie,
        type: 'tv',
        title: 'An episode title',
        s: 1,
        e: 2
    });
    assert.equal(result.sources.length, 1);
});
