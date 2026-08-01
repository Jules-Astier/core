import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DebridPrototypeClient,
    DEFAULT_DEBRID_PROTOTYPE_CONFIG,
    createDebridPrototypeConfig,
    redactDebridDiagnostic,
    type DebridTorrentCandidate,
    type DebridTransport
} from '../src/torrent/debrid/index.js';

const candidate: DebridTorrentCandidate = {
    kind: 'torrent',
    infoHash: '0123456789abcdef0123456789abcdef01234567',
    fileIdx: 0,
    name: 'Sintel (2010) — synthetic public-domain fixture',
    filename: 'sintel-2010.mp4',
    size: 129_000_000,
    seeders: 7,
    provider: { id: 'fixture:public-domain', name: 'Synthetic fixture' }
};

function client(
    transport: DebridTransport,
    overrides: Parameters<typeof createDebridPrototypeConfig>[0] = {},
    extra: Record<string, unknown> = {}
) {
    return new DebridPrototypeClient(
        createDebridPrototypeConfig({
            enabled: true,
            timeoutMs: 20,
            maxRetries: 0,
            ...overrides
        }),
        { transport, readSecret: () => 'SERVER_SENTINEL_TOKEN', ...extra }
    );
}

test('prototype is explicitly disabled by default without touching transport or secrets', async () => {
    let touched = false;
    const result = await new DebridPrototypeClient(
        DEFAULT_DEBRID_PROTOTYPE_CONFIG,
        {
            transport: {
                resolve: async () => {
                    touched = true;
                    throw new Error('unexpected');
                }
            },
            readSecret: () => {
                touched = true;
                return 'unexpected';
            }
        }
    ).resolve([candidate]);
    assert.deepEqual(result, { state: 'disabled', links: [] });
    assert.equal(touched, false);
});

test('enabled prototype fails closed when its server secret is missing', async () => {
    let touched = false;
    const result = await new DebridPrototypeClient(
        createDebridPrototypeConfig({ enabled: true }),
        {
            transport: {
                resolve: async () => {
                    touched = true;
                    throw new Error('unexpected');
                }
            },
            readSecret: () => undefined
        }
    ).resolve([candidate]);
    assert.deepEqual(result, { state: 'missing-secret', links: [] });
    assert.equal(touched, false);
});

test('credential reaches only transport authorization and is never exported', async () => {
    let authorization = '';
    const result = await client({
        resolve: async (request) => {
            authorization = request.authorization;
            return {
                state: 'cached',
                links: [{ url: 'https://media.example.test/sintel.mp4' }]
            };
        }
    }).resolve([candidate]);
    assert.equal(authorization, 'Bearer SERVER_SENTINEL_TOKEN');
    assert.doesNotMatch(
        JSON.stringify(result),
        /SERVER_SENTINEL_TOKEN|authorization|Bearer/
    );
});

test('timeout aborts the request and retries remain bounded', async () => {
    let calls = 0;
    let aborted = false;
    const result = await client(
        {
            resolve: ({ signal }) =>
                new Promise((_resolve) => {
                    calls++;
                    signal.addEventListener('abort', () => {
                        aborted = true;
                    });
                })
        },
        { timeoutMs: 5, maxRetries: 1 }
    ).resolve([candidate]);
    assert.deepEqual(result, {
        state: 'unavailable',
        links: [],
        reason: 'timeout'
    });
    assert.equal(calls, 2);
    assert.equal(aborted, true);
});

test('cache misses are explicit and try candidates in deterministic order', async () => {
    const seen: string[] = [];
    const second = {
        ...candidate,
        infoHash: 'abcdef0123456789abcdef0123456789abcdef01'
    };
    const result = await client({
        resolve: async ({ candidate: input }) => {
            seen.push(input.infoHash);
            return { state: 'cache-miss' };
        }
    }).resolve([candidate, second]);
    assert.equal(result.state, 'cache-miss');
    assert.deepEqual(seen, [candidate.infoHash, second.infoHash]);
});

test('invalid and HTTP links are rejected while the first valid candidate wins', async () => {
    const calls: string[] = [];
    const second = {
        ...candidate,
        infoHash: 'abcdef0123456789abcdef0123456789abcdef01'
    };
    const result = await client({
        resolve: async ({ candidate: input }) => {
            calls.push(input.infoHash);
            return input === candidate
                ? {
                      state: 'cached',
                      links: [
                          { url: 'not a url' },
                          { url: 'http://media.example.test/a.mp4' }
                      ]
                  }
                : {
                      state: 'cached',
                      links: [{ url: 'https://media.example.test/b.mp4' }]
                  };
        }
    }).resolve([candidate, second]);
    assert.equal(result.state, 'ready');
    assert.deepEqual(calls, [candidate.infoHash, second.infoHash]);
});

test('range support maps explicitly to seek capability', async () => {
    const result = await client({
        resolve: async () => ({
            state: 'cached',
            links: [
                {
                    url: 'https://media.example.test/sintel.mp4',
                    rangeSupported: true,
                    contentLength: 42
                }
            ]
        })
    }).resolve([candidate]);
    assert.deepEqual(result, {
        state: 'ready',
        links: [
            {
                url: 'https://media.example.test/sintel.mp4',
                capabilities: {
                    rangeRequests: true,
                    seekable: true,
                    contentLength: 42
                }
            }
        ]
    });
});

test('results and candidate work are bounded and duplicate links are first-wins', async () => {
    let calls = 0;
    const result = await client(
        {
            resolve: async () => {
                calls++;
                return {
                    state: 'cached',
                    links: [
                        {
                            url: 'https://media.example.test/first.mp4',
                            rangeSupported: true
                        },
                        {
                            url: 'https://media.example.test/first.mp4',
                            rangeSupported: false
                        },
                        { url: 'https://media.example.test/second.mp4' },
                        { url: 'https://media.example.test/third.mp4' }
                    ]
                };
            }
        },
        { maxCandidates: 1, maxResults: 2 }
    ).resolve([candidate, { ...candidate }]);
    assert.equal(calls, 1);
    assert.equal(result.state, 'ready');
    if (result.state === 'ready') {
        assert.deepEqual(
            result.links.map((link) => link.url),
            [
                'https://media.example.test/first.mp4',
                'https://media.example.test/second.mp4'
            ]
        );
        assert.equal(result.links[0].capabilities.rangeRequests, true);
    }
});

test('circuit opens after bounded failures and resets after cooldown', async () => {
    let now = 100;
    let calls = 0;
    const instance = client(
        {
            resolve: async () => {
                calls++;
                throw new Error('offline');
            }
        },
        { circuitFailureThreshold: 2, circuitResetMs: 50 },
        { now: () => now }
    );
    await instance.resolve([candidate]);
    await instance.resolve([candidate]);
    assert.equal((await instance.resolve([candidate])).state, 'circuit-open');
    assert.equal(calls, 2);
    now = 151;
    await instance.resolve([candidate]);
    assert.equal(calls, 3);
});

test('sentinel secrets, URLs, tokens and errors are aggressively redacted', () => {
    const redacted = redactDebridDiagnostic(
        new Error(
            'failed https://media.example/x?token=LEAK Bearer SERVER_SENTINEL_TOKEN api_key=LEAK'
        ),
        ['SERVER_SENTINEL_TOKEN', 'LEAK']
    );
    assert.equal(redacted.includes('SERVER_SENTINEL_TOKEN'), false);
    assert.equal(redacted.includes('LEAK'), false);
    assert.equal(redacted.includes('https://'), false);
    assert.match(redacted, /REDACTED/);
});
