import assert from 'node:assert/strict';
import test from 'node:test';
import { WcoProvider, publicIframe, readPublicWcoPage } from './wco.js';
const media = {
    type: 'tv' as const,
    tmdbId: '37854',
    title: 'One Piece',
    releaseYear: '1999',
    imdbId: 'tt0388629',
    s: 1,
    e: 1
};
function encoded(html: string) {
    const values = [...Buffer.from(html)].map((n) =>
        Buffer.from('abc' + (n + 66666602) + 'xyz').toString('base64')
    );
    return `<script>var text="";var chars=${JSON.stringify(values)};chars.forEach(function test(value){text += String.fromCharCode(parseInt(atob(value).replace(/\\D/g,'')) - 66666602);});document.write(decodeURIComponent(escape(text)));</script>`;
}
const iframe =
    '<iframe src="https://embed.wcostream.com/inc/embed/index.php?file=synthetic&h=synthetic"></iframe>';
test('public character-array iframe decoder is data-only and host constrained', () => {
    assert.equal(
        publicIframe(encoded(iframe)),
        new URL(
            'https://embed.wcostream.com/inc/embed/index.php?file=synthetic&h=synthetic'
        ).href
    );
    assert.equal(
        publicIframe('<iframe src="https://127.0.0.1/private"></iframe>'),
        null
    );
    assert.equal(publicIframe('<script>eval("bad")</script>'), null);
    assert.equal(
        publicIframe('This Video Is for Premium Users' + iframe),
        null
    );
});
function fixture(
    options: {
        premium?: boolean;
        badRedirect?: boolean;
        htmlMedia?: boolean;
        wrongTitle?: boolean;
    } = {}
) {
    const calls: string[] = [];
    const provider = new WcoProvider({
        environment: { WCO_ENABLED: 'true', TMDB_API_KEY: 'fixture-secret' },
        fetch: async (input, init) => {
            const u = new URL(String(input));
            calls.push(u.href);
            if (u.hostname === 'api.themoviedb.org')
                return Response.json({
                    name: 'One Piece',
                    genres: [{ id: 16 }],
                    original_language: 'ja',
                    seasons: [{ season_number: 1, episode_count: 61 }]
                });
            if (u.pathname === '/anime/one-piece')
                return new Response(
                    `<h1>${options.wrongTitle ? 'Other title' : 'One Piece'}</h1><a href="/one-piece-episode-10-english-subbed">Episode 10</a><a href="/one-piece-episode-1-english-subbed">Episode 1</a>`
                );
            if (u.hostname === 'www.wco.tv')
                return new Response(
                    options.premium
                        ? 'This Video Is for Premium Users'
                        : encoded(iframe)
                );
            if (u.pathname.endsWith('video-js.php'))
                return new Response(
                    '<script>$.getJSON("/inc/embed/getvidlink.php?v=synthetic", function(r){});</script>'
                );
            if (u.pathname.endsWith('getvidlink.php')) {
                const headers = new Headers(init?.headers);
                assert.equal(headers.get('X-Requested-With'), 'XMLHttpRequest');
                assert.equal(
                    headers.get('Referer'),
                    'https://embed.wcostream.com/'
                );
                return Response.json({
                    server: 'https://neptun.wcostream.com',
                    fhd: 'synthetic-token'
                });
            }
            if (
                u.hostname === 'neptun.wcostream.com' &&
                u.searchParams.has('json')
            )
                return Response.json('https://neptun.wcostream.com/public.mp4');
            if (u.hostname === 'neptun.wcostream.com')
                return new Response(null, {
                    status: 302,
                    headers: {
                        location: options.badRedirect
                            ? 'https://127.0.0.1/private'
                            : 'https://e15.wcostream.com/synthetic.mp4'
                    }
                });
            if (u.hostname === 'e15.wcostream.com')
                return new Response(
                    options.htmlMedia
                        ? Buffer.from('<html>not video</html>')
                        : Buffer.from([
                              0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111,
                              109
                          ]),
                    { status: 206 }
                );
            throw new Error('Unexpected request');
        }
    });
    return { provider, calls };
}
test('exact public episode resolves verified ranged MP4 with required headers', async () => {
    const { provider, calls } = fixture();
    const r = await provider.getTVSources(media);
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].quality, '1080p');
    assert.equal(r.sources[0].audioTracks[0].language, 'ja');
    assert.ok(!calls.some((u) => u.includes('episode-10-')));
    const proxy = JSON.parse(
        new URL(r.sources[0].url).searchParams.get('data')!
    );
    assert.equal(proxy.headers.Referer, 'https://embed.wcostream.com/');
    assert.equal(proxy.url, 'https://e15.wcostream.com/synthetic.mp4');
});
test('premium-only episodes are not fetched through hidden or alternate players', async () => {
    const { provider, calls } = fixture({ premium: true });
    const r = await provider.getTVSources(media);
    assert.equal(r.sources.length, 0);
    assert.match(r.diagnostics![0].message, /premium account/);
    assert.ok(!calls.some((u) => u.includes('embed.wcostream.com')));
});
test('redirect to a private or unknown host is refused', async () => {
    const { provider, calls } = fixture({ badRedirect: true });
    assert.equal((await provider.getTVSources(media)).sources.length, 0);
    assert.ok(!calls.some((u) => u.includes('127.0.0.1')));
});
test('HTTP 200 HTML never counts as valid MP4', async () => {
    const { provider } = fixture({ htmlMedia: true });
    assert.equal((await provider.getTVSources(media)).sources.length, 0);
});
test('series identity mismatch does not fetch any episode', async () => {
    const { provider, calls } = fixture({ wrongTitle: true });
    assert.equal((await provider.getTVSources(media)).sources.length, 0);
    assert.ok(!calls.some((u) => u.includes('episode-1-')));
});
test('WCO is opt-in and does not claim movie support', async () => {
    const p = new WcoProvider({ environment: {} });
    assert.equal(p.enabled, false);
    assert.deepEqual(await p.getMovieSources(), {
        sources: [],
        subtitles: [],
        diagnostics: []
    });
});
test('framework episode-title input uses canonical TMDB series identity', async () => {
    const { provider } = fixture();
    const result = await provider.getTVSources({
        ...media,
        title: 'An episode title'
    });
    assert.equal(result.sources.length, 1);
});
test('public-page transport rejects non-WCO and private origins before spawning', async () => {
    for (const u of [
        'https://127.0.0.1/',
        'http://www.wco.tv/',
        'https://www.wco.tv.evil.invalid/'
    ]) {
        await assert.rejects(
            readPublicWcoPage(new URL(u), AbortSignal.timeout(1000))
        );
    }
});
