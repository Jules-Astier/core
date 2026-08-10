import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import type { ApiResponse } from './streammafia.types.js';
import { StreamMafiaProvider } from './streammafia.js';

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

const movie = {
    type: 'movie',
    tmdbId: '603',
    title: 'The Matrix'
} as ProviderMediaObject;

const episode = {
    type: 'tv',
    tmdbId: '1396',
    title: 'Breaking Bad',
    s: 1,
    e: 1
} as ProviderMediaObject;

function apiFixture(): ApiResponse {
    return {
        status: 'ok',
        requested: { id: 603 },
        selected: {
            file_code: 'fixture',
            lang_code: 'en',
            lang: 'English',
            title: 'Fixture',
            source_title: 'Fixture'
        },
        switches: [],
        stream: {
            status: 'ok',
            title: 'Fixture',
            hls_streaming: 'https://media.invalid/master.m3u8',
            duration: '1:00',
            thumbnail_small: '',
            thumbnail_medium: '',
            thumbnail_hd: '',
            download: [
                {
                    quality: '1080p',
                    url: 'https://media.invalid/download.mp4'
                }
            ],
            preview_video: []
        },
        source: { goal_api: '' }
    };
}

function fixtureProvider(mediaApi = apiFixture()) {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const provider = new StreamMafiaProvider({
        ipv4: async () => '203.0.113.42',
        decrypt: () => mediaApi,
        fetch: async (input, init) => {
            const url = new URL(String(input));
            requests.push({ url, init });
            if (url.pathname === '/api/token') {
                return Response.json({
                    token: 'synthetic-token',
                    secureId: 'synthetic-secure-id'
                });
            }
            if (url.hostname === 'media.invalid') {
                return new Response(
                    '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nvideo.m3u8\n'
                );
            }
            return Response.json({ iv: 'a', tag: 'b', data: 'c' });
        }
    });
    return { provider, requests };
}

test('uses the current token and movie request sequence', async () => {
    const fixture = fixtureProvider();
    const result = await fixture.provider.getMovieSources(movie);

    assertProviderResultContract(result, {
        providerId: 'streammafia',
        allowedTypes: ['hls', 'mp4'],
        minimumSources: 2
    });
    const tokenRequest = fixture.requests.find(
        ({ url }) => url.pathname === '/api/token'
    )!;
    assert.equal(tokenRequest.init?.method, 'POST');
    assert.equal(
        (tokenRequest.init?.headers as Record<string, string>)['X-Content-Id'],
        '603'
    );
    assert.deepEqual(JSON.parse(String(tokenRequest.init?.body)), {
        ipv4: '203.0.113.42'
    });

    const streamRequest = fixture.requests.find(
        ({ url }) => url.pathname === '/api/movie'
    )!;
    assert.equal(
        streamRequest.url.searchParams.get('id'),
        'synthetic-secure-id'
    );
    assert.equal(
        (streamRequest.init?.headers as Record<string, string>)['X-API-Token'],
        'synthetic-token'
    );
    assert.equal(
        (streamRequest.init?.headers as Record<string, string>)[
            'X-Client-IPv4'
        ],
        '203.0.113.42'
    );
});

test('constructs the current TV request route', async () => {
    const fixture = fixtureProvider();
    await fixture.provider.getTVSources(episode);
    const request = fixture.requests.find(
        ({ url }) => url.pathname === '/api/tv'
    )!;
    assert.equal(request.url.searchParams.get('id'), 'synthetic-secure-id');
    assert.equal(request.url.searchParams.get('season'), '1');
    assert.equal(request.url.searchParams.get('episode'), '1');
});

test('maps each download URL instead of duplicating the HLS URL', async () => {
    const result = await fixtureProvider().provider.getMovieSources(movie);
    const upstreams = result.sources.map(({ url }) => {
        const encoded = new URL(url).searchParams.get('data');
        assert.ok(encoded);
        return JSON.parse(encoded).url;
    });
    assert.deepEqual(upstreams, [
        'https://media.invalid/master.m3u8',
        'https://media.invalid/download.mp4'
    ]);
});

test('invalid token responses fail closed and production remains opt-in', async () => {
    const provider = new StreamMafiaProvider({
        ipv4: async () => '203.0.113.42',
        fetch: async () => Response.json({ token: 'missing-secure-id' })
    });
    const result = await provider.getMovieSources(movie);
    assert.equal(provider.enabled, false);
    assert.equal(result.sources.length, 0);
    assert.equal(result.diagnostics[0]?.code, 'PROVIDER_ERROR');
});
