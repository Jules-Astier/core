import assert from 'node:assert/strict';
import test from 'node:test';
import {
    evaluateHealthEligibility,
    parseHealthSwitchConfig,
    type HealthCatalogEntry
} from '../src/health/health-control.js';
import {
    FAILURE_CLASSES,
    classifyProviderHealthError,
    ProviderHealthFailure,
    ProviderHealthHttpFailure,
    ProviderHealthRunner,
    type HealthCheck,
    type HealthSubject
} from '../src/health/provider-health.js';
import { installProviderHealthControl } from '../src/provider-health.js';

const family = (id: string): HealthSubject => ({
    id,
    kind: 'family',
    familyId: id
});
const leaf = (id: string): HealthSubject => ({
    id,
    kind: 'leaf',
    familyId: id.split(':')[0],
    upstreamId: id
});
const host = (id: string, familyId = 'tulnex'): HealthSubject => ({
    id,
    kind: 'embed_host',
    familyId,
    embedHostId: id
});
const check = (
    subject: HealthSubject,
    run: HealthCheck['run'],
    level: HealthCheck['level'] = 'lightweight'
): HealthCheck => ({ subject, run, level });

const catalog: HealthCatalogEntry[] = [
    {
        id: 'tulnex',
        kind: 'aggregator',
        runtime: {
            runtimeId: 'tulnex',
            enabledDefault: true,
            healthCheck: true
        }
    },
    { id: 'tulnex:onion', kind: 'upstream', familyId: 'tulnex' },
    { id: 'tulnex:vidzee', kind: 'upstream', familyId: 'tulnex' },
    { id: 'streamwish', kind: 'embed_host' }
];

function runner(overrides = {}) {
    let id = 0;
    return new ProviderHealthRunner({
        release: { version: 'test', commit: 'fixture' },
        createCheckId: () => `check-${++id}`,
        ...overrides
    });
}

test('awaits completion, adapts legacy booleans, and orders results deterministically', async () => {
    let completed = false;
    const results = await runner().run([
        check(family('zeta'), async () => true),
        check(family('alpha'), async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            completed = true;
            return false;
        })
    ]);

    assert.equal(completed, true);
    assert.deepEqual(
        results.map((result) => result.subject.id),
        ['alpha', 'zeta']
    );
    assert.equal(results[0].outcome, 'fail');
    assert.equal(results[0].failureClass, 'internal');
    assert.equal(results[0].failureCode, 'HEALTH_FALSE');
    assert.equal(results[1].outcome, 'pass');
});

test('bounds concurrency without serializing all providers', async () => {
    let active = 0;
    let maximum = 0;
    const checks = Array.from({ length: 7 }, (_, index) =>
        check(family(`provider-${index}`), async () => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
            return true;
        })
    );

    await runner({ concurrency: 2 }).run(checks);
    assert.equal(maximum, 2);
});

test('times out one check, aborts its signal, and still completes siblings', async () => {
    let aborted = false;
    const results = await runner({
        concurrency: 2,
        timeoutsMs: { lightweight: 1_000 }
    }).run([
        check(family('slow'), (signal) => {
            signal.addEventListener('abort', () => {
                aborted = true;
            });
            return new Promise(() => {});
        }),
        check(family('sibling'), async () => true)
    ]);

    assert.equal(aborted, true);
    assert.equal(
        results.find((result) => result.subject.id === 'slow')?.failureClass,
        'timeout'
    );
    assert.equal(
        results.find((result) => result.subject.id === 'sibling')?.outcome,
        'pass'
    );
});

test('preserves leaf isolation and canonical family/leaf/host subjects', async () => {
    const results = await runner().run([
        check(leaf('tulnex:onion'), async () => true, 'resolver'),
        check(
            leaf('tulnex:vidzee'),
            async () => {
                throw new ProviderHealthFailure('no_sources', 'EMPTY_RESULT');
            },
            'resolver'
        ),
        check(
            host('streamwish'),
            async () => ({
                outcome: 'fail',
                failureClass: 'embed_frame',
                failureCode: 'FRAME_BLOCKED'
            }),
            'playback'
        )
    ]);

    assert.deepEqual(
        results.map(({ subject, outcome, failureClass }) => ({
            id: subject.id,
            kind: subject.kind,
            outcome,
            failureClass
        })),
        [
            {
                id: 'streamwish',
                kind: 'embed_host',
                outcome: 'fail',
                failureClass: 'embed_frame'
            },
            {
                id: 'tulnex:onion',
                kind: 'leaf',
                outcome: 'pass',
                failureClass: undefined
            },
            {
                id: 'tulnex:vidzee',
                kind: 'leaf',
                outcome: 'fail',
                failureClass: 'no_sources'
            }
        ]
    );
});

test('taxonomy is closed and raw errors and sensitive inputs are redacted', async () => {
    assert.equal(new Set(FAILURE_CLASSES).size, FAILURE_CLASSES.length);
    const secret =
        'https://media.invalid/title?token=secret Cookie: sid=private';
    const [result] = await runner().run([
        check(family('tulnex'), async () => {
            throw new Error(secret);
        })
    ]);
    const serialized = JSON.stringify(result);

    assert.equal(result.failureClass, 'internal');
    assert.equal(result.failureCode, 'UNCLASSIFIED');
    for (const forbidden of [
        'https://',
        'token',
        'secret',
        'Cookie',
        'title',
        'private'
    ]) {
        assert.equal(serialized.includes(forbidden), false);
    }
});

test('classifies typed HTTP failures without guessing a generic 403 cause', () => {
    assert.deepEqual(
        classifyProviderHealthError(new ProviderHealthHttpFailure(401)),
        {
            outcome: 'fail',
            failureClass: 'auth_required',
            failureCode: 'HTTP_401'
        }
    );
    assert.deepEqual(
        classifyProviderHealthError(new ProviderHealthHttpFailure(403)),
        {
            outcome: 'fail',
            failureClass: 'http_4xx',
            failureCode: 'HTTP_4XX'
        }
    );
    assert.deepEqual(
        classifyProviderHealthError(new ProviderHealthHttpFailure(404)),
        {
            outcome: 'fail',
            failureClass: 'not_found',
            failureCode: 'HTTP_404'
        }
    );
    assert.deepEqual(
        classifyProviderHealthError(new ProviderHealthHttpFailure(429)),
        {
            outcome: 'fail',
            failureClass: 'rate_limited',
            failureCode: 'HTTP_429'
        }
    );
    assert.deepEqual(
        classifyProviderHealthError(new ProviderHealthHttpFailure(503)),
        {
            outcome: 'fail',
            failureClass: 'http_5xx',
            failureCode: 'HTTP_5XX'
        }
    );
});

test('validates switches at startup and deny wins at family, leaf, and host levels', () => {
    const switches = parseHealthSwitchConfig(catalog, {
        CINEPRO_PROVIDER_FAMILY_ALLOWLIST: 'tulnex',
        CINEPRO_PROVIDER_FAMILY_DENYLIST: 'tulnex',
        CINEPRO_PROVIDER_LEAF_ALLOWLIST: 'tulnex:onion,tulnex:vidzee',
        CINEPRO_PROVIDER_LEAF_DENYLIST: 'tulnex:onion',
        CINEPRO_PROVIDER_HOST_ALLOWLIST: 'streamwish',
        CINEPRO_PROVIDER_HOST_DENYLIST: 'streamwish'
    });
    assert.deepEqual(
        evaluateHealthEligibility(family('tulnex'), catalog[0], switches),
        { enabled: false, disabledReason: 'family_deny' }
    );
    assert.deepEqual(
        evaluateHealthEligibility(leaf('tulnex:onion'), catalog[1], {
            ...switches,
            familyDeny: new Set()
        }),
        { enabled: false, disabledReason: 'leaf_deny' }
    );
    assert.deepEqual(
        evaluateHealthEligibility(host('streamwish'), catalog[3], {
            ...switches,
            familyDeny: new Set()
        }),
        { enabled: false, disabledReason: 'host_deny' }
    );
    assert.throws(
        () =>
            parseHealthSwitchConfig(catalog, {
                CINEPRO_PROVIDER_LEAF_ALLOWLIST: 'onion'
            }),
        /unknown or noncanonical identity/
    );
    assert.throws(
        () =>
            parseHealthSwitchConfig(catalog, {
                CINEPRO_PROVIDER_LEAF_DENYLIST: 'tulnex:onion,tulnex:onion'
            }),
        /duplicate identity/
    );
});

test('catalog and allowlist disablement cannot be overridden by narrower allows', () => {
    const switches = parseHealthSwitchConfig(catalog, {
        CINEPRO_PROVIDER_FAMILY_ALLOWLIST: 'tulnex',
        CINEPRO_PROVIDER_LEAF_ALLOWLIST: 'tulnex:onion'
    });
    assert.deepEqual(
        evaluateHealthEligibility(
            leaf('tulnex:onion'),
            { ...catalog[1], status: 'disabled' },
            switches
        ),
        { enabled: false, disabledReason: 'catalog' }
    );
    assert.deepEqual(
        evaluateHealthEligibility(leaf('tulnex:vidzee'), catalog[2], switches),
        { enabled: false, disabledReason: 'leaf_not_allowed' }
    );
});

test('disabled providers remain in health inventory with a stable reason', async () => {
    const registry = {
        getProviders: () => [
            {
                id: 'tulnex',
                name: 'Tulnex',
                enabled: true,
                healthCheck: async () => true
            }
        ],
        getEnabledProviders: () => [],
        healthCheckAll: async () => new Map<string, boolean>()
    };
    const control = await installProviderHealthControl(
        registry as never,
        catalog,
        { CINEPRO_PROVIDER_FAMILY_DENYLIST: 'tulnex' },
        { createCheckId: () => 'disabled-check' }
    );
    const result = control.results.find(
        ({ subject }) => subject.id === 'tulnex'
    );
    assert.equal(result?.outcome, 'skipped');
    assert.equal(result?.disabledReason, 'family_deny');
    assert.equal(result?.failureCode, 'DISABLED');
});

test('server integration awaits initial legacy health and serves only its completed snapshot', async () => {
    let resolveHealth!: (value: boolean) => void;
    let calls = 0;
    const provider = {
        id: 'tulnex',
        name: 'Tulnex',
        enabled: true,
        healthCheck: async () => {
            calls++;
            return await new Promise<boolean>((resolve) => {
                resolveHealth = resolve;
            });
        }
    };
    const registry = {
        getProviders: () => [provider],
        getEnabledProviders: () => [provider],
        healthCheckAll: async () => new Map<string, boolean>()
    };
    let installed = false;
    const installation = installProviderHealthControl(
        registry as never,
        catalog,
        {},
        { createCheckId: () => 'integration-check' }
    ).then((control) => {
        installed = true;
        return control;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(installed, false);
    assert.equal(calls, 1);
    resolveHealth(true);
    const control = await installation;
    assert.equal(
        control.results.find(({ subject }) => subject.id === 'tulnex')?.outcome,
        'pass'
    );

    const snapshot = await registry.healthCheckAll();
    assert.deepEqual([...snapshot], [['tulnex', true]]);
    assert.equal(calls, 1);
});

test('family deny filters live request selection without mutating registry inventory', async () => {
    const denied = {
        id: 'tulnex',
        name: 'Tulnex',
        enabled: true,
        healthCheck: async () => true
    };
    const allowed = {
        id: 'OtherRuntime',
        name: 'Other',
        enabled: true,
        healthCheck: async () => true
    };
    const entries: HealthCatalogEntry[] = [
        catalog[0],
        {
            id: 'other',
            kind: 'provider',
            familyId: 'other',
            runtime: {
                runtimeId: 'OtherRuntime',
                enabledDefault: true,
                healthCheck: true
            }
        }
    ];
    const providers = [denied, allowed];
    const registry = {
        getProviders: () => providers,
        getEnabledProviders: () =>
            providers.filter((provider) => provider.enabled),
        healthCheckAll: async () => new Map<string, boolean>()
    };

    await installProviderHealthControl(
        registry as never,
        entries,
        { CINEPRO_PROVIDER_FAMILY_DENYLIST: 'tulnex' },
        { createCheckId: () => 'selection-check' }
    );

    assert.deepEqual(
        registry.getEnabledProviders().map(({ id }) => id),
        ['OtherRuntime']
    );
    assert.deepEqual(
        registry.getProviders().map(({ id }) => id),
        ['tulnex', 'OtherRuntime']
    );
    assert.equal(denied.enabled, false);
});

test('installs canonical leaf and host eligibility subjects with deny wins', async () => {
    const provider = {
        id: 'tulnex',
        name: 'Tulnex',
        enabled: true,
        healthCheck: async () => true
    };
    const registry = {
        getProviders: () => [provider],
        getEnabledProviders: () => [provider],
        healthCheckAll: async () => new Map<string, boolean>()
    };
    const control = await installProviderHealthControl(
        registry as never,
        catalog,
        {
            CINEPRO_PROVIDER_LEAF_ALLOWLIST: 'tulnex:onion',
            CINEPRO_PROVIDER_LEAF_DENYLIST: 'tulnex:onion',
            CINEPRO_PROVIDER_HOST_DENYLIST: 'streamwish'
        },
        { createCheckId: () => 'subject-check' }
    );

    assert.equal(control.eligibility.isEnabled('tulnex:onion'), false);
    assert.equal(
        control.eligibility.get('tulnex:onion')?.disabledReason,
        'leaf_deny'
    );
    assert.equal(control.eligibility.isEnabled('streamwish'), false);
    assert.equal(
        control.eligibility.get('streamwish')?.disabledReason,
        'host_deny'
    );
    assert.deepEqual(
        control.results
            .filter((result) =>
                ['tulnex:onion', 'streamwish'].includes(result.subject.id)
            )
            .map((result) => [
                result.subject.id,
                result.subject.kind,
                result.outcome
            ]),
        [
            ['streamwish', 'embed_host', 'skipped'],
            ['tulnex:onion', 'leaf', 'skipped']
        ]
    );
});

test('non-cooperative timeouts quarantine slots and preserve the active bound', async () => {
    let active = 0;
    let maximum = 0;
    const results = await runner({
        concurrency: 1,
        timeoutsMs: { lightweight: 1_000 },
        cleanupGraceMs: 0
    }).run([
        check(family('a-hung'), async () => {
            active++;
            maximum = Math.max(maximum, active);
            return await new Promise<boolean>(() => {});
        }),
        check(family('b-never-started'), async () => {
            active++;
            maximum = Math.max(maximum, active);
            return true;
        })
    ]);

    assert.equal(maximum, 1);
    assert.equal(results[0].failureClass, 'timeout');
    assert.equal(results[1].outcome, 'skipped');
    assert.equal(results[1].failureCode, 'CONCURRENCY_QUARANTINED');
});

test('validation and release metadata never expose raw secret sentinels', async () => {
    const sentinel = 'https://secret.invalid/?token=PRIVATE_SENTINEL';
    assert.throws(
        () =>
            parseHealthSwitchConfig(catalog, {
                CINEPRO_PROVIDER_LEAF_DENYLIST: sentinel
            }),
        (error) => !String(error).includes(sentinel)
    );
    const [result] = await runner({
        release: { version: sentinel, commit: `commit-${sentinel}` }
    }).run([check(family('tulnex'), async () => true)]);
    assert.deepEqual(result.release, {
        version: 'unknown',
        commit: 'unknown'
    });
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
});

test('allocates deterministic IDs and timestamps before completion can reorder', async () => {
    const execute = async (alphaDelay: number, zetaDelay: number) => {
        let id = 0;
        let time = 0;
        return await runner({
            concurrency: 2,
            createCheckId: () => `ordered-${++id}`,
            now: () => Date.UTC(2026, 0, 1) + time++,
            release: { version: 'test', commit: 'fixture' }
        }).run([
            check(family('zeta'), async () => {
                await new Promise((resolve) => setTimeout(resolve, zetaDelay));
                return true;
            }),
            check(family('alpha'), async () => {
                await new Promise((resolve) => setTimeout(resolve, alphaDelay));
                return true;
            })
        ]);
    };

    const first = await execute(20, 1);
    const second = await execute(1, 20);
    assert.deepEqual(
        first.map(({ subject, checkId, checkedAt }) => ({
            id: subject.id,
            checkId,
            checkedAt
        })),
        second.map(({ subject, checkId, checkedAt }) => ({
            id: subject.id,
            checkId,
            checkedAt
        }))
    );
});

test('health snapshots retain mixed-case runtime provider IDs', async () => {
    const provider = {
        id: 'Peachify',
        name: 'Peachify',
        enabled: true,
        healthCheck: async () => true
    };
    const registry = {
        getProviders: () => [provider],
        getEnabledProviders: () => [provider],
        healthCheckAll: async () => new Map<string, boolean>()
    };
    await installProviderHealthControl(
        registry as never,
        [
            {
                id: 'peachify',
                kind: 'provider',
                familyId: 'peachify',
                runtime: {
                    runtimeId: 'Peachify',
                    enabledDefault: true,
                    healthCheck: true
                }
            }
        ],
        {},
        { createCheckId: () => 'mixed-case-check' }
    );
    assert.deepEqual(
        [...(await registry.healthCheckAll())],
        [['Peachify', true]]
    );
});
