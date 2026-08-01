import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import { VixSrcProvider } from './vixsrc.js';

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

const BASE_URL = 'https://vixsrc.invalid';
const NOW = 1_700_000_000_000;
const EXPIRES = '2000000000';

const movie = {
    type: 'movie',
    tmdbId: '786892',
    imdbId: 'tt13539646',
    title: 'Furiosa: A Mad Max Saga',
    releaseYear: '2024'
} as ProviderMediaObject;

const episode = {
    type: 'tv',
    tmdbId: '1396',
    imdbId: 'tt0903747',
    title: 'Breaking Bad',
    releaseYear: '2008',
    s: 1,
    e: 1
} as ProviderMediaObject;

const embedHtml = `
<script>
window.streams = [{ url: 'https://decoy.invalid/not-the-master.m3u8' }];
window.masterPlaylist = {
    params: {
        'token': 'fixture-token',
        'expires': '${EXPIRES}',
        'asn': ''
    },
    url: '${BASE_URL}/playlist/fixture'
}
window.canPlayFHD = true
</script>`;

const manifest = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Italian",LANGUAGE="ita",URI="${BASE_URL}/playlist/fixture?type=audio&lang=ita"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="eng",URI="${BASE_URL}/playlist/fixture?type=audio&lang=eng"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English [CC]",LANGUAGE="eng",URI="${BASE_URL}/playlist/fixture?type=subtitle&lang=eng"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,AUDIO="audio",SUBTITLES="subs"
${BASE_URL}/playlist/fixture?quality=480
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="subs"
${BASE_URL}/playlist/fixture?quality=1080
`;

function proxyPayload(url: string): {
    url: string;
    headers: Record<string, string>;
} {
    const encoded = new URL(url).searchParams.get('data');
    assert.ok(encoded, 'proxy URL must contain data');
    return JSON.parse(encoded);
}

function fixtureProvider(media: ProviderMediaObject) {
    const requests: Array<{
        url: string;
        method: string;
        headers: Record<string, string>;
    }> = [];
    const apiUrl =
        media.type === 'movie'
            ? `${BASE_URL}/api/movie/${media.tmdbId}`
            : `${BASE_URL}/api/tv/${media.tmdbId}/${media.s}/${media.e}`;
    const embedUrl = `${BASE_URL}/embed/fixture?token=fixture-api-token`;
    const masterUrl = `${BASE_URL}/playlist/fixture?token=fixture-token&expires=${EXPIRES}&h=1`;
    const fetchFixture: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push({
            url,
            method: init?.method ?? 'GET',
            headers: init?.headers as Record<string, string>
        });

        if (url === apiUrl) {
            return Response.json({
                src: '/embed/fixture?token=fixture-api-token'
            });
        }
        if (url === embedUrl) {
            return new Response(embedHtml, {
                headers: { 'content-type': 'text/html' }
            });
        }
        if (url === masterUrl) {
            return new Response(manifest, {
                headers: {
                    'content-type': 'application/vnd.apple.mpegurl'
                }
            });
        }
        throw new Error(`Unexpected fixture request: ${url}`);
    };

    return {
        provider: new VixSrcProvider({
            baseUrl: BASE_URL,
            fetch: fetchFixture,
            now: () => NOW
        }),
        requests,
        apiUrl,
        embedUrl,
        masterUrl
    };
}

test('returns direct HLS and subtitles from the sanitized movie fixture', async () => {
    const { provider, requests, apiUrl, embedUrl, masterUrl } =
        fixtureProvider(movie);
    const result = await provider.getMovieSources(movie);

    assertProviderResultContract(result, {
        providerId: 'vixsrc',
        allowedTypes: ['hls']
    });
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].quality, '1080p');
    assert.deepEqual(result.sources[0].audioTracks, [
        { language: 'ita', label: 'Italian' },
        { language: 'eng', label: 'English' }
    ]);
    assert.equal(result.subtitles.length, 1);
    assert.equal(result.subtitles[0].label, 'English [CC]');
    assert.ok(result.sources.every(({ type }) => type !== 'embed'));

    assert.deepEqual(
        requests.map(({ url }) => url),
        [apiUrl, embedUrl, masterUrl]
    );
    assert.equal(requests[1].headers.Referer, apiUrl);
    assert.equal(requests[2].headers.Referer, embedUrl);

    const sourcePayload = proxyPayload(result.sources[0].url);
    assert.equal(sourcePayload.url, masterUrl);
    assert.equal(sourcePayload.headers.Referer, embedUrl);
    assert.equal(sourcePayload.headers.Origin, BASE_URL);
    const subtitlePayload = proxyPayload(result.subtitles[0].url);
    assert.equal(
        subtitlePayload.url,
        `${BASE_URL}/playlist/fixture?type=subtitle&lang=eng`
    );
});

test('constructs the documented TV identity route', async () => {
    const { provider, requests, apiUrl } = fixtureProvider(episode);
    const result = await provider.getTVSources(episode);

    assertProviderResultContract(result, {
        providerId: 'vixsrc',
        allowedTypes: ['hls']
    });
    assert.equal(requests[0].url, apiUrl);
    assert.equal(apiUrl, `${BASE_URL}/api/tv/1396/1/1`);
});

test('reports not-found and malformed API responses without throwing', async () => {
    for (const response of [
        new Response('', { status: 404 }),
        Response.json({}),
        Response.json({ src: 'https://untrusted.invalid/embed/fixture' })
    ]) {
        const provider = new VixSrcProvider({
            baseUrl: BASE_URL,
            fetch: async () => response.clone(),
            now: () => NOW
        });
        const result = await provider.getMovieSources(movie);
        assert.equal(result.sources.length, 0);
        assert.ok(
            result.diagnostics.some(({ code }) => code === 'PROVIDER_ERROR')
        );
    }
});

test('identifies an upstream access-policy block without leaking response data', async () => {
    const provider = new VixSrcProvider({
        baseUrl: BASE_URL,
        fetch: async () =>
            new Response('task-scoped-token-must-not-appear', { status: 403 }),
        now: () => NOW
    });
    const result = await provider.getMovieSources(movie);

    assert.equal(result.sources.length, 0);
    assert.match(
        result.diagnostics[0].message,
        /API request was blocked \(403\)/
    );
    assert.match(result.diagnostics[0].message, /VIXSRC_BASE_URL/);
    assert.doesNotMatch(
        JSON.stringify(result.diagnostics),
        /task-scoped-token-must-not-appear/
    );
});

test('reports expired or malformed playlist metadata without leaking tokens', async () => {
    const fetchFixture: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/api/movie/')) {
            return Response.json({ src: '/embed/fixture' });
        }
        return new Response(
            `window.masterPlaylist = { params: { 'token': 'do-not-log', 'expires': '1' }, url: '${BASE_URL}/playlist/fixture' }; window.canPlayFHD = true`
        );
    };
    const provider = new VixSrcProvider({
        baseUrl: BASE_URL,
        fetch: fetchFixture,
        now: () => NOW
    });
    const result = await provider.getMovieSources(movie);

    assert.equal(result.sources.length, 0);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(!JSON.stringify(result.diagnostics).includes('do-not-log'));
});

test('rejects a malformed HLS response with diagnostics', async () => {
    const overridden = new VixSrcProvider({
        baseUrl: BASE_URL,
        now: () => NOW,
        fetch: async (input, init) => {
            const url = String(input);
            if (url.includes('/api/movie/')) {
                return Response.json({ src: '/embed/fixture' });
            }
            if (url.includes('/embed/')) return new Response(embedHtml);
            assert.equal(
                init?.headers &&
                    (init.headers as Record<string, string>).Referer,
                `${BASE_URL}/embed/fixture`
            );
            return new Response('<html>not a playlist</html>');
        }
    });
    const result = await overridden.getMovieSources(movie);
    assert.equal(result.sources.length, 0);
    assert.match(result.diagnostics[0].message, /malformed/);
});
