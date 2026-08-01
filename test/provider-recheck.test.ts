import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    createInternalRecheckServer,
    validateInternalRecheckHost,
    validateInternalRecheckToken
} from '../src/health/internal-recheck-server.js';
import type { HealthCatalogEntry } from '../src/health/health-control.js';
import type { HealthResult } from '../src/health/provider-health.js';
import { installProviderHealthControl } from '../src/provider-health.js';

const TOKEN = 'test-only-token-with-more-than-thirty-two-bytes';
const catalog: HealthCatalogEntry[] = [
    {
        id: 'alpha',
        kind: 'provider',
        runtime: {
            runtimeId: 'AlphaRuntime',
            enabledDefault: true,
            healthCheck: true
        }
    },
    { id: 'alpha:leaf', kind: 'upstream', familyId: 'alpha' },
    {
        id: 'beta',
        kind: 'provider',
        runtime: {
            runtimeId: 'BetaRuntime',
            enabledDefault: true,
            healthCheck: true
        }
    }
];

function provider(id = 'AlphaRuntime') {
    const calls: Array<{ method: string; media: Record<string, unknown> }> = [];
    return {
        id,
        name: id,
        enabled: true,
        capabilities: { supportedContentTypes: ['movies', 'tv'] },
        healthCheck: async () => true,
        getMovieSources: async (media: Record<string, unknown>) => {
            calls.push({ method: 'movie', media: structuredClone(media) });
            return { sources: [{}], subtitles: [], diagnostics: [] };
        },
        getTVSources: async (media: Record<string, unknown>) => {
            calls.push({ method: 'tv', media: structuredClone(media) });
            return { sources: [{}], subtitles: [], diagnostics: [] };
        },
        calls
    };
}

function registry(providers: ReturnType<typeof provider>[]) {
    return {
        getProviders: () => providers,
        getEnabledProviders: () => providers.filter(({ enabled }) => enabled),
        healthCheckAll: async () => new Map<string, boolean>()
    };
}

test('recheck uses exactly two fixed resolver identities and returns one sanitized result', async () => {
    const alpha = provider();
    const beta = provider('BetaRuntime');
    const control = await installProviderHealthControl(
        registry([alpha, beta]) as never,
        catalog,
        {},
        { createCheckId: () => 'fixed-check' }
    );

    const result = await control.recheck('alpha');
    assert.equal(result.subject.id, 'alpha');
    assert.equal(result.level, 'resolver');
    assert.equal(result.outcome, 'pass');
    assert.deepEqual(alpha.calls, [
        {
            method: 'movie',
            media: {
                type: 'movie',
                tmdbId: '550',
                imdbId: 'tt0137523',
                releaseYear: '1999',
                title: 'Fight Club'
            }
        },
        {
            method: 'tv',
            media: {
                type: 'tv',
                tmdbId: '1399',
                imdbId: 'tt0944947',
                releaseYear: '2011',
                title: 'Game of Thrones',
                s: 1,
                e: 1
            }
        }
    ]);
    assert.equal(beta.calls.length, 0);
    assert.deepEqual(Object.keys(result).sort(), [
        'checkId',
        'checkedAt',
        'durationMs',
        'level',
        'outcome',
        'release',
        'schemaVersion',
        'subject'
    ]);
});

test('recheck fails closed for leaf, unknown, disabled, and unsupported families', async () => {
    const disabled = provider();
    const unsupported = provider('BetaRuntime');
    unsupported.capabilities.supportedContentTypes = ['movies'];
    const control = await installProviderHealthControl(
        registry([disabled, unsupported]) as never,
        catalog,
        { CINEPRO_PROVIDER_FAMILY_DENYLIST: 'alpha' }
    );
    await assert.rejects(control.recheck('alpha'), /PROVIDER_DISABLED/);
    await assert.rejects(control.recheck('alpha:leaf'), /UNSUPPORTED_SUBJECT/);
    await assert.rejects(control.recheck('missing'), /UNKNOWN_PROVIDER/);
    await assert.rejects(control.recheck('beta'), /PROVIDER_UNSUPPORTED/);
});

test('resolver rejection is redacted and both canaries combine into one failure', async () => {
    const alpha = provider();
    alpha.getMovieSources = async () => {
        throw new Error('https://secret.invalid/?token=do-not-leak');
    };
    const control = await installProviderHealthControl(
        registry([alpha]) as never,
        catalog.slice(0, 2),
        {},
        { createCheckId: () => 'redacted-check' }
    );
    const result = await control.recheck('alpha');
    assert.equal(result.outcome, 'fail');
    assert.equal(result.failureCode, 'RESOLVER_FAILED');
    assert.doesNotMatch(JSON.stringify(result), /secret|token|https/i);
});

test('resolver deadline retains family and global leases until late work settles', async () => {
    const alpha = provider();
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
        release = resolve;
    });
    alpha.getMovieSources = async () => {
        await late;
        return { sources: [{}], subtitles: [], diagnostics: [] };
    };
    const beta = provider('BetaRuntime');
    const control = await installProviderHealthControl(
        registry([alpha, beta]) as never,
        catalog,
        {
            CINEPRO_HEALTH_CONCURRENCY: '1',
            CINEPRO_HEALTH_RESOLVER_TIMEOUT_MS: '1000'
        },
        { cleanupGraceMs: 0, createCheckId: () => 'timeout-check' }
    );
    const result = await control.recheck('alpha');
    assert.equal(result.failureClass, 'timeout');
    assert.equal(result.failureCode, 'DEADLINE');
    assert.equal(await control.recheck('alpha'), result);
    await assert.rejects(control.recheck('beta'), /RECHECK_BUSY/);
    assert.equal(alpha.calls.filter(({ method }) => method === 'tv').length, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await control.recheck('beta')).outcome, 'pass');
});

test('refresh finishing after recheck preserves resolver latest in memory', async () => {
    const alpha = provider();
    const healthDirectory = await mkdtemp(
        join(tmpdir(), 'cinepro-recheck-race-')
    );
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        refreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
    });
    let healthCalls = 0;
    alpha.healthCheck = async () => {
        if (healthCalls++ > 0) {
            refreshStarted();
            await refreshGate;
        }
        return true;
    };
    const control = await installProviderHealthControl(
        registry([alpha]) as never,
        catalog.slice(0, 2),
        { CINEPRO_PROVIDER_HEALTH_DIR: healthDirectory },
        { createCheckId: () => `race-${healthCalls}` }
    );
    const refresh = control.refresh();
    await started;
    const resolver = await control.recheck('alpha');
    releaseRefresh();
    await refresh;
    assert.equal(
        control.results.find(
            ({ subject, level }) =>
                subject.id === 'alpha' && level === 'resolver'
        )?.checkId,
        resolver.checkId
    );
    const persisted = JSON.parse(
        await readFile(join(healthDirectory, 'snapshot.v1.json'), 'utf8')
    ) as { latest: HealthResult[] };
    assert.equal(
        persisted.latest.find(
            ({ subject, level }) =>
                subject.id === 'alpha' && level === 'resolver'
        )?.checkId,
        resolver.checkId
    );
});

test('internal endpoint enforces auth, method, media type, empty body, and arbitrary-field rejection', async (context) => {
    const fixture = result();
    let running;
    try {
        running = await endpoint({
            recheck: async () => fixture
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
            context.skip('sandbox prohibits loopback listeners');
            return;
        }
        throw error;
    }
    const { origin, close } = running;
    try {
        assert.equal(
            (
                await fetch(
                    `${origin}/internal/provider-health/recheck/alpha`,
                    {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: '{}'
                    }
                )
            ).status,
            401
        );
        assert.equal((await request(origin, 'alpha', '{}', 'GET')).status, 405);
        assert.equal(
            (await request(origin, 'alpha', '{}', 'POST', 'text/plain')).status,
            415
        );
        assert.equal(
            (await request(origin, 'alpha', '{"url":"https://evil.invalid"}'))
                .status,
            400
        );
        assert.equal(
            (await request(origin, 'alpha', 'x'.repeat(1025))).status,
            413
        );
        const response = await request(origin, 'alpha', '{}');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    } finally {
        await close();
    }
});

test('internal endpoint single-flights one id and bounds unrelated ids globally', async (context) => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let running;
    try {
        running = await endpoint(
            {
                recheck: async (id) => {
                    calls++;
                    await gate;
                    return result(id);
                }
            },
            1
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
            context.skip('sandbox prohibits loopback listeners');
            return;
        }
        throw error;
    }
    const { origin, close } = running;
    try {
        const first = request(origin, 'alpha', '{}');
        const duplicate = request(origin, 'alpha', '{}');
        await new Promise((resolve) => setImmediate(resolve));
        const busy = await request(origin, 'beta', '{}');
        assert.equal(busy.status, 429);
        assert.equal(calls, 1);
        release();
        assert.deepEqual(
            await Promise.all([first, duplicate]).then((values) =>
                values.map(({ status }) => status)
            ),
            [200, 200]
        );
    } finally {
        release();
        await close();
    }
});

test('internal endpoint retains capacity after a bounded resolver timeout until canary settlement', async (context) => {
    const alpha = provider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    alpha.getMovieSources = async (media) => {
        alpha.calls.push({ method: 'movie', media: structuredClone(media) });
        await gate;
        return { sources: [{}], subtitles: [], diagnostics: [] };
    };
    const beta = provider('BetaRuntime');
    const control = await installProviderHealthControl(
        registry([alpha, beta]) as never,
        catalog,
        {
            CINEPRO_HEALTH_CONCURRENCY: '1',
            CINEPRO_HEALTH_RESOLVER_TIMEOUT_MS: '1000'
        },
        { cleanupGraceMs: 0, createCheckId: () => 'listener-timeout' }
    );
    let running;
    try {
        running = await endpoint(control, 1);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
            context.skip('sandbox prohibits loopback listeners');
            return;
        }
        throw error;
    }
    const { origin, close } = running;
    try {
        const timedOut = await request(origin, 'alpha', '{}');
        assert.equal(timedOut.status, 200);
        assert.equal(
            ((await timedOut.json()) as { result: HealthResult }).result
                .failureClass,
            'timeout'
        );
        assert.equal((await request(origin, 'alpha', '{}')).status, 200);
        assert.equal((await request(origin, 'beta', '{}')).status, 429);
        assert.equal(
            alpha.calls.filter(({ method }) => method === 'movie').length,
            1
        );
        release();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal((await request(origin, 'beta', '{}')).status, 200);
    } finally {
        release();
        await close();
    }
});

test('weak internal tokens fail startup validation', () => {
    assert.throws(() => validateInternalRecheckToken('too-short'), /strong/);
});

test('internal listener host accepts only explicit safe literals', () => {
    for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) {
        assert.equal(validateInternalRecheckHost(host), host);
    }
    for (const host of ['localhost', 'cinepro-core', '8.8.8.8', '10.0.0.4']) {
        assert.throws(() => validateInternalRecheckHost(host), /explicit/);
    }
});

async function request(
    origin: string,
    id: string,
    body: string,
    method = 'POST',
    contentType = 'application/json'
) {
    return await fetch(`${origin}/internal/provider-health/recheck/${id}`, {
        method,
        headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': contentType
        },
        ...(method === 'POST' ? { body } : {})
    });
}

async function endpoint(
    control: { recheck(id: string): Promise<HealthResult> },
    globalConcurrency = 4
) {
    const server = createInternalRecheckServer({
        token: TOKEN,
        control,
        globalConcurrency
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: async () =>
            await new Promise<void>((resolve) => server.close(() => resolve()))
    };
}

function result(id = 'alpha'): HealthResult {
    return {
        schemaVersion: 1,
        checkId: `check-${id}`,
        subject: { id, kind: 'family', familyId: id },
        level: 'resolver',
        outcome: 'pass',
        durationMs: 1,
        checkedAt: new Date(0).toISOString(),
        release: { version: 'test', commit: 'fixture' }
    };
}
