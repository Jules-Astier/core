import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
    RedirectDriftFailure,
    RedirectDriftGuard,
    type RedirectFetch,
    type RedirectFetchResponse
} from '../src/health/redirect-drift.js';
import { ProviderHealthFailure } from '../src/health/provider-health.js';

const ORIGIN = 'https://provider.example';
const ALIAS = 'https://migration.example';

function response(
    status: number,
    location?: string,
    body?: string
): RedirectFetchResponse {
    return {
        status,
        headers: {
            get: (name) =>
                name.toLowerCase() === 'location' ? (location ?? null) : null
        },
        body:
            body === undefined
                ? null
                : new ReadableStream({
                      start(controller) {
                          controller.enqueue(Buffer.from(body));
                          controller.close();
                      }
                  })
    };
}

function scripted(
    steps: readonly RedirectFetchResponse[],
    seen: string[] = []
): RedirectFetch {
    let index = 0;
    return async (url, init) => {
        assert.equal(init.redirect, 'manual');
        seen.push(url);
        const next = steps[index++];
        assert.ok(next, 'unexpected fetch');
        return next;
    };
}

function guard(fetch: RedirectFetch, overrides = {}) {
    return new RedirectDriftGuard(
        {
            canonicalOrigin: ORIGIN,
            reviewedRedirectOrigins: [ALIAS],
            maxHops: 2,
            ...overrides
        },
        fetch
    );
}

async function expectDrift(
    promise: Promise<unknown>,
    reason: RedirectDriftFailure['reason']
) {
    await assert.rejects(
        promise,
        (error) =>
            error instanceof RedirectDriftFailure &&
            error.failureClass === 'redirect_drift' &&
            error.failureCode === 'REDIRECT_DRIFT' &&
            error.reason === reason
    );
}

test('allows a legitimate same-origin redirect', async () => {
    const seen: string[] = [];
    const result = await guard(
        scripted([response(302, '/new-path'), response(200)], seen)
    ).check(`${ORIGIN}/old-path?private=sentinel`);
    assert.deepEqual(result, {
        hopCount: 1,
        finalOriginClass: 'canonical'
    });
    assert.equal(seen.length, 2);
});

test('allows only an explicitly reviewed migration origin', async () => {
    const result = await guard(
        scripted([response(308, `${ALIAS}/landing`), response(204)])
    ).check(`${ORIGIN}/`);
    assert.deepEqual(result, {
        hopCount: 1,
        finalOriginClass: 'reviewed'
    });
});

test('classifies parked or unrelated cross-origin redirects', async () => {
    await expectDrift(
        guard(
            scripted([response(302, 'https://unrelated.example/click')])
        ).check(`${ORIGIN}/`),
        'CROSS_ORIGIN'
    );
});

test('classifies HTTPS downgrade', async () => {
    await expectDrift(
        guard(scripted([response(301, 'http://provider.example/')])).check(
            `${ORIGIN}/`
        ),
        'DOWNGRADE'
    );
});

test('detects redirect loops', async () => {
    await expectDrift(
        guard(
            scripted([
                response(302, `${ORIGIN}/two`),
                response(302, `${ORIGIN}/one`)
            ])
        ).check(`${ORIGIN}/one`),
        'LOOP'
    );
});

test('rejects excess redirect hops', async () => {
    await expectDrift(
        guard(
            scripted([
                response(302, '/two'),
                response(302, '/three'),
                response(302, '/four')
            ])
        ).check(`${ORIGIN}/one`),
        'MAX_HOPS'
    );
});

test('rejects credentials and IP literals before fetching', async () => {
    const never: RedirectFetch = async () => {
        assert.fail('fetch must not run');
    };
    await expectDrift(
        guard(never).check('https://user:secret@provider.example/'),
        'CREDENTIALS'
    );
    await expectDrift(
        new RedirectDriftGuard(
            { canonicalOrigin: 'https://provider.example' },
            scripted([response(302, 'https://127.0.0.1/')])
        ).check(`${ORIGIN}/`),
        'IP_LITERAL'
    );
    assert.throws(
        () =>
            new RedirectDriftGuard({ canonicalOrigin: 'https://[::1]' }, never),
        /Invalid redirect guard configuration/
    );
});

test('compares a bounded optional content fingerprint', async () => {
    const expected = createHash('sha256').update('expected').digest('hex');
    await expectDrift(
        guard(scripted([response(200, undefined, 'unexpected')]), {
            expectedContentSha256: expected,
            maxFingerprintBytes: 32
        }).check(`${ORIGIN}/`),
        'FINGERPRINT_MISMATCH'
    );
});

test('configuration is copied, frozen, validated, and errors do not echo input', () => {
    const aliases = [ALIAS];
    const instance = new RedirectDriftGuard(
        { canonicalOrigin: ORIGIN, reviewedRedirectOrigins: aliases },
        scripted([response(200)])
    );
    aliases[0] = 'https://changed.example';
    assert.deepEqual(instance.config.reviewedRedirectOrigins, [ALIAS]);
    assert.ok(Object.isFrozen(instance.config));
    assert.ok(Object.isFrozen(instance.config.reviewedRedirectOrigins));

    const secret = 'CONFIG_SECRET_SENTINEL';
    assert.throws(
        () =>
            new RedirectDriftGuard(
                { canonicalOrigin: `https://user:${secret}@example.com` },
                scripted([])
            ),
        (error) =>
            error instanceof TypeError &&
            !JSON.stringify(error).includes(secret) &&
            !error.message.includes(secret)
    );
});

test('failures cannot serialize URL, query, title, header, or upstream error sentinels', async () => {
    const sentinels = [
        'URL_SECRET',
        'QUERY_SECRET',
        'TITLE_SECRET',
        'HEADER_SECRET',
        'ERROR_SECRET'
    ];
    let caught: unknown;
    try {
        await guard(
            scripted([
                response(
                    302,
                    `https://unrelated.example/URL_SECRET?token=QUERY_SECRET`
                )
            ])
        ).check(`${ORIGIN}/TITLE_SECRET?header=HEADER_SECRET#ERROR_SECRET`);
    } catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof RedirectDriftFailure);
    const serialized = JSON.stringify(caught);
    for (const sentinel of sentinels) {
        assert.equal(serialized.includes(sentinel), false);
        assert.equal(caught.message.includes(sentinel), false);
    }
});

test('maps raw injected transport failures to a closed sanitized health failure', async () => {
    const secret =
        'https://private.invalid/path?token=TRANSPORT_SECRET_SENTINEL';
    let caught: unknown;
    try {
        await guard(async () => {
            throw new Error(secret);
        }).check(`${ORIGIN}/`);
    } catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof ProviderHealthFailure);
    assert.equal(caught.failureClass, 'internal');
    assert.equal(caught.failureCode, 'REDIRECT_CHECK_FAILED');
    assert.equal(
        JSON.stringify(caught).includes('TRANSPORT_SECRET_SENTINEL'),
        false
    );
    assert.equal(caught.message.includes('TRANSPORT_SECRET_SENTINEL'), false);
});

test('maps throwing header and body accessors to closed sanitized failures', async () => {
    const headerSecret = 'HEADER_ACCESS_SECRET_SENTINEL';
    const bodySecret = 'BODY_ACCESS_SECRET_SENTINEL';
    const failures: unknown[] = [];
    let headerBodyCancelled = false;
    let accessorBodyCancelled = false;
    for (const fetch of [
        scripted([
            {
                status: 302,
                headers: {
                    get: () => {
                        throw new Error(headerSecret);
                    }
                },
                body: {
                    cancel: async () => {
                        headerBodyCancelled = true;
                    }
                } as unknown as ReadableStream<Uint8Array>
            }
        ]),
        scripted([
            {
                status: 200,
                headers: { get: () => null },
                body: {
                    getReader: () => {
                        throw new Error(bodySecret);
                    },
                    cancel: async () => {
                        accessorBodyCancelled = true;
                    }
                } as unknown as ReadableStream<Uint8Array>
            }
        ])
    ]) {
        try {
            await guard(fetch, {
                expectedContentSha256: createHash('sha256')
                    .update('fixture')
                    .digest('hex')
            }).check(`${ORIGIN}/`);
        } catch (error) {
            failures.push(error);
        }
    }
    assert.equal(failures.length, 2);
    for (const failure of failures) {
        assert.ok(failure instanceof ProviderHealthFailure);
        assert.equal(failure.failureCode, 'REDIRECT_CHECK_FAILED');
        const serialized = JSON.stringify(failure);
        assert.equal(serialized.includes(headerSecret), false);
        assert.equal(serialized.includes(bodySecret), false);
    }
    assert.equal(headerBodyCancelled, true);
    assert.equal(accessorBodyCancelled, true);
});

test('bounds a non-cooperative fetch and disposes its late response', async () => {
    let resolveFetch!: (response: RedirectFetchResponse) => void;
    let cancelled = false;
    const pending = new Promise<RedirectFetchResponse>((resolve) => {
        resolveFetch = resolve;
    });
    await assert.rejects(
        guard(() => pending, { timeoutMs: 5 }).check(`${ORIGIN}/`),
        (error) =>
            error instanceof DOMException && error.name === 'TimeoutError'
    );
    resolveFetch({
        status: 200,
        headers: { get: () => null },
        body: {
            cancel: async () => {
                cancelled = true;
            }
        } as unknown as ReadableStream<Uint8Array>
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(cancelled, true);
});

test('disposes a response when abort wins immediately after fetch', async () => {
    const controller = new AbortController();
    const reason = new Error('immediate caller abort');
    let cancelled = false;
    const fetch: RedirectFetch = async () => {
        controller.abort(reason);
        return {
            status: 200,
            headers: { get: () => null },
            body: {
                cancel: async () => {
                    cancelled = true;
                }
            } as unknown as ReadableStream<Uint8Array>
        };
    };
    await assert.rejects(
        guard(fetch).check(`${ORIGIN}/`, controller.signal),
        (error) => error === reason
    );
    await Promise.resolve();
    assert.equal(cancelled, true);
});

test('bounds non-cooperative fingerprint cancellation', async () => {
    const expected = createHash('sha256').update('x').digest('hex');
    const body = {
        getReader: () => ({
            read: async () => ({
                done: false as const,
                value: Uint8Array.of(120)
            }),
            cancel: () => new Promise<void>(() => undefined),
            releaseLock: () => undefined
        })
    } as unknown as ReadableStream<Uint8Array>;
    await assert.rejects(
        guard(scripted([{ status: 200, headers: { get: () => null }, body }]), {
            expectedContentSha256: expected,
            maxFingerprintBytes: 1,
            timeoutMs: 5
        }).check(`${ORIGIN}/`),
        (error) =>
            error instanceof DOMException && error.name === 'TimeoutError'
    );
});

test('cleans up a body after a rejected fingerprint read', async () => {
    let cancelled = false;
    const body = {
        getReader: () => ({
            read: async () => {
                throw new Error('READ_SECRET_SENTINEL');
            },
            cancel: async () => undefined,
            releaseLock: () => undefined
        }),
        cancel: async () => {
            cancelled = true;
        }
    } as unknown as ReadableStream<Uint8Array>;
    await assert.rejects(
        guard(scripted([{ status: 200, headers: { get: () => null }, body }]), {
            expectedContentSha256: createHash('sha256')
                .update('fixture')
                .digest('hex')
        }).check(`${ORIGIN}/`),
        (error) =>
            error instanceof ProviderHealthFailure &&
            error.failureCode === 'REDIRECT_CHECK_FAILED' &&
            !JSON.stringify(error).includes('READ_SECRET_SENTINEL')
    );
    assert.equal(cancelled, true);
});

test('non-cooperative failure cleanup does not mask the sanitized result', async () => {
    await assert.rejects(
        guard(
            scripted([
                {
                    status: 302,
                    headers: {
                        get: () => {
                            throw new Error('HEADER_SECRET_SENTINEL');
                        }
                    },
                    body: {
                        cancel: () => new Promise<void>(() => undefined)
                    } as unknown as ReadableStream<Uint8Array>
                }
            ]),
            { timeoutMs: 5 }
        ).check(`${ORIGIN}/`),
        (error) =>
            error instanceof ProviderHealthFailure &&
            error.failureCode === 'REDIRECT_CHECK_FAILED' &&
            !(error instanceof DOMException) &&
            !JSON.stringify(error).includes('HEADER_SECRET_SENTINEL')
    );
});

test('disposes terminal bodies and bounds non-cooperative cancellation by the deadline', async () => {
    let cancelled = false;
    const disposable = new ReadableStream<Uint8Array>({
        cancel() {
            cancelled = true;
        }
    });
    const result = await guard(
        scripted([
            {
                status: 200,
                headers: { get: () => null },
                body: disposable
            }
        ])
    ).check(`${ORIGIN}/`);
    assert.equal(result.hopCount, 0);
    assert.equal(cancelled, true);

    const nonCooperative = new ReadableStream<Uint8Array>({
        cancel: () => new Promise<void>(() => undefined)
    });
    await assert.rejects(
        guard(
            scripted([
                {
                    status: 200,
                    headers: { get: () => null },
                    body: nonCooperative
                }
            ]),
            { timeoutMs: 5 }
        ).check(`${ORIGIN}/`),
        (error) =>
            error instanceof DOMException && error.name === 'TimeoutError'
    );
});

test('propagates caller abort through the injected fetch', async () => {
    const controller = new AbortController();
    const reason = new Error('caller abort');
    const fetch: RedirectFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
            init.signal.addEventListener(
                'abort',
                () => reject(init.signal.reason),
                { once: true }
            );
        });
    const pending = guard(fetch).check(`${ORIGIN}/`, controller.signal);
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
});

test('propagates its bounded timeout signal', async () => {
    const fetch: RedirectFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
            init.signal.addEventListener(
                'abort',
                () => reject(init.signal.reason),
                { once: true }
            );
        });
    await assert.rejects(
        guard(fetch, { timeoutMs: 1 }).check(`${ORIGIN}/`),
        (error) =>
            error instanceof DOMException &&
            error.name === 'TimeoutError' &&
            !(error instanceof RedirectDriftFailure)
    );
});
