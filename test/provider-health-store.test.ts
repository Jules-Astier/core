import assert from 'node:assert/strict';
import {
    access,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rename,
    stat,
    symlink,
    unlink,
    utimes,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    ProviderHealthStore,
    type ProviderHealthSnapshot
} from '../src/health/provider-health-store.js';
import type { HealthResult } from '../src/health/provider-health.js';
import { installProviderHealthControl } from '../src/provider-health.js';

const baseTime = Date.UTC(2026, 6, 31, 12);

function result(
    id: string,
    overrides: Partial<HealthResult> = {}
): HealthResult {
    return {
        schemaVersion: 1,
        checkId: `check-${id.replace(':', '-')}`,
        subject: id.includes(':')
            ? {
                  id,
                  kind: 'leaf',
                  familyId: id.split(':')[0],
                  upstreamId: id
              }
            : { id, kind: 'family', familyId: id },
        level: 'lightweight',
        outcome: 'pass',
        durationMs: 12,
        checkedAt: new Date(baseTime).toISOString(),
        release: { version: 'test', commit: 'fixture' },
        ...overrides
    };
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-'));
    let nonce = 0;
    const store = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => `nonce-${++nonce}`
    });
    await store.initialize();
    return { root, store };
}

async function snapshot(root: string): Promise<ProviderHealthSnapshot> {
    return JSON.parse(await readFile(join(root, 'snapshot.v1.json'), 'utf8'));
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test('heartbeats a long-running lock so a contender cannot reclaim it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-lock-live-'));
    const entered = deferred();
    const release = deferred();
    const owner = new ProviderHealthStore({
        directory: root,
        createNonce: () => 'live-owner',
        lockStaleMs: 30,
        lockHeartbeatMs: 5,
        lockRetryMs: 2,
        lockTimeoutMs: 250,
        beforeAtomicRename: async () => {
            entered.resolve();
            await release.promise;
        }
    });
    const owning = owner.initialize();
    await entered.promise;
    const before = await stat(join(root, '.provider-health.lock'));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const contender = new ProviderHealthStore({
        directory: root,
        createNonce: () => 'live-contender',
        lockStaleMs: 30,
        lockHeartbeatMs: 5,
        lockRetryMs: 2,
        lockTimeoutMs: 25
    });
    await contender.initialize();
    assert.equal(contender.state.status, 'unavailable');
    const after = await stat(join(root, '.provider-health.lock'));
    assert.equal(after.ino, before.ino);

    release.resolve();
    await owning;
    assert.equal(owner.state.status, 'ready');
    await assert.rejects(access(join(root, '.provider-health.lock')));
});

test('quarantines and reclaims an exactly identified abandoned stale lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-lock-stale-'));
    const lock = join(root, '.provider-health.lock');
    await writeFile(
        lock,
        `${JSON.stringify({
            version: 1,
            pid: 999_999,
            nonce: 'abandoned',
            heartbeatAt: Date.now() - 10_000
        })}\n`,
        { mode: 0o600 }
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);
    const store = new ProviderHealthStore({
        directory: root,
        createNonce: () => 'reclaimer',
        lockStaleMs: 20,
        lockHeartbeatMs: 5,
        lockRetryMs: 2,
        lockTimeoutMs: 100
    });
    await store.initialize();
    assert.equal(store.state.status, 'ready');
    assert.equal(
        (await readdir(root)).some((name) =>
            name.startsWith('.provider-health.lock.stale-')
        ),
        false
    );
});

test('rejects a symlink lock without touching its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-lock-link-'));
    const target = join(root, 'lock-target');
    await writeFile(target, 'do-not-touch');
    await symlink(target, join(root, '.provider-health.lock'));
    const store = new ProviderHealthStore({
        directory: root,
        createNonce: () => 'link-attempt',
        lockStaleMs: 20,
        lockHeartbeatMs: 5,
        lockRetryMs: 2,
        lockTimeoutMs: 30
    });
    await store.initialize();
    assert.equal(store.state.status, 'unavailable');
    assert.equal(await readFile(target, 'utf8'), 'do-not-touch');
});

test('does not release a replacement lock after a nonce and inode ABA race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-lock-aba-'));
    const lock = join(root, '.provider-health.lock');
    let replaced = false;
    const store = new ProviderHealthStore({
        directory: root,
        createNonce: () => 'original-owner',
        beforeAtomicRename: async () => {
            if (replaced) return;
            replaced = true;
            await unlink(lock);
            await writeFile(
                lock,
                `${JSON.stringify({
                    version: 1,
                    pid: process.pid,
                    nonce: 'replacement-owner',
                    heartbeatAt: Date.now()
                })}\n`,
                { mode: 0o600 }
            );
        }
    });
    await store.initialize();
    assert.equal(store.state.status, 'ready');
    assert.equal(
        JSON.parse(await readFile(lock, 'utf8')).nonce,
        'replacement-owner'
    );
});

test('bounds lock acquisition time when a fresh owner remains active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-lock-timeout-'));
    await writeFile(
        join(root, '.provider-health.lock'),
        `${JSON.stringify({
            version: 1,
            pid: process.pid,
            nonce: 'fresh-owner',
            heartbeatAt: Date.now()
        })}\n`,
        { mode: 0o600 }
    );
    const started = Date.now();
    const store = new ProviderHealthStore({
        directory: root,
        createNonce: () => 'timed-contender',
        lockStaleMs: 1_000,
        lockHeartbeatMs: 100,
        lockRetryMs: 2,
        lockTimeoutMs: 25
    });
    await store.initialize();
    const elapsed = Date.now() - started;
    assert.equal(store.state.status, 'unavailable');
    assert.ok(elapsed >= 20, `elapsed ${elapsed}ms`);
    assert.ok(elapsed < 250, `elapsed ${elapsed}ms`);
});

test('publishes a strict sanitized snapshot and secure filesystem modes', async () => {
    const { root, store } = await fixture();
    const untrusted = result('tulnex') as HealthResult &
        Record<string, unknown>;
    untrusted.url = 'https://media.invalid/title?token=SECRET_SENTINEL';
    (untrusted.subject as unknown as Record<string, unknown>).title =
        'PRIVATE_TITLE';
    await store.persist([untrusted]);

    const serialized = await readFile(join(root, 'snapshot.v1.json'), 'utf8');
    for (const forbidden of [
        'https://',
        'token',
        'SECRET_SENTINEL',
        'PRIVATE_TITLE',
        'cookie',
        'header',
        'rawError'
    ]) {
        assert.equal(
            serialized.toLowerCase().includes(forbidden.toLowerCase()),
            false
        );
    }
    const stored = JSON.parse(serialized);
    assert.deepEqual(Object.keys(stored), [
        'schemaVersion',
        'generation',
        'generatedAt',
        'window',
        'latest',
        'history'
    ]);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'history'))).mode & 0o777, 0o700);
    assert.equal(
        (await stat(join(root, 'snapshot.v1.json'))).mode & 0o777,
        0o600
    );
    assert.equal(
        (await stat(join(root, 'history/events.current.jsonl'))).mode & 0o777,
        0o600
    );
});

test('partial persistence replaces only matching latest key and appends only the new event', async () => {
    const { store } = await fixture();
    const alpha = result('alpha');
    const beta = result('beta');
    await store.persist([alpha, beta]);
    const replacement = result('alpha', {
        checkId: 'check-alpha-recheck',
        level: 'resolver',
        outcome: 'fail',
        failureClass: 'no_sources',
        failureCode: 'CANARY_NO_SOURCES'
    });
    await store.persist([replacement]);

    assert.deepEqual(
        store.current.latest.map(({ checkId }) => checkId),
        ['check-alpha', 'check-alpha-recheck', 'check-beta']
    );
    assert.deepEqual(
        store.current.history.map(({ checkId }) => checkId),
        ['check-alpha', 'check-beta', 'check-alpha-recheck']
    );
});

test('long targeted history retains every latest key through cap and age trimming', async () => {
    let now = baseTime;
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-long-run-'));
    let nonce = 0;
    const store = new ProviderHealthStore({
        directory: root,
        now: () => now,
        createNonce: () => `long-${++nonce}`
    });
    await store.initialize();
    await store.persist([result('alpha'), result('beta'), result('gamma')]);
    now += 6 * 24 * 60 * 60 * 1_000;
    await store.persist(
        Array.from({ length: 1_101 }, (_, index) =>
            result('alpha', {
                checkId: `targeted-${index}`,
                level: 'resolver',
                checkedAt: new Date(now).toISOString()
            })
        )
    );
    now += 24 * 60 * 60 * 1_000 + 1;
    await store.persist([
        result('delta', { checkedAt: new Date(now).toISOString() })
    ]);

    const current = store.current;
    const latestKeys = new Set(current.latest.map(resultKeyForTest));
    const historyKeys = new Set(current.history.map(resultKeyForTest));
    assert.ok([...latestKeys].every((key) => historyKeys.has(key)));
    assert.ok(current.history.length > 1_000);
    assert.equal(latestKeys.has('beta\0lightweight'), false);
    assert.equal(latestKeys.has('delta\0lightweight'), true);
});

function resultKeyForTest(event: HealthResult): string {
    return `${event.subject.id}\0${event.level}`;
}

test('serializes concurrent writers without losing generations or events', async () => {
    const { root, store } = await fixture();
    await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
            store.persist([result(`provider-${index}`)])
        )
    );
    const stored = await snapshot(root);
    assert.equal(stored.generation, 20);
    assert.equal(stored.history.length, 20);
    assert.equal(
        (await readFile(join(root, 'history/events.current.jsonl'), 'utf8'))
            .trim()
            .split('\n').length,
        20
    );
});

test('coordinates independent store instances without losing a generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-two-stores-'));
    const first = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'first'
    });
    const second = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'second'
    });
    await Promise.all([first.initialize(), second.initialize()]);
    await Promise.all([
        first.persist([result('alpha')]),
        second.persist([result('beta')])
    ]);

    const stored = await snapshot(root);
    assert.equal(stored.generation, 2);
    assert.deepEqual(
        new Set(stored.history.map(({ subject }) => subject.id)),
        new Set(['alpha', 'beta'])
    );
    assert.equal(
        (await readFile(join(root, 'history/events.current.jsonl'), 'utf8'))
            .trim()
            .split('\n').length,
        2
    );
});

test('recovers a complete trusted history generation after interrupted cap replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-cap-crash-'));
    const history = join(root, 'history');
    await mkdir(history, { mode: 0o700 });
    const expired = result('expired', {
        checkedAt: new Date(
            baseTime - 7 * 24 * 60 * 60 * 1_000 - 1
        ).toISOString()
    });
    await writeFile(
        join(history, 'events.current.jsonl'),
        `${JSON.stringify(expired)}\n${JSON.stringify(result('trusted'))}\n`,
        { mode: 0o600 }
    );
    const interrupted = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'interrupted',
        beforeHistoryCommit: async () => {
            throw new Error('simulated process interruption');
        }
    });
    await interrupted.initialize();
    assert.equal(interrupted.state.status, 'unavailable');
    await assert.rejects(access(history));
    assert.match(
        await readFile(
            join(root, 'history.previous/events.current.jsonl'),
            'utf8'
        ),
        /"subject":\{"id":"trusted"/
    );

    const recovered = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'recovered'
    });
    await recovered.initialize();
    assert.equal(recovered.state.status, 'ready');
    assert.equal(recovered.state.failureCode, 'STORE_CORRUPT');
    assert.deepEqual(
        recovered.current.history.map(({ subject }) => subject.id),
        ['trusted']
    );
    await access(join(history, 'events.current.jsonl'));
    await assert.rejects(access(join(root, 'history.previous')));
});

test('rotates an oversized current history before appending', async () => {
    const { root, store } = await fixture();
    await writeFile(
        join(root, 'history/events.current.jsonl'),
        `${' '.repeat(4 * 1024 * 1024 - 1)}\n`,
        { mode: 0o600 }
    );
    await store.persist([result('tulnex')]);
    assert.equal(
        (await stat(join(root, 'history/events.0001.jsonl'))).isFile(),
        true
    );
    assert.match(
        await readFile(join(root, 'history/events.current.jsonl'), 'utf8'),
        /"checkId":"check-tulnex"/
    );
});

test('recovers from the last compatible backup when the primary is corrupt', async () => {
    const { root, store } = await fixture();
    await store.persist([result('tulnex')]);
    await store.persist([result('peachify')]);
    await writeFile(
        join(root, 'snapshot.v1.json'),
        '{"schemaVersion":1,broken'
    );

    const recovered = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'recovery'
    });
    await recovered.initialize();
    assert.equal(recovered.state.status, 'ready');
    assert.equal(recovered.state.failureCode, 'STORE_CORRUPT');
    assert.equal(recovered.current.latest[0].subject.id, 'tulnex');
    assert.equal((await snapshot(root)).latest[0].subject.id, 'tulnex');

    await recovered.persist([result('vidsrc')]);
    const backup = JSON.parse(
        await readFile(join(root, 'snapshot.v1.backup.json'), 'utf8')
    );
    assert.equal(backup.latest[0].subject.id, 'tulnex');
});

test('replays valid history and cleans only stale exact temp artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-replay-'));
    await mkdir(join(root, 'history'), { mode: 0o700 });
    await writeFile(
        join(root, 'history/events.current.jsonl'),
        `${JSON.stringify(result('tulnex'))}\n`
    );
    const stale = join(root, 'snapshot.v1.json.tmp.stale');
    const unrelated = join(root, 'snapshot.v1.json.tmp.stale.txt');
    await writeFile(stale, 'stale');
    await writeFile(unrelated, 'keep');
    const old = new Date(baseTime - 2 * 60 * 60 * 1_000);
    await utimes(stale, old, old);

    const recovered = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'replayed'
    });
    await recovered.initialize();
    assert.equal(recovered.current.latest[0].subject.id, 'tulnex');
    assert.equal((await snapshot(root)).latest[0].subject.id, 'tulnex');
    assert.equal(recovered.state.failureCode, 'STORE_CORRUPT');
    await assert.rejects(access(stale));
    await access(unrelated);
});

test('rejects an entire corrupt history segment instead of trusting its prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-corrupt-'));
    await mkdir(join(root, 'history'), { mode: 0o700 });
    await writeFile(
        join(root, 'history/events.0001.jsonl'),
        `${JSON.stringify(result('tulnex'))}\n{"broken":\n`
    );
    await writeFile(
        join(root, 'history/events.current.jsonl'),
        `${JSON.stringify(result('peachify'))}\n`
    );
    const recovered = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'quarantine'
    });
    await recovered.initialize();
    assert.deepEqual(
        recovered.current.history.map((event) => event.subject.id),
        ['peachify']
    );
    assert.equal(recovered.state.failureCode, 'STORE_CORRUPT');
    assert.ok(
        (await readdir(join(root, 'history'))).includes(
            'events.0001.jsonl.corrupt-quarantine'
        )
    );
});

test('keeps every history segment within hard byte and line bounds', async () => {
    const { root, store } = await fixture();
    const current = join(root, 'history/events.current.jsonl');
    const seed = `${JSON.stringify(result('seed'))}\n`;
    await writeFile(current, seed.repeat(9_999), { mode: 0o600 });
    await store.persist(
        Array.from({ length: 5_000 }, (_, index) => result(`provider-${index}`))
    );
    for (const name of await readdir(join(root, 'history'))) {
        if (!/^events\.(?:current|\d{4})\.jsonl$/.test(name)) continue;
        const data = await readFile(join(root, 'history', name), 'utf8');
        assert.ok(Buffer.byteLength(data) <= 4 * 1024 * 1024, name);
        assert.ok(data.split('\n').filter(Boolean).length <= 10_000, name);
    }
});

test('rejects unsafe snapshot generations, windows, and future clocks', async () => {
    for (const mutate of [
        (value: ProviderHealthSnapshot) => {
            value.generation = Number.MAX_SAFE_INTEGER + 1;
        },
        (value: ProviderHealthSnapshot) => {
            value.window.from = new Date(baseTime + 1).toISOString();
        },
        (value: ProviderHealthSnapshot) => {
            value.generatedAt = new Date(baseTime + 1).toISOString();
            value.window.from = value.generatedAt;
            value.window.to = value.generatedAt;
        },
        (value: ProviderHealthSnapshot) => {
            value.latest = [
                result('future', {
                    checkedAt: new Date(baseTime + 1).toISOString()
                })
            ];
        },
        (value: ProviderHealthSnapshot) => {
            const expired = result('expired', {
                checkedAt: new Date(
                    baseTime - 7 * 24 * 60 * 60 * 1_000 - 1
                ).toISOString()
            });
            value.history = [expired];
            value.window.from = expired.checkedAt;
        }
    ]) {
        const root = await mkdtemp(join(tmpdir(), 'cinepro-health-clock-'));
        await mkdir(join(root, 'history'), { mode: 0o700 });
        const invalid: ProviderHealthSnapshot = {
            schemaVersion: 1,
            generation: 0,
            generatedAt: new Date(baseTime).toISOString(),
            window: {
                from: new Date(baseTime).toISOString(),
                to: new Date(baseTime).toISOString()
            },
            latest: [],
            history: []
        };
        mutate(invalid);
        await writeFile(
            join(root, 'snapshot.v1.json'),
            JSON.stringify(invalid),
            { mode: 0o600 }
        );
        const store = new ProviderHealthStore({
            directory: root,
            now: () => baseTime,
            createNonce: () => 'clock'
        });
        await store.initialize();
        assert.equal(store.state.failureCode, 'STORE_CORRUPT');
        assert.deepEqual(store.current.history, []);
    }
});

test('rejects swapped primary and backup temporary inodes before publication', async () => {
    const swapTemp = async (temp: string) => {
        await rename(temp, `${temp}.swapped`);
        await writeFile(temp, '{"attacker":true}\n', { mode: 0o600 });
    };

    const primaryRoot = await mkdtemp(
        join(tmpdir(), 'cinepro-health-primary-swap-')
    );
    const primary = new ProviderHealthStore({
        directory: primaryRoot,
        now: () => baseTime,
        createNonce: () => 'primary-swap',
        beforeAtomicRename: async (temp, target) => {
            if (target.endsWith('snapshot.v1.json')) await swapTemp(temp);
        }
    });
    await primary.initialize();
    assert.equal(primary.state.status, 'unavailable');
    await assert.rejects(access(join(primaryRoot, 'snapshot.v1.json')));

    const { root, store } = await fixture();
    await store.persist([result('tulnex')]);
    const before = await readFile(join(root, 'snapshot.v1.json'), 'utf8');
    const backupBefore = await readFile(
        join(root, 'snapshot.v1.backup.json'),
        'utf8'
    );
    const backup = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'backup-swap',
        beforeAtomicRename: async (temp, target) => {
            if (target.endsWith('snapshot.v1.backup.json'))
                await swapTemp(temp);
        }
    });
    await backup.initialize();
    await backup.persist([result('peachify')]);
    assert.equal(backup.state.status, 'unavailable');
    assert.equal(
        await readFile(join(root, 'snapshot.v1.json'), 'utf8'),
        before
    );
    assert.equal(
        await readFile(join(root, 'snapshot.v1.backup.json'), 'utf8'),
        backupBefore
    );
});

test('retains and replays the same complete set of at most 12 segments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-retention-'));
    const history = join(root, 'history');
    await mkdir(history, { mode: 0o700 });
    for (let index = 1; index <= 12; index++) {
        await writeFile(
            join(history, `events.${String(index).padStart(4, '0')}.jsonl`),
            `${JSON.stringify(result(`provider-${index}`))}\n`,
            { mode: 0o600 }
        );
    }
    await writeFile(
        join(history, 'events.current.jsonl'),
        `${JSON.stringify(result('provider-current'))}\n`,
        { mode: 0o600 }
    );
    const recovered = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'retention'
    });
    await recovered.initialize();
    const retainedNames = (await readdir(history)).filter((name) =>
        /^events\.(?:current|\d{4})\.jsonl$/.test(name)
    );
    assert.equal(retainedNames.length, 12);
    assert.equal(retainedNames.includes('events.0001.jsonl'), false);
    assert.deepEqual(
        new Set(recovered.current.history.map((event) => event.subject.id)),
        new Set([
            ...Array.from(
                { length: 11 },
                (_, index) => `provider-${index + 2}`
            ),
            'provider-current'
        ])
    );
});

test('recovery hard-caps global history at 50000 events while preserving every latest key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-global-cap-'));
    const history = join(root, 'history');
    await mkdir(history, { mode: 0o700 });
    const events = [
        result('rare-provider', { checkId: 'rare-only' }),
        ...Array.from({ length: 50_004 }, (_, index) =>
            result(`provider-${index % 10}`, {
                checkId: `bulk-${index}`
            })
        )
    ];
    for (let offset = 0; offset < events.length; offset += 10_000) {
        const index = Math.floor(offset / 10_000) + 1;
        await writeFile(
            join(history, `events.${String(index).padStart(4, '0')}.jsonl`),
            events
                .slice(offset, offset + 10_000)
                .map((event) => `${JSON.stringify(event)}\n`)
                .join(''),
            { mode: 0o600 }
        );
    }
    const recovered = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'global-cap'
    });
    await recovered.initialize();

    const retainedNames = (await readdir(history)).filter((name) =>
        /^events\.(?:current|\d{4})\.jsonl$/.test(name)
    );
    let retainedCount = 0;
    const retainedIds = new Set<string>();
    for (const name of retainedNames) {
        const lines = (await readFile(join(history, name), 'utf8'))
            .split('\n')
            .filter(Boolean);
        retainedCount += lines.length;
        for (const line of lines) {
            retainedIds.add((JSON.parse(line) as HealthResult).subject.id);
        }
    }
    assert.equal(retainedCount, 50_000);
    assert.ok(retainedNames.length <= 12);
    assert.ok(retainedIds.has('rare-provider'));
    assert.ok(
        recovered.current.latest.some(
            ({ subject }) => subject.id === 'rare-provider'
        )
    );
});

test('rejects future runtime events without leaking persistence failure', async () => {
    const { store } = await fixture();
    await store.persist([
        result('future', { checkedAt: new Date(baseTime + 1).toISOString() })
    ]);
    assert.deepEqual(store.state, {
        enabled: true,
        status: 'unavailable',
        failureCode: 'STORE_UNAVAILABLE'
    });
    assert.deepEqual(store.current.history, []);
});

test('refuses generation overflow before appending history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-generation-'));
    await mkdir(join(root, 'history'), { mode: 0o700 });
    const time = new Date(baseTime).toISOString();
    await writeFile(
        join(root, 'snapshot.v1.json'),
        JSON.stringify({
            schemaVersion: 1,
            generation: Number.MAX_SAFE_INTEGER,
            generatedAt: time,
            window: { from: time, to: time },
            latest: [],
            history: []
        }),
        { mode: 0o600 }
    );
    const store = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'generation'
    });
    await store.initialize();
    await store.persist([result('tulnex')]);
    assert.equal(store.state.status, 'unavailable');
    await assert.rejects(access(join(root, 'history/events.current.jsonl')));
});

test('rejects symlinked and oversized artifacts without throwing into health', async () => {
    const symlinkRoot = await mkdtemp(join(tmpdir(), 'cinepro-health-link-'));
    const target = join(symlinkRoot, 'target');
    await writeFile(target, 'outside');
    await symlink(target, join(symlinkRoot, 'snapshot.v1.json'));
    const unsafe = new ProviderHealthStore({
        directory: symlinkRoot,
        now: () => baseTime,
        createNonce: () => 'unsafe'
    });
    await unsafe.initialize();
    assert.equal(unsafe.state.status, 'unavailable');

    const { root, store } = await fixture();
    await writeFile(
        join(root, 'snapshot.v1.json'),
        'x'.repeat(2 * 1024 * 1024 + 1)
    );
    const oversized = new ProviderHealthStore({
        directory: root,
        now: () => baseTime,
        createNonce: () => 'oversized'
    });
    await oversized.initialize();
    assert.equal(oversized.state.status, 'unavailable');
    assert.equal(oversized.current.schemaVersion, 1);
    assert.equal(store.state.status, 'ready');
});

test('optional integration awaits persistence but does not fail health when storage is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cinepro-health-control-'));
    const blocked = join(root, 'blocked');
    await writeFile(blocked, 'not-a-directory');
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
        [
            {
                id: 'tulnex',
                kind: 'provider',
                runtime: {
                    runtimeId: 'tulnex',
                    enabledDefault: true,
                    healthCheck: true
                }
            }
        ],
        { CINEPRO_PROVIDER_HEALTH_DIR: blocked },
        { createCheckId: () => 'integration' }
    );
    assert.equal(control.results[0].outcome, 'pass');
    assert.deepEqual(control.persistence, {
        enabled: true,
        status: 'unavailable',
        failureCode: 'STORE_UNAVAILABLE'
    });
});
