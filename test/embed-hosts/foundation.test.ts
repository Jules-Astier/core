import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createHeadlessVidXClient,
    createHostClassifier,
    dedupeEmbedTargets,
    EmbedHostRegistry,
    sanitizeAdapterError,
    stableFingerprint,
    validateEmbedHostCatalog,
    validatePlaybackHeaders,
    type CanonicalFamilyId,
    type CanonicalHostId,
    type CanonicalUpstreamId,
    type EmbedHostAdapter,
    type EmbedHostCatalog,
    type EmbedFailure,
    type EmbedInput,
    type EmbedTarget,
    type ResolverIdentity
} from '../../src/embed-hosts/index.js';
import type { ProviderComponentEligibility } from '../../src/health/health-control.js';

const hostId = 'fixture-host' as CanonicalHostId;
const catalog: EmbedHostCatalog = {
    schemaVersion: 1,
    ruleVersion: 7,
    hosts: [
        {
            id: hostId,
            domains: [
                {
                    hostname: 'embed.fixture.test',
                    kind: 'canonical',
                    allowSubdomains: ['player']
                },
                {
                    hostname: 'alias.fixture.test',
                    kind: 'alias',
                    allowSubdomains: false
                }
            ],
            paths: [
                { role: 'embed', pathname: /^\/e\/[a-z0-9-]+$/ },
                {
                    role: 'embed',
                    pathname: /^\/player$/,
                    requiredQueryKeys: ['id']
                },
                { role: 'redirect', pathname: /^\/go$/ }
            ],
            redirectHostnames: [],
            blockedHostnames: [
                { hostname: 'cdn.fixture.test', role: 'cdn' },
                { hostname: 'ads.fixture.test', role: 'ad' },
                { hostname: 'track.fixture.test', role: 'tracker' }
            ]
        }
    ]
};
const familyIdentity: ResolverIdentity = {
    providerFamilyId: 'fixture' as CanonicalFamilyId,
    providerId: 'fixture' as CanonicalFamilyId
};
const leafIdentity: ResolverIdentity = {
    providerFamilyId: 'fixture' as CanonicalFamilyId,
    providerId: 'fixture:one' as CanonicalUpstreamId,
    upstreamId: 'fixture:one' as CanonicalUpstreamId
};
const signal = new AbortController().signal;

test('versioned aliases and explicit URL roles classify exactly', () => {
    const classify = createHostClassifier(catalog);
    for (const hostname of [
        'embed.fixture.test',
        'alias.fixture.test',
        'player.embed.fixture.test'
    ]) {
        const result = classify(`https://${hostname}/e/fixture-1`);
        assert.equal(result.matched, true);
        if (result.matched) {
            assert.equal(result.hostId, hostId);
            assert.equal(result.ruleVersion, 7);
            assert.equal(result.role, 'embed');
        }
    }
    const redirect = classify('https://embed.fixture.test/go');
    assert.equal(redirect.matched && redirect.role, 'redirect');
    const redirectCatalog: EmbedHostCatalog = {
        ...catalog,
        hosts: [
            {
                ...catalog.hosts[0],
                redirectHostnames: ['redirect.fixture.test']
            }
        ]
    };
    const redirectAuthority = createHostClassifier(redirectCatalog)(
        'https://redirect.fixture.test/opaque'
    );
    assert.equal(
        redirectAuthority.matched && redirectAuthority.role,
        'redirect'
    );
    assert.equal(
        classify('https://embed.fixture.test/player?id=secret').matched,
        true
    );
});

test('classifier rejects credentials, IPs, HTTP, unknown, blocked and non-embed paths', () => {
    const classify = createHostClassifier(catalog);
    const cases = [
        ['https://user:pass@embed.fixture.test/e/x', 'CREDENTIALS_PRESENT'],
        ['https://127.0.0.1/e/x', 'IP_LITERAL'],
        ['http://embed.fixture.test/e/x', 'UNSUPPORTED_SCHEME'],
        ['https://embed.fixture.test.evil/e/x', 'UNREGISTERED_DOMAIN'],
        ['https://embed.fixture.test/watch/x.m3u8', 'NON_EMBED_PATH'],
        ['https://ads.fixture.test/e/x', 'BLOCKED_DOMAIN_CLASS'],
        ['https://track.fixture.test/e/x', 'BLOCKED_DOMAIN_CLASS'],
        ['https://cdn.fixture.test/movie.mp4', 'BLOCKED_DOMAIN_CLASS']
    ] as const;
    for (const [url, reason] of cases) {
        const result = classify(url);
        assert.equal(result.matched, false);
        if (!result.matched) assert.equal(result.reason, reason);
    }
});

test('catalog rejects ambiguous aliases and unanchored rules', () => {
    assert.throws(() =>
        validateEmbedHostCatalog({
            ...catalog,
            hosts: [
                ...catalog.hosts,
                { ...catalog.hosts[0], id: 'other' as CanonicalHostId }
            ]
        })
    );
    assert.throws(() =>
        validateEmbedHostCatalog({
            ...catalog,
            hosts: [
                {
                    ...catalog.hosts[0],
                    paths: [{ role: 'embed', pathname: /embed/ }]
                }
            ]
        })
    );
    for (const changed of [
        { ...catalog.hosts[0], redirectHostnames: ['LOCALHOST'] },
        {
            ...catalog.hosts[0],
            paths: [{ role: 'embed' as const, pathname: /^\/e$/g }]
        },
        {
            ...catalog.hosts[0],
            paths: [
                {
                    role: 'embed' as const,
                    pathname: /^\/e$/,
                    requiredQueryKeys: ['bad key']
                }
            ]
        },
        {
            ...catalog.hosts[0],
            domains: catalog.hosts[0].domains.map((domain) => ({
                ...domain,
                kind: 'alias' as const
            }))
        }
    ]) {
        assert.throws(() =>
            validateEmbedHostCatalog({ ...catalog, hosts: [changed] })
        );
    }
    const mutable = /^\/safe$/;
    const snapshot = validateEmbedHostCatalog({
        ...catalog,
        hosts: [
            {
                ...catalog.hosts[0],
                paths: [{ role: 'embed', pathname: mutable }]
            }
        ]
    });
    mutable.compile('^/evil$');
    assert.equal(snapshot.hosts[0].paths[0].pathname.source, '^\\/safe$');
});

test('catalog rejects IP, local and unsafe authorities in every host rule', () => {
    for (const hostname of [
        '127.0.0.1', '::1', '[::1]', 'localhost', 'player.localhost',
        'player.local', 'safe.test:443'
    ]) {
        for (const changed of [
            {
                ...catalog.hosts[0],
                domains: [{ hostname, kind: 'canonical' as const,
                    allowSubdomains: false as const }]
            },
            { ...catalog.hosts[0], redirectHostnames: [hostname] },
            {
                ...catalog.hosts[0],
                blockedHostnames: [{ hostname, role: 'cdn' as const }]
            }
        ]) {
            assert.throws(() =>
                validateEmbedHostCatalog({ ...catalog, hosts: [changed] })
            );
        }
    }
});

test('request context accepts four safe headers and fingerprints without exposing values', () => {
    const safe = validatePlaybackHeaders(
        {
            referer: ' https://embed.fixture.test/e/context ',
            origin: 'https://embed.fixture.test',
            accept: 'application/vnd.apple.mpegurl',
            'user-agent': 'CinePro Fixture'
        },
        {
            allowedRefererHostnames: new Set(['embed.fixture.test']),
            fixedUserAgent: 'CinePro Fixture',
            limits: { maxHeaderBytes: 2048, maxHeaderValueBytes: 1024 }
        }
    );
    assert.deepEqual(safe, {
        Referer: 'https://embed.fixture.test/e/context',
        Origin: 'https://embed.fixture.test',
        Accept: 'application/vnd.apple.mpegurl',
        'User-Agent': 'CinePro Fixture'
    });
    assert.match(stableFingerprint('response', 'json'), /^[a-f0-9]{64}$/);
    for (const input of [
        { Cookie: 'secret-cookie' },
        { Authorization: 'Bearer secret-token' },
        { Referer: 'https://evil.fixture.test/' },
        { Origin: 'https://user:secret@embed.fixture.test' },
        { Referer: 'https://127.0.0.1/' },
        { Referer: 'https://localhost/' },
        { Referer: 'https://embed.fixture.test:444/' },
        { Accept: 'ok\r\nX-Token: secret' }
    ]) {
        assert.throws(
            () =>
                validatePlaybackHeaders(input, {
                    allowedRefererHostnames: new Set(['embed.fixture.test']),
                    limits: { maxHeaderBytes: 2048, maxHeaderValueBytes: 1024 }
                }),
            /UNSAFE_HEADER/
        );
    }
});

test('dedupe is stable within an upstream and never erases cross-upstream attribution', () => {
    const target = fixtureTarget();
    assert.equal(dedupeEmbedTargets([target, target], leafIdentity).length, 1);
    const other = {
        ...leafIdentity,
        providerId: 'fixture:two' as CanonicalUpstreamId,
        upstreamId: 'fixture:two' as CanonicalUpstreamId
    };
    assert.equal(dedupeEmbedTargets([target], leafIdentity).length, 1);
    assert.equal(dedupeEmbedTargets([target], other).length, 1);
    assert.notEqual(leafIdentity.upstreamId, other.upstreamId);
    assert.equal(
        dedupeEmbedTargets(
            [
                target,
                {
                    ...target,
                    requestHeaders: {
                        Referer: 'https://embed.fixture.test/e/other'
                    }
                }
            ],
            leafIdentity
        ).length,
        2
    );
});

test('registry preserves family/leaf identity, deterministic order and host eligibility', async () => {
    const adapter = fixtureAdapter(async (input) => ({
        ok: true,
        hostId,
        identity: input.identity,
        targets: [fixtureTarget('b'), fixtureTarget('a'), fixtureTarget('b')],
        diagnostics: []
    }));
    const registry = fixtureRegistry(adapter);
    for (const identity of [familyIdentity, leafIdentity]) {
        const result = await registry.resolve(fixtureInput(identity));
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.deepEqual(result.identity, identity);
            assert.deepEqual(
                result.targets.map((target) => target.quality),
                ['b', 'a']
            );
        }
    }
    const disabled = fixtureRegistry(adapter, {
        eligibility: hostEligibility(false, 'host_deny')
    });
    const failure = await disabled.resolve(fixtureInput(leafIdentity));
    assert.equal(failure.ok, false);
    if (!failure.ok) {
        assert.equal(failure.failure.class, 'disabled');
        assert.equal(failure.failure.code, 'HOST_DISABLED');
        assert.deepEqual(failure.identity, leafIdentity);
    }
});

test('registry rejects identity mutation, DRM, anti-bot and noncooperating timeout', async () => {
    const mutation = await fixtureRegistry(
        fixtureAdapter(async () => ({
            ok: true,
            hostId,
            identity: familyIdentity,
            targets: [fixtureTarget()],
            diagnostics: []
        }))
    ).resolve(fixtureInput(leafIdentity));
    assert.equal(!mutation.ok && mutation.failure.code, 'UNCLASSIFIED');

    const drm = await fixtureRegistry(
        fixtureAdapter(async (input) => ({
            ok: true,
            hostId,
            identity: input.identity,
            targets: [
                {
                    ...fixtureTarget(),
                    url: new URL('https://media.fixture.test/manifest.mpd')
                }
            ],
            diagnostics: []
        }))
    ).resolve(fixtureInput(leafIdentity));
    assert.equal(!drm.ok && drm.failure.code, 'DRM_DETECTED');
    const explicitDrm = await fixtureRegistry(
        fixtureAdapter(async (input) => ({
            ok: true,
            hostId,
            identity: input.identity,
            targets: [{ ...fixtureTarget(), indicators: ['drm'] }],
            diagnostics: []
        }))
    ).resolve(fixtureInput(leafIdentity));
    assert.equal(!explicitDrm.ok && explicitDrm.failure.code, 'DRM_DETECTED');
    const challenge = await fixtureRegistry(
        fixtureAdapter(async (input) => ({
            ok: true,
            hostId,
            identity: input.identity,
            targets: [{ ...fixtureTarget(), indicators: ['captcha'] }],
            diagnostics: []
        }))
    ).resolve(fixtureInput(leafIdentity));
    assert.equal(!challenge.ok && challenge.failure.code, 'ANTI_BOT');

    const antiBot = await fixtureRegistry(
        fixtureAdapter(async (input) => ({
            ok: false,
            hostId,
            identity: input.identity,
            failure: {
                class: 'anti_bot',
                code: 'ANTI_BOT',
                retryable: false,
                stage: 'extract'
            }
        }))
    ).resolve(fixtureInput(leafIdentity));
    assert.equal(!antiBot.ok && antiBot.failure.code, 'ANTI_BOT');

    const timeout = await fixtureRegistry(
        fixtureAdapter(() => new Promise(() => {})),
        { limits: { deadlineMs: 5 } }
    ).resolve(fixtureInput(leafIdentity));
    assert.equal(!timeout.ok && timeout.failure.code, 'TIMEOUT');
});

test('pre-abort, URL bounds, quarantine and provider contexts are closed', async () => {
    let calls = 0;
    const registry = fixtureRegistry(
        fixtureAdapter(
            () =>
                new Promise(() => {
                    calls += 1;
                })
        ),
        { limits: { deadlineMs: 5 } }
    );
    const controller = new AbortController();
    controller.abort();
    const preAborted = await registry.resolve({
        ...fixtureInput(leafIdentity),
        signal: controller.signal
    });
    assert.equal(!preAborted.ok && preAborted.failure.code, 'TIMEOUT');
    await Promise.all(
        Array.from({ length: 8 }, () =>
            registry.resolve(fixtureInput(leafIdentity))
        )
    );
    assert.equal(calls, 1);

    const normal = fixtureRegistry(
        fixtureAdapter(async (input) => ({
            ok: true,
            hostId,
            identity: input.identity,
            targets: [fixtureTarget()],
            diagnostics: []
        })),
        { limits: { maxUrlLength: 64 } }
    );
    const long = await normal.resolve({
        ...fixtureInput(leafIdentity),
        url: new URL(`https://embed.fixture.test/e/${'x'.repeat(100)}`)
    });
    assert.equal(!long.ok && long.failure.code, 'INVALID_URL');
    for (const hostname of [
        '127.0.0.1',
        'localhost',
        'site.local',
        'example.com:444'
    ]) {
        const result = await normal.resolve({
            ...fixtureInput(leafIdentity),
            providerContextHostnames: [hostname]
        });
        assert.equal(!result.ok && result.failure.code, 'UNSAFE_HEADER');
    }
});

test('adapter output rules are snapshotted at registration', async () => {
    const adapter = fixtureAdapter(async (input) => ({
        ok: true,
        hostId,
        identity: input.identity,
        targets: [fixtureTarget()],
        diagnostics: []
    }));
    const registry = fixtureRegistry(adapter);
    (adapter.outputHostnames as string[])[0] = 'evil.fixture.test';
    assert.equal((await registry.resolve(fixtureInput(leafIdentity))).ok, true);
});

test('adapter sees a bounded frozen provider-context snapshot before empty output', async () => {
    const supplied = ['provider.fixture.test'];
    let seen: readonly string[] | undefined;
    const registry = fixtureRegistry(fixtureAdapter(async (input) => {
        seen = input.providerContextHostnames;
        assert.ok(Object.isFrozen(input.providerContextHostnames));
        return { ok: true, hostId, identity: input.identity, targets: [],
            diagnostics: [] };
    }));
    const pending = registry.resolve({
        ...fixtureInput(leafIdentity),
        providerContextHostnames: supplied
    });
    supplied[0] = '127.0.0.1';
    const result = await pending;
    assert.deepEqual(seen, ['provider.fixture.test']);
    assert.equal(!result.ok && result.failure.code, 'NO_SOURCES');

    let calls = 0;
    const emptyRegistry = fixtureRegistry(fixtureAdapter(async (input) => {
        calls += 1;
        return { ok: true, hostId, identity: input.identity, targets: [],
            diagnostics: [] };
    }));
    for (const providerContextHostnames of [
        ['127.0.0.1'],
        Array.from({ length: 17 }, (_, index) => `p${index}.fixture.test`)
    ]) {
        const rejected = await emptyRegistry.resolve({
            ...fixtureInput(leafIdentity),
            providerContextHostnames
        });
        assert.equal(!rejected.ok && rejected.failure.code, 'UNSAFE_HEADER');
    }
    assert.equal(calls, 0);
});

test('HeadlessVidX transport is fixed, bounded, authorized and stops on challenges', async () => {
    const calls: unknown[] = [];
    const client = createHeadlessVidXClient({
        serviceOrigin: new URL('http://127.0.0.1:3000'),
        authorize: (url) => createHostClassifier(catalog)(url).matched,
        limits: {
            deadlineMs: 100,
            maxResponseBytes: 1024,
            maxTargets: 2,
            maxUrlLength: 256
        },
        transport: {
            async request(input) {
                calls.push(input);
                return {
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ ok: false, reason: 'ANTI_BOT' })
                };
            }
        }
    });
    const result = await client.resolve({
        embedUrl: new URL('https://embed.fixture.test/e/fixture'),
        headers: {},
        signal
    });
    assert.deepEqual(result, { ok: false, reason: 'ANTI_BOT' });
    assert.equal(calls.length, 1);
    assert.deepEqual(
        Object.fromEntries(
            Object.entries(calls[0] as Record<string, unknown>).filter(
                ([key]) =>
                    ['path', 'redirect', 'maxResponseBytes'].includes(key)
            )
        ),
        { path: '/resolve', redirect: 'error', maxResponseBytes: 1024 }
    );
    await assert.rejects(() =>
        client.resolve({
            embedUrl: new URL('https://evil.fixture.test/e/x'),
            headers: {},
            signal
        })
    );
    for (const origin of [
        'http://example.com:8080',
        'http://8.8.8.8:8080',
        'http://localhost:8080'
    ]) {
        assert.throws(() =>
            createHeadlessVidXClient({
                serviceOrigin: new URL(origin),
                authorize: () => true,
                limits: {
                    deadlineMs: 10,
                    maxResponseBytes: 64,
                    maxTargets: 1,
                    maxUrlLength: 64
                },
                transport: { request: async () => new Promise(() => {}) }
            })
        );
    }
    const tightlyBounded = createHeadlessVidXClient({
        serviceOrigin: new URL('http://[::1]:3000'),
        authorize: () => true,
        limits: {
            deadlineMs: 5,
            maxResponseBytes: 80,
            maxTargets: 1,
            maxUrlLength: 80
        },
        transport: { request: async () => new Promise(() => {}) }
    });
    await assert.rejects(
        () =>
            tightlyBounded.resolve({
                embedUrl: new URL(
                    `https://embed.fixture.test/e/${'x'.repeat(100)}`
                ),
                headers: {},
                signal
            }),
        /not bounded/
    );
    await assert.rejects(
        () =>
            tightlyBounded.resolve({
                embedUrl: new URL('https://embed.fixture.test/e/x'),
                headers: { Accept: 'x'.repeat(100) },
                signal
            }),
        /not bounded/
    );
    const deadlineClient = createHeadlessVidXClient({
        serviceOrigin: new URL('http://192.168.1.20:3000'),
        authorize: () => true,
        limits: {
            deadlineMs: 5,
            maxResponseBytes: 1024,
            maxTargets: 1,
            maxUrlLength: 128
        },
        transport: { request: async () => new Promise(() => {}) }
    });
    await assert.rejects(
        () =>
            deadlineClient.resolve({
                embedUrl: new URL('https://embed.fixture.test/e/x'),
                headers: {},
                signal
            }),
        /deadline exceeded/
    );

    const origins: string[] = [];
    const mutationClient = createHeadlessVidXClient({
        serviceOrigin: new URL('http://127.0.0.1:3000'),
        authorize: () => true,
        limits: { deadlineMs: 100, maxResponseBytes: 1024, maxTargets: 1,
            maxUrlLength: 128 },
        transport: {
            async request(input) {
                origins.push(input.origin.origin);
                input.origin.port = '9999';
                return { status: 200, contentType: 'application/json',
                    body: JSON.stringify({ ok: false, reason: 'NO_SOURCES' }) };
            }
        }
    });
    for (let index = 0; index < 2; index += 1) {
        await mutationClient.resolve({
            embedUrl: new URL('https://embed.fixture.test/e/x'),
            headers: {},
            signal
        });
    }
    assert.deepEqual(origins, [
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3000'
    ]);
});

test('failures and redaction utilities never retain URL, token, header or title sentinels', async () => {
    const sentinels = [
        'signed-query-token',
        'cookie-secret',
        'authorization-secret',
        'fixture-title-secret'
    ];
    const result = await fixtureRegistry(
        fixtureAdapter(() =>
            Promise.reject(
                new Error(
                    `https://user:${sentinels[0]}@evil.test/path?token=${sentinels[1]} ${sentinels[2]} ${sentinels[3]}`
                )
            )
        )
    ).resolve(fixtureInput(leafIdentity));
    const serialized = JSON.stringify({
        result,
        sanitized: sanitizeAdapterError(new Error(sentinels.join(' ')))
    });
    for (const sentinel of sentinels) assert.ok(!serialized.includes(sentinel));
    assert.equal(!result.ok && result.failure.code, 'ADAPTER_THROW');
    const hostile = {
        ok: false,
        hostId,
        identity: leafIdentity,
        failure: {
            class: 'anti_bot',
            code: 'ANTI_BOT',
            retryable: false,
            stage: 'extract',
            fingerprints: { response: sentinels[0] },
            token: sentinels[1]
        },
        title: sentinels[3]
    } as unknown as EmbedFailure;
    const closed = await fixtureRegistry(
        fixtureAdapter(async () => hostile)
    ).resolve(fixtureInput(leafIdentity));
    for (const sentinel of sentinels)
        assert.ok(!JSON.stringify(closed).includes(sentinel));
    assert.deepEqual(Object.keys((closed as EmbedFailure).failure).sort(), [
        'class',
        'code',
        'retryable',
        'stage'
    ]);
});

function fixtureTarget(quality = 'fixture'): EmbedTarget {
    return {
        url: new URL(
            `https://media.fixture.test/master.m3u8?variant=${quality}`
        ),
        type: 'hls',
        quality,
        requestHeaders: {
            Referer: 'https://embed.fixture.test/e/context'
        }
    };
}

function fixtureAdapter(
    resolve: EmbedHostAdapter['resolve']
): EmbedHostAdapter {
    return {
        id: hostId,
        release: { version: 'fixture', commit: 'fixture' },
        backend: 'direct',
        outputHostnames: ['media.fixture.test'],
        resolve
    };
}

function fixtureRegistry(
    adapter: EmbedHostAdapter,
    options: {
        eligibility?: ProviderComponentEligibility;
        limits?: { deadlineMs?: number; maxUrlLength?: number };
    } = {}
) {
    return new EmbedHostRegistry({
        catalog,
        adapters: [adapter],
        fetch: {
            async fetch() {
                throw new Error('synthetic fixture must not make requests');
            }
        },
        eligibility: options.eligibility ?? hostEligibility(true),
        ...options
    });
}

function hostEligibility(
    enabled: boolean,
    disabledReason?: 'catalog' | 'host_deny' | 'host_not_allowed'
): ProviderComponentEligibility {
    const value = enabled ? { enabled } : { enabled, disabledReason };
    const subjects = new Map([[hostId, value]]);
    return {
        subjects,
        get: (id) => subjects.get(id),
        isEnabled: (id) => subjects.get(id)?.enabled === true
    };
}

function fixtureInput(identity: ResolverIdentity): EmbedInput {
    return {
        url: new URL('https://embed.fixture.test/e/fixture'),
        identity,
        purpose: 'resolve',
        signal,
        correlationId: 'fixture-correlation'
    };
}
