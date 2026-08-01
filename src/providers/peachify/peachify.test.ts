import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderMediaObject } from '@omss/framework';
import type { IdentifiedSource } from '../../provider-identity.js';
import {
    PEACHIFY_ALLOW_ENV,
    PEACHIFY_DENY_ENV,
    PEACHIFY_LEAVES,
    resolvePeachifyLeaves
} from './peachify.config.js';
import { PeachifyProvider, redactPeachifyDiagnostic } from './peachify.js';

const movie = { type: 'movie', tmdbId: 'fixture-42' } as ProviderMediaObject;

function fixtureProvider(options: {
    failed?: ReadonlySet<string>;
    sameUrl?: boolean;
    environment?: Record<string, string>;
    encrypted?: ReadonlySet<string>;
}) {
    const failed = options.failed ?? new Set<string>();
    const encrypted = options.encrypted ?? new Set<string>();
    const decryptCalls: string[] = [];
    const requests: Array<{
        url: string;
        headers: RequestInit['headers'];
    }> = [];
    const fetchFixture: typeof fetch = async (input, init) => {
        const url = String(input);
        const leaf = PEACHIFY_LEAVES.find(({ baseUrl }) =>
            url.startsWith(baseUrl)
        );
        assert.ok(leaf, `unexpected fixture URL: ${url}`);
        requests.push({ url, headers: init?.headers });
        if (failed.has(leaf.name)) {
            throw new Error(
                'synthetic https://private.invalid/?token=do-not-log'
            );
        }
        if (encrypted.has(leaf.name)) {
            return Response.json({
                isEncrypted: true,
                data: `encrypted-${leaf.name}`
            });
        }
        return Response.json(responseFor(leaf.name, options.sameUrl));
    };

    return {
        provider: new PeachifyProvider({
            environment: options.environment ?? {},
            fetch: fetchFixture,
            userAgent: () => 'fixture-agent',
            decrypt: async (payload) => {
                decryptCalls.push(payload);
                const leaf = payload.slice('encrypted-'.length);
                return responseFor(leaf, options.sameUrl);
            }
        }),
        requests,
        decryptCalls
    };
}

function responseFor(leaf: string, sameUrl = false) {
    return {
        sources: [
            {
                url: sameUrl
                    ? 'https://media.invalid/shared/master.m3u8'
                    : `https://media.invalid/${leaf}/master.m3u8`,
                type: 'hls',
                dub: 'Original',
                quality: 1080,
                headers: { Referer: `https://${leaf}.fixture.invalid/` }
            }
        ],
        subtitles: [
            {
                url: `https://subtitles.invalid/${leaf}.vtt`,
                label: 'English'
            }
        ]
    };
}

test('maps exactly six leaves to canonical identities in legacy order', async () => {
    const result = await fixtureProvider({}).provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map((source) => ({
            id: source.provider.id,
            name: source.provider.name,
            family: source.providerFamilyId,
            upstream: source.upstreamId,
            type: source.type
        })),
        PEACHIFY_LEAVES.map(({ id }) => ({
            id,
            name: 'Peachify',
            family: 'peachify',
            upstream: id,
            type: 'hls'
        }))
    );
    assert.equal(result.subtitles.length, 6);
});

test('keeps identical URLs attributed to distinct leaves', async () => {
    const result = await fixtureProvider({
        sameUrl: true
    }).provider.getMovieSources(movie);
    const sources = result.sources as IdentifiedSource[];
    assert.equal(
        new Set(
            sources.map(({ url }) => {
                const data = new URL(url).searchParams.get('data');
                assert.ok(data);
                return JSON.parse(data).url;
            })
        ).size,
        1
    );
    assert.equal(new Set(sources.map(({ upstreamId }) => upstreamId)).size, 6);
});

test('a failed leaf preserves successful siblings, order, and partial diagnostics', async () => {
    const result = await fixtureProvider({
        failed: new Set(['air'])
    }).provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        PEACHIFY_LEAVES.filter(({ name }) => name !== 'air').map(({ id }) => id)
    );
    assert.equal(result.diagnostics[0]?.code, 'PARTIAL_SCRAPE');
    assert.match(result.diagnostics[0]?.message ?? '', /1 of 6/);
    assert.doesNotMatch(
        JSON.stringify(result.diagnostics),
        /private|do-not-log/
    );
});

test('allow and deny switches isolate leaves with legacy-safe defaults', async () => {
    assert.deepEqual(resolvePeachifyLeaves({}), PEACHIFY_LEAVES);
    const { provider, requests } = fixtureProvider({
        environment: {
            [PEACHIFY_ALLOW_ENV]: 'Peachify:MovieBox, AIR, bmb',
            [PEACHIFY_DENY_ENV]: 'air'
        }
    });
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(
        (result.sources as IdentifiedSource[]).map(
            ({ upstreamId }) => upstreamId
        ),
        ['peachify:moviebox', 'peachify:bmb']
    );
    assert.equal(requests.length, 2);
});

test('startup switch validation rejects unknown and duplicate input without disclosure', () => {
    const secret = 'unknown-super-secret-token';
    assert.throws(
        () => resolvePeachifyLeaves({ [PEACHIFY_DENY_ENV]: secret }),
        (error: Error) =>
            error.message.includes(PEACHIFY_DENY_ENV) &&
            !error.message.includes(secret)
    );
    assert.throws(
        () =>
            resolvePeachifyLeaves({
                [PEACHIFY_ALLOW_ENV]: 'air,peachify:air'
            }),
        /duplicate/
    );
});

test('preserves registry identity, request headers, source headers, and source type', async () => {
    const { provider, requests } = fixtureProvider({
        environment: { [PEACHIFY_ALLOW_ENV]: 'moviebox' }
    });
    assert.deepEqual(
        { id: provider.id, name: provider.name, enabled: provider.enabled },
        { id: 'Peachify', name: 'Peachify', enabled: true }
    );
    const result = await provider.getMovieSources(movie);
    assert.deepEqual(requests[0]?.headers, provider.HEADERS);
    assert.equal(provider.HEADERS['User-Agent'], 'fixture-agent');
    assert.equal(result.sources[0]?.type, 'hls');
    const proxyData = new URL(result.sources[0].url).searchParams.get('data');
    assert.ok(proxyData);
    const proxy = JSON.parse(proxyData);
    assert.equal(proxy.headers.Referer, 'https://moviebox.fixture.invalid/');
});

test('decrypts only encrypted responses through the injected seam', async () => {
    const fixture = fixtureProvider({
        environment: { [PEACHIFY_ALLOW_ENV]: 'moviebox,holly' },
        encrypted: new Set(['holly'])
    });
    const result = await fixture.provider.getMovieSources(movie);
    assert.equal(result.sources.length, 2);
    assert.deepEqual(fixture.decryptCalls, ['encrypted-holly']);
});

test('diagnostic redaction removes URLs and credential values', () => {
    const redacted = redactPeachifyDiagnostic(
        'failed https://private.invalid/path?token=secret&key=hidden'
    );
    assert.doesNotMatch(redacted, /private|secret|hidden/);
    assert.match(redacted, /\[redacted-url\]/);
});
