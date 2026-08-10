import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProviderMediaObject,
    ProviderResult,
    SourceType
} from '@omss/framework';
import { decryptVidZeeStream } from './decrypt.js';
import { VidZeeProvider } from './vidzee.js';

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
    title: 'The Matrix',
    releaseYear: '1999'
} as ProviderMediaObject;

const episode = {
    type: 'tv',
    tmdbId: '1396',
    title: 'Breaking Bad',
    releaseYear: '2008',
    s: 1,
    e: 1
} as ProviderMediaObject;

function fixtureProvider(options: { fail?: ReadonlySet<string> } = {}) {
    const requests: URL[] = [];
    const decryptCalls: Array<{ encoded: string; hostname?: string }> = [];
    const fetchFixture: typeof fetch = async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        if (url.pathname.startsWith('/subs/')) {
            return Response.json([
                {
                    label: 'English',
                    file: 'https://subtitle.invalid/en.vtt'
                }
            ]);
        }
        const server = url.searchParams.get('s')!;
        if (options.fail?.has(server)) {
            return new Response('unavailable', { status: 502 });
        }
        return Response.json({ c: `fixture:${server}` });
    };
    return {
        provider: new VidZeeProvider({
            fetch: fetchFixture,
            decrypt: async (encoded, hostname) => {
                decryptCalls.push({ encoded, hostname });
                const server = encoded.slice('fixture:'.length);
                return {
                    url: `https://media.invalid/${server}/master.m3u8`,
                    language: 'Auto',
                    headers: { Referer: 'https://player.vidzee.wtf/' }
                };
            }
        }),
        requests,
        decryptCalls
    };
}

test('maps the current movie stream contract and subtitles', async () => {
    const fixture = fixtureProvider();
    const result = await fixture.provider.getMovieSources(movie);

    assertProviderResultContract(result, {
        providerId: 'vidzee',
        allowedTypes: ['hls'],
        minimumSources: 3
    });
    assert.deepEqual(
        fixture.requests
            .filter(({ pathname }) => pathname.startsWith('/streams/'))
            .map(({ pathname, searchParams }) => ({
                pathname,
                server: searchParams.get('s'),
                encrypted: searchParams.get('e')
            })),
        ['ipcloud', 'dcloud', 'tik'].map((server) => ({
            pathname: '/streams/movie/603',
            server,
            encrypted: '1'
        }))
    );
    assert.deepEqual(fixture.decryptCalls, [
        { encoded: 'fixture:ipcloud', hostname: 'player.vidzee.wtf' },
        { encoded: 'fixture:dcloud', hostname: 'player.vidzee.wtf' },
        { encoded: 'fixture:tik', hostname: 'player.vidzee.wtf' }
    ]);
    assert.equal(result.subtitles.length, 1);
});

test('constructs the current TV episode contract', async () => {
    const fixture = fixtureProvider({ fail: new Set(['dcloud', 'tik']) });
    const result = await fixture.provider.getTVSources(episode);

    assert.equal(result.sources.length, 1);
    assert.ok(
        fixture.requests.some(
            ({ pathname }) => pathname === '/streams/tv/1396/1/1'
        )
    );
    assert.ok(
        fixture.requests.some(
            ({ pathname }) => pathname === '/subs/tv/1396/1/1'
        )
    );
    assert.equal(result.diagnostics[0]?.code, 'PARTIAL_SCRAPE');
});

test('preserves safe decoded headers and rejects unapproved headers', async () => {
    const provider = new VidZeeProvider({
        fetch: async (input) => {
            const url = new URL(String(input));
            if (url.pathname.startsWith('/subs/')) return Response.json([]);
            return Response.json({ c: 'fixture' });
        },
        decrypt: async () => ({
            url: 'https://media.invalid/master.m3u8',
            headers: {
                Referer: 'https://player.vidzee.wtf/',
                Cookie: 'must-not-pass'
            }
        })
    });
    const result = await provider.getMovieSources(movie);
    const encoded = new URL(result.sources[0].url).searchParams.get('data');
    assert.ok(encoded);
    const payload = JSON.parse(encoded);
    assert.equal(payload.headers.Referer, 'https://player.vidzee.wtf/');
    assert.equal(payload.headers.Cookie, undefined);
});

test('malformed encrypted responses fail closed with diagnostics', async () => {
    const provider = new VidZeeProvider({
        fetch: async (input) => {
            const url = new URL(String(input));
            return url.pathname.startsWith('/subs/')
                ? Response.json([])
                : Response.json({ c: 'malformed' });
        },
        decrypt: async () => null
    });
    const result = await provider.getMovieSources(movie);

    assert.equal(result.sources.length, 0);
    assert.equal(result.diagnostics[0]?.code, 'PROVIDER_ERROR');
});

test('the pinned decoder rejects malformed public payloads', async () => {
    assert.equal(await decryptVidZeeStream('not-base64'), null);
    assert.equal(await decryptVidZeeStream('', 'player.vidzee.wtf'), null);
});
