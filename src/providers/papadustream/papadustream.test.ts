import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import {
    PapadustreamProvider,
    extractPapadustreamPlaylist,
    parsePapadustreamManifest
} from './papadustream.js';

const contractModulePath = '../../../test/support/provider-contract.js';
const { assertProviderResultContract } = (await import(contractModulePath)) as {
    assertProviderResultContract: (
        result: ProviderResult,
        options: {
            providerId: string;
            allowedTypes?: readonly SourceType[];
            minimumSources?: number;
        }
    ) => void;
};
const episode = {
    type: 'tv',
    tmdbId: '96677',
    imdbId: 'tt2531336',
    title: 'Lupin',
    releaseYear: '2021',
    s: 1,
    e: 1
} as ProviderMediaObject;
const movie = {
    type: 'movie',
    tmdbId: '77338',
    imdbId: 'tt1675434',
    title: 'Intouchables',
    releaseYear: '2011'
} as ProviderMediaObject;
const episodePath =
    '/hls/p/1700000000/synthetic/s5/serial/tt2531336/1/1/playlist.m3u8';
const moviePath =
    '/hls/p/1700000000/synthetic/s5/movie/tt1675434/playlist.m3u8';
const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English stereo",LANGUAGE="en",URI="audio/en/audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French [Original] 5.1 2",LANGUAGE="fr",URI="audio/fr_2/audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French [Original] stereo 4",LANGUAGE="fr",URI="audio/fr_4/audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French - Audio Description stereo 3",LANGUAGE="fr",URI="audio/fr_3/audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fr",URI="subtitles/fr.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="audio"',
    '1080/playlist.m3u8'
].join('\n');
function episodeHtml(path = episodePath) {
    return `const EPISODES=${JSON.stringify([
        { url: path, season: 1, episode: 1, title: 'Chapter 1' },
        { url: path.replace('/1/1/', '/1/2/'), season: 1, episode: 2 }
    ])};`;
}
function fixture(
    options: {
        html?: string;
        master?: string;
        firstPlaylistStatus?: number;
    } = {}
) {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    let playlistFetches = 0;
    const provider = new PapadustreamProvider({
        environment: { PAPADUSTREAM_ENABLED: 'true' },
        fetch: async (input, init) => {
            const url = new URL(String(input));
            requests.push({ url, init });
            if (url.pathname.startsWith('/hls/')) {
                playlistFetches++;
                if (playlistFetches === 1 && options.firstPlaylistStatus)
                    return new Response('expired', {
                        status: options.firstPlaylistStatus
                    });
                return new Response(options.master ?? manifest);
            }
            return new Response(
                options.html ??
                    (url.pathname.startsWith('/films/')
                        ? `<source src="${moviePath}">`
                        : episodeHtml())
            );
        }
    });
    return { provider, requests };
}

for (const media of [episode, movie])
    test(`resolves exact ${media.type} identity and preserves manifest audio evidence`, async () => {
        const f = fixture();
        const result = await (media.type === 'movie'
            ? f.provider.getMovieSources(media)
            : f.provider.getTVSources(media));
        assertProviderResultContract(result, {
            providerId: 'papadustream',
            allowedTypes: ['hls'],
            minimumSources: 1
        });
        assert.equal(result.sources.length, 1);
        assert.equal(result.sources[0].quality, '1080p');
        assert.deepEqual(
            result.sources[0].audioTracks.map((x) => x.language),
            ['fr', 'en', 'fr', 'fr']
        );
        assert.equal(
            result.sources[0].audioTracks[0].label,
            'French [Original] stereo 4'
        );
        assert.equal(
            f.requests[0].url.pathname,
            `/${media.type === 'movie' ? 'films' : 'series'}/${media.imdbId}`
        );
        const data = JSON.parse(
            new URL(result.sources[0].url).searchParams.get('data')!
        );
        assert.equal(
            new URL(data.url).pathname,
            media.type === 'movie' ? moviePath : episodePath
        );
        assert.equal(data.preferredAudioLanguage, 'fr');
        assert.equal(data.headers.Origin, 'https://www.papadustream.club');
        assert.equal(data.headers.Referer, f.requests[0].url.href);
    });

test('does not substitute another season, episode, or IMDb identity', () => {
    assert.equal(
        extractPapadustreamPlaylist(episodeHtml(), { ...episode, s: 2 }),
        null
    );
    assert.equal(
        extractPapadustreamPlaylist(episodeHtml(), { ...episode, e: 3 }),
        null
    );
    assert.equal(
        extractPapadustreamPlaylist(episodeHtml(), {
            ...episode,
            imdbId: 'tt4277922'
        }),
        null
    );
    assert.equal(
        extractPapadustreamPlaylist(`<source src="${moviePath}">`, {
            ...movie,
            imdbId: 'tt0000000'
        }),
        null
    );
    assert.equal(
        extractPapadustreamPlaylist('const EPISODES=[broken-json];', episode),
        null
    );
});

test('does not infer French audio or original-language status from domain or subtitles', async () => {
    const onlySubs =
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="fr",NAME="French",URI="fr.m3u8"\nvideo.m3u8\n';
    const result = await fixture({ master: onlySubs }).provider.getMovieSources(
        movie
    );
    assert.deepEqual(result.sources[0].audioTracks, [
        { language: 'und', label: 'Unknown audio' }
    ]);
    assert.equal(
        JSON.parse(new URL(result.sources[0].url).searchParams.get('data')!)
            .preferredAudioLanguage,
        undefined
    );
    const parsed = parsePapadustreamManifest(manifest)!;
    assert.equal(parsed.audio[0].original, null);
    assert.equal(parsed.audio[1].original, true);
    assert.equal(parsed.audio[3].original, null);
    assert.deepEqual(parsed.subtitleLanguages, ['fr']);
    assert.equal(parsePapadustreamManifest('#EXTM3U\n# comment only'), null);
});

test('refreshes an expired playlist once using a newly requested public page', async () => {
    const f = fixture({ firstPlaylistStatus: 403 });
    const result = await f.provider.getTVSources(episode);
    assert.equal(result.sources.length, 1);
    assert.equal(f.requests.length, 4);
    assert.equal(
        f.requests.filter((r) => r.url.pathname.startsWith('/series/')).length,
        2
    );
});

test('fails closed on invalid identities, malformed pages, unavailable manifests, and external playlist origins', async () => {
    for (const media of [
        { ...episode, imdbId: '' },
        { ...episode, s: 0 },
        { ...episode, e: -1 }
    ]) {
        const f = fixture();
        const result = await f.provider.getTVSources(media);
        assert.equal(result.sources.length, 0);
        assert.equal(f.requests.length, 0);
    }
    for (const options of [
        { html: '<html>missing episode</html>' },
        { master: '<html>not a playlist</html>' },
        { html: episodeHtml('https://other.example.test' + episodePath) }
    ]) {
        const result = await fixture(options).provider.getTVSources(episode);
        assert.equal(result.sources.length, 0);
        assert.equal(result.diagnostics[0]?.code, 'PROVIDER_ERROR');
    }
});

test('accepts only a credential-free HTTPS custom origin', () => {
    for (const value of [
        'http://provider.example.test',
        'https://user:pass@provider.example.test',
        'https://provider.example.test/path',
        'https://provider.example.test/?token=secret'
    ])
        assert.throws(
            () =>
                new PapadustreamProvider({
                    environment: { PAPADUSTREAM_BASE_URL: value }
                })
        );
});
