import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    CHECK_LEVELS,
    FAILURE_CLASSES,
    type HealthResult,
    type HealthSubject
} from './provider-health.js';

const SNAPSHOT = 'snapshot.v1.json';
const BACKUP = 'snapshot.v1.backup.json';
const HISTORY = 'history';
const HISTORY_PREVIOUS = 'history.previous';
const LOCK = '.provider-health.lock';
const CURRENT = 'events.current.jsonl';
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_LINES = 10_000;
const MAX_SEGMENTS = 12;
const MAX_EVENTS = 50_000;
const MAX_SNAPSHOT_HISTORY = 5_000;
const MAX_SUBJECTS = 5_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const TEMP_MAX_AGE_MS = 60 * 60 * 1_000;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 20_000;
const MAX_LOCK_BYTES = 512;
const MAX_LOCK_NONCE_LENGTH = 128;

type LockRecord = {
    version: 1;
    pid: number;
    nonce: string;
    heartbeatAt: number;
};

export type ProviderHealthSnapshot = {
    schemaVersion: 1;
    generation: number;
    generatedAt: string;
    window: { from: string; to: string };
    latest: HealthResult[];
    history: HealthResult[];
};

export type ProviderHealthPersistenceState =
    | { enabled: false; status: 'disabled' }
    | {
          enabled: true;
          status: 'ready' | 'unavailable';
          failureCode?: 'STORE_UNAVAILABLE' | 'STORE_CORRUPT';
      };

export type ProviderHealthStoreOptions = {
    directory: string;
    now?: () => number;
    createNonce?: () => string;
    lockRetryMs?: number;
    lockTimeoutMs?: number;
    lockStaleMs?: number;
    lockHeartbeatMs?: number;
    beforeAtomicRename?: (temp: string, target: string) => Promise<void>;
    beforeHistoryCommit?: (
        staged: string,
        target: string,
        previous: string
    ) => Promise<void>;
};

export class ProviderHealthStore {
    private readonly directory: string;
    private readonly historyDirectory: string;
    private readonly now: () => number;
    private readonly createNonce: () => string;
    private readonly lockRetryMs: number;
    private readonly lockTimeoutMs: number;
    private readonly lockStaleMs: number;
    private readonly lockHeartbeatMs: number;
    private readonly beforeAtomicRename?: (
        temp: string,
        target: string
    ) => Promise<void>;
    private readonly beforeHistoryCommit?: (
        staged: string,
        target: string,
        previous: string
    ) => Promise<void>;
    private queue: Promise<void> = Promise.resolve();
    private corruptionObserved = false;
    private snapshot: ProviderHealthSnapshot;
    private persistenceState: ProviderHealthPersistenceState = {
        enabled: true,
        status: 'unavailable',
        failureCode: 'STORE_UNAVAILABLE'
    };

    constructor(options: ProviderHealthStoreOptions) {
        if (!options.directory || options.directory.includes('\0')) {
            throw new TypeError('Provider health store directory is required');
        }
        this.directory = options.directory;
        this.historyDirectory = join(options.directory, HISTORY);
        this.now = options.now ?? Date.now;
        this.createNonce = options.createNonce ?? randomUUID;
        this.lockRetryMs = positiveInteger(options.lockRetryMs, LOCK_RETRY_MS);
        this.lockTimeoutMs = positiveInteger(
            options.lockTimeoutMs,
            LOCK_TIMEOUT_MS
        );
        this.lockStaleMs = positiveInteger(options.lockStaleMs, LOCK_STALE_MS);
        this.lockHeartbeatMs = positiveInteger(
            options.lockHeartbeatMs,
            LOCK_HEARTBEAT_MS
        );
        if (this.lockHeartbeatMs >= this.lockStaleMs)
            throw new TypeError(
                'Provider health lock heartbeat must precede expiry'
            );
        this.beforeAtomicRename = options.beforeAtomicRename;
        this.beforeHistoryCommit = options.beforeHistoryCommit;
        this.snapshot = emptySnapshot(this.now());
    }

    get state(): ProviderHealthPersistenceState {
        return { ...this.persistenceState };
    }

    get current(): ProviderHealthSnapshot {
        return structuredClone(this.snapshot);
    }

    async initialize(): Promise<void> {
        await this.serialized(async () => {
            await secureDirectory(this.directory);
            await this.withFilesystemLock(async () => {
                await this.recoverHistoryGeneration();
                await secureDirectory(this.historyDirectory);
                await this.cleanupTemps();
                await this.enforceHistoryEventCap();
                const primaryPresent = Boolean(
                    await readRegularFile(
                        join(this.directory, SNAPSHOT),
                        MAX_SNAPSHOT_BYTES
                    )
                );
                const primary = await this.readSnapshot(SNAPSHOT);
                const backup = primary
                    ? undefined
                    : await this.readSnapshot(BACKUP);
                const replayed =
                    primary || backup ? undefined : await this.replayHistory();
                const recovered = primary ?? backup ?? replayed;
                this.snapshot = recovered ?? emptySnapshot(this.now());
                if (!primary) await this.publish(this.snapshot);
                this.corruptionObserved =
                    this.corruptionObserved ||
                    Boolean(!primary && (primaryPresent || backup || replayed));
                this.setReadyState();
            });
        }).catch(() => {
            this.persistenceState = {
                enabled: true,
                status: 'unavailable',
                failureCode: 'STORE_UNAVAILABLE'
            };
        });
    }

    async persist(results: readonly HealthResult[]): Promise<void> {
        await this.serialized(async () => {
            const accepted = results.map(sanitizeHealthResult);
            if (accepted.length > MAX_SUBJECTS) {
                throw new TypeError(
                    'Provider health result count exceeds limit'
                );
            }
            const now = this.now();
            for (const event of accepted) {
                if (Date.parse(event.checkedAt) > now)
                    throw new TypeError('Future provider health event');
            }
            await this.withFilesystemLock(async () => {
                await this.recoverHistoryGeneration();
                await secureDirectory(this.historyDirectory);
                const disk = await this.readSnapshot(SNAPSHOT);
                if (!disk)
                    throw new TypeError('Provider health snapshot unavailable');
                this.snapshot = disk;
                if (disk.generation >= Number.MAX_SAFE_INTEGER)
                    throw new TypeError('Provider health generation exhausted');
                await this.appendEvents(accepted);
                await this.enforceHistoryEventCap();
                const cutoff = this.now() - MAX_AGE_MS;
                const latestBySubject = new Map<string, HealthResult>();
                for (const event of disk.latest) {
                    if (Date.parse(event.checkedAt) >= cutoff)
                        latestBySubject.set(resultKey(event), event);
                }
                for (const event of accepted)
                    latestBySubject.set(resultKey(event), event);
                const latest = [...latestBySubject.values()]
                    .sort(compareResults)
                    .slice(0, MAX_SUBJECTS);
                const history = compactHistory(
                    [...disk.history, ...accepted].filter(
                        (event) => Date.parse(event.checkedAt) >= cutoff
                    ),
                    latest
                );
                const times = history.map((event) =>
                    Date.parse(event.checkedAt)
                );
                const generatedAt = new Date(this.now()).toISOString();
                const next: ProviderHealthSnapshot = {
                    schemaVersion: 1,
                    generation: disk.generation + 1,
                    generatedAt,
                    window: {
                        from: new Date(
                            times.length ? Math.min(...times) : this.now()
                        ).toISOString(),
                        to: generatedAt
                    },
                    latest,
                    history
                };
                validateSnapshot(next, this.now());
                await this.publish(next);
                this.snapshot = next;
                this.setReadyState();
            });
        }).catch(() => {
            this.persistenceState = {
                enabled: true,
                status: 'unavailable',
                failureCode: 'STORE_UNAVAILABLE'
            };
        });
    }

    private async serialized(work: () => Promise<void>): Promise<void> {
        const next = this.queue.then(work, work);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private setReadyState(): void {
        this.persistenceState = this.corruptionObserved
            ? {
                  enabled: true,
                  status: 'ready',
                  failureCode: 'STORE_CORRUPT'
              }
            : { enabled: true, status: 'ready' };
    }

    private async withFilesystemLock(work: () => Promise<void>): Promise<void> {
        const path = join(this.directory, LOCK);
        const nonce = lockNonce(this.createNonce());
        const deadline = Date.now() + this.lockTimeoutMs;
        let handle: fs.FileHandle | undefined;
        let expected: Stats | undefined;
        while (Date.now() < deadline) {
            try {
                handle = await fs.open(
                    path,
                    constants.O_WRONLY |
                        constants.O_CREAT |
                        constants.O_EXCL |
                        noFollow(),
                    FILE_MODE
                );
                await handle.chmod(FILE_MODE);
                await writeLockRecord(handle, {
                    version: 1,
                    pid: process.pid,
                    nonce,
                    heartbeatAt: Date.now()
                });
                await handle.datasync();
                expected = await handle.stat();
                break;
            } catch (error) {
                await handle?.close().catch(() => undefined);
                handle = undefined;
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw error;
                const identity = await regularFile(path, MAX_LOCK_BYTES);
                if (
                    identity &&
                    Date.now() - identity.mtimeMs > this.lockStaleMs
                ) {
                    const stale = await readLock(path);
                    if (
                        stale &&
                        sameIdentity(stale.stat, identity) &&
                        lockExpired(stale, Date.now(), this.lockStaleMs)
                    ) {
                        await reclaimExpiredLock(
                            path,
                            stale,
                            nonce,
                            this.lockStaleMs
                        );
                        continue;
                    }
                }
                await delay(
                    Math.min(
                        this.lockRetryMs,
                        Math.max(1, deadline - Date.now())
                    )
                );
            }
        }
        if (!handle || !expected)
            throw new TypeError('Provider health store lock timeout');
        let heartbeatFailure: unknown;
        let heartbeat = Promise.resolve();
        const timer = setInterval(() => {
            heartbeat = heartbeat.then(async () => {
                if (heartbeatFailure) return;
                try {
                    await assertLockOwnership(path, expected, nonce);
                    await writeLockRecord(handle, {
                        version: 1,
                        pid: process.pid,
                        nonce,
                        heartbeatAt: Date.now()
                    });
                    await handle.datasync();
                } catch (error) {
                    heartbeatFailure = error;
                }
            });
        }, this.lockHeartbeatMs);
        timer.unref();
        try {
            await work();
            if (heartbeatFailure) throw heartbeatFailure;
        } finally {
            clearInterval(timer);
            await heartbeat;
            await handle.close();
            await releaseLock(path, expected, nonce);
            await syncDirectory(this.directory);
        }
    }

    private async recoverHistoryGeneration(): Promise<void> {
        const previous = join(this.directory, HISTORY_PREVIOUS);
        const active = await directoryIdentity(this.historyDirectory);
        const prior = await directoryIdentity(previous);
        if (!active && prior) {
            await assertDirectoryIdentity(previous, prior);
            await fs.rename(previous, this.historyDirectory);
            await syncDirectory(this.directory);
            this.corruptionObserved = true;
        } else if (active && prior) {
            await removeDirectoryIfUnchanged(previous, prior);
            await syncDirectory(this.directory);
        }
        const entries = await fs.readdir(this.directory, {
            withFileTypes: true
        });
        for (const entry of entries) {
            if (
                !entry.isDirectory() ||
                !/^history\.tmp\.[A-Za-z0-9_-]+$/.test(entry.name)
            )
                continue;
            const path = join(this.directory, entry.name);
            const identity = await directoryIdentity(path);
            if (identity) await removeDirectoryIfUnchanged(path, identity);
        }
    }

    private async cleanupTemps(): Promise<void> {
        const entries = await fs.readdir(this.directory, {
            withFileTypes: true
        });
        const cutoff = this.now() - TEMP_MAX_AGE_MS;
        for (const entry of entries) {
            if (!/^snapshot\.v1\.json\.tmp\.[A-Za-z0-9_-]+$/.test(entry.name))
                continue;
            const path = join(this.directory, entry.name);
            const file = await readRegularFile(path, MAX_SNAPSHOT_BYTES);
            if (file && file.stat.mtimeMs < cutoff) {
                const current = await fs.lstat(path);
                if (
                    current.dev !== file.stat.dev ||
                    current.ino !== file.stat.ino
                )
                    throw new TypeError('Provider health temp changed');
                await fs.unlink(path);
                await syncDirectory(this.directory);
            }
        }
    }

    private async readSnapshot(
        name: string
    ): Promise<ProviderHealthSnapshot | undefined> {
        const path = join(this.directory, name);
        try {
            const file = await readRegularFile(path, MAX_SNAPSHOT_BYTES);
            if (!file) return undefined;
            const data = file.data;
            const parsed: unknown = JSON.parse(data);
            validateSnapshot(parsed, this.now());
            return parsed;
        } catch {
            return undefined;
        }
    }

    private async replayHistory(): Promise<ProviderHealthSnapshot | undefined> {
        await this.trimSegments(false);
        const entries = await fs.readdir(this.historyDirectory, {
            withFileTypes: true
        });
        const names = entries
            .filter(
                (entry) =>
                    entry.isFile() &&
                    /^(?:events\.current|events\.\d{4})\.jsonl$/.test(
                        entry.name
                    )
            )
            .map((entry) => entry.name)
            .sort();
        const events: HealthResult[] = [];
        for (const name of names) {
            const path = join(this.historyDirectory, name);
            const file = await readRegularFile(path, MAX_HISTORY_BYTES);
            if (!file) continue;
            const lines = file.data.split('\n');
            const segment: HealthResult[] = [];
            let corrupt = false;
            for (let index = 0; index < lines.length; index++) {
                if (!lines[index]) continue;
                try {
                    const event = sanitizeHealthResult(
                        JSON.parse(lines[index])
                    );
                    if (Date.parse(event.checkedAt) > this.now())
                        throw new TypeError('Future event');
                    segment.push(event);
                } catch {
                    if (
                        name === CURRENT &&
                        index === lines.length - 1 &&
                        !file.data.endsWith('\n')
                    )
                        continue;
                    corrupt = true;
                    break;
                }
            }
            if (corrupt) {
                await quarantineIfUnchanged(
                    path,
                    file.stat,
                    this.createNonce()
                );
                this.corruptionObserved = true;
                continue;
            }
            events.push(...segment);
        }
        if (!events.length) return undefined;
        const recent = events.filter(
            (event) => Date.parse(event.checkedAt) >= this.now() - MAX_AGE_MS
        );
        const replayLatest = new Map<string, HealthResult>();
        for (const event of recent) replayLatest.set(resultKey(event), event);
        const retained = compactHistory(recent, [...replayLatest.values()]);
        if (!retained.length) return undefined;
        const latestBySubject = new Map<string, HealthResult>();
        for (const event of retained)
            latestBySubject.set(`${event.subject.id}\0${event.level}`, event);
        const now = this.now();
        return {
            schemaVersion: 1,
            generation: 0,
            generatedAt: new Date(now).toISOString(),
            window: {
                from: new Date(
                    Math.min(
                        ...retained.map((event) => Date.parse(event.checkedAt))
                    )
                ).toISOString(),
                to: new Date(now).toISOString()
            },
            latest: [...latestBySubject.values()].sort(compareResults),
            history: retained
        };
    }

    private async rotateCurrent(): Promise<void> {
        const path = join(this.historyDirectory, CURRENT);
        const file = await readRegularFile(path, MAX_HISTORY_BYTES);
        if (!file || !file.stat.size) return;
        const entries = await fs.readdir(this.historyDirectory);
        const numbers = entries
            .map((name) => /^events\.(\d{4})\.jsonl$/.exec(name)?.[1])
            .filter((value): value is string => Boolean(value))
            .map(Number);
        const current = await fs.lstat(path);
        if (current.dev !== file.stat.dev || current.ino !== file.stat.ino)
            throw new TypeError('Provider health history changed');
        await fs.rename(
            path,
            join(
                this.historyDirectory,
                `events.${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}.jsonl`
            )
        );
        await this.trimSegments(true);
        await syncDirectory(this.historyDirectory);
    }

    private async enforceHistoryEventCap(): Promise<void> {
        const entries = await fs.readdir(this.historyDirectory, {
            withFileTypes: true
        });
        const names = entries
            .filter(
                (entry) =>
                    entry.isFile() &&
                    /^(?:events\.current|events\.\d{4})\.jsonl$/.test(
                        entry.name
                    )
            )
            .map((entry) => entry.name)
            .sort();
        const events: HealthResult[] = [];
        for (const name of names) {
            const file = await readRegularFile(
                join(this.historyDirectory, name),
                MAX_HISTORY_BYTES
            );
            if (!file) continue;
            for (const line of file.data.split('\n')) {
                if (!line) continue;
                try {
                    events.push(sanitizeHealthResult(JSON.parse(line)));
                } catch {
                    // Replay owns corruption quarantine. Do not rewrite a
                    // partially trusted history set here.
                    return;
                }
            }
        }
        const eligible = events.filter(
            (event) => Date.parse(event.checkedAt) >= this.now() - MAX_AGE_MS
        );
        if (eligible.length === events.length && events.length <= MAX_EVENTS)
            return;

        const latestIndexByKey = new Map<string, number>();
        eligible.forEach((event, index) =>
            latestIndexByKey.set(resultKey(event), index)
        );
        const mandatory = new Set(latestIndexByKey.values());
        const optional = eligible
            .map((_, index) => index)
            .filter((index) => !mandatory.has(index));
        const retainWithOptional = (count: number) => {
            const selected = new Set([
                ...mandatory,
                ...optional.slice(Math.max(0, optional.length - count))
            ]);
            return eligible.filter((_, index) => selected.has(index));
        };
        let lower = 0;
        let upper = Math.min(
            optional.length,
            Math.max(0, MAX_EVENTS - mandatory.size)
        );
        if (packHistory(retainWithOptional(0)).length > MAX_SEGMENTS)
            throw new TypeError(
                'Latest provider health events exceed history capacity'
            );
        while (lower < upper) {
            const candidate = Math.ceil((lower + upper) / 2);
            if (
                packHistory(retainWithOptional(candidate)).length <=
                MAX_SEGMENTS
            )
                lower = candidate;
            else upper = candidate - 1;
        }
        const retained = retainWithOptional(lower);
        const packed = packHistory(retained);
        const nonce = this.createNonce().replace(/[^A-Za-z0-9_-]/g, '');
        if (!nonce) throw new TypeError('Invalid provider health nonce');
        const staged = join(this.directory, `history.tmp.${nonce}`);
        const previous = join(this.directory, HISTORY_PREVIOUS);
        await fs.mkdir(staged, { mode: DIRECTORY_MODE });
        const stagedIdentity = await directoryIdentity(staged);
        if (!stagedIdentity)
            throw new TypeError('Provider health staging unavailable');
        for (let index = 0; index < packed.length; index++) {
            const name =
                index === packed.length - 1
                    ? CURRENT
                    : `events.${String(index + 1).padStart(4, '0')}.jsonl`;
            const handle = await fs.open(
                join(staged, name),
                constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    noFollow(),
                FILE_MODE
            );
            try {
                await handle.chmod(FILE_MODE);
                await handle.writeFile(packed[index].join(''));
                await handle.datasync();
            } finally {
                await handle.close();
            }
        }
        await syncDirectory(staged);
        await assertDirectoryIdentity(staged, stagedIdentity);
        const activeIdentity = await directoryIdentity(this.historyDirectory);
        if (!activeIdentity)
            throw new TypeError('Provider health history unavailable');
        if (await directoryIdentity(previous))
            throw new TypeError('Provider health previous history exists');
        await assertDirectoryIdentity(this.historyDirectory, activeIdentity);
        await fs.rename(this.historyDirectory, previous);
        await syncDirectory(this.directory);
        await this.beforeHistoryCommit?.(
            staged,
            this.historyDirectory,
            previous
        );
        await assertDirectoryIdentity(staged, stagedIdentity);
        await fs.rename(staged, this.historyDirectory);
        await syncDirectory(this.directory);
        await removeDirectoryIfUnchanged(previous, activeIdentity);
        await syncDirectory(this.directory);
    }

    private async trimSegments(reserveCurrent: boolean): Promise<void> {
        const entries = await fs.readdir(this.historyDirectory, {
            withFileTypes: true
        });
        const hasCurrent = entries.some(
            (entry) => entry.isFile() && entry.name === CURRENT
        );
        const numberedLimit =
            MAX_SEGMENTS - (hasCurrent || reserveCurrent ? 1 : 0);
        const segments = entries
            .filter(
                (entry) =>
                    entry.isFile() && /^events\.\d{4}\.jsonl$/.test(entry.name)
            )
            .map((entry) => entry.name)
            .sort();
        for (const name of segments.slice(
            0,
            Math.max(0, segments.length - numberedLimit)
        )) {
            const path = join(this.historyDirectory, name);
            if (await regularFile(path, MAX_HISTORY_BYTES))
                await fs.unlink(path);
        }
    }

    private async appendEvents(events: readonly HealthResult[]): Promise<void> {
        if (!events.length) return;
        const path = join(this.historyDirectory, CURRENT);
        const lines = events.map((event) => `${JSON.stringify(event)}\n`);
        if (lines.some((line) => Buffer.byteLength(line) - 1 > MAX_EVENT_BYTES))
            throw new TypeError('Provider health event exceeds limit');
        let offset = 0;
        while (offset < lines.length) {
            const existing = await readRegularFile(path, MAX_HISTORY_BYTES);
            const existingLines = existing
                ? existing.data.split('\n').filter(Boolean).length
                : 0;
            let bytes = existing?.stat.size ?? 0;
            let count = 0;
            while (offset + count < lines.length) {
                const size = Buffer.byteLength(lines[offset + count]);
                if (
                    bytes + size > MAX_HISTORY_BYTES ||
                    existingLines + count + 1 > MAX_HISTORY_LINES
                )
                    break;
                bytes += size;
                count++;
            }
            if (!count) {
                await this.rotateCurrent();
                continue;
            }
            const existed = Boolean(existing);
            if (!existed) await this.trimSegments(true);
            const handle = await fs.open(
                path,
                constants.O_WRONLY |
                    constants.O_APPEND |
                    constants.O_CREAT |
                    noFollow(),
                FILE_MODE
            );
            try {
                const stat = await handle.stat();
                if (
                    existing &&
                    (stat.dev !== existing.stat.dev ||
                        stat.ino !== existing.stat.ino)
                )
                    throw new TypeError('Provider health history changed');
                await handle.chmod(FILE_MODE);
                await handle.writeFile(
                    lines.slice(offset, offset + count).join('')
                );
                await handle.datasync();
            } finally {
                await handle.close();
            }
            if (!existed) await syncDirectory(this.historyDirectory);
            offset += count;
            if (offset < lines.length) await this.rotateCurrent();
        }
    }

    private async publish(snapshot: ProviderHealthSnapshot): Promise<void> {
        validateSnapshot(snapshot, this.now());
        const data = `${JSON.stringify(snapshot)}\n`;
        if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) {
            throw new TypeError('Provider health snapshot exceeds limit');
        }
        const nonce = this.createNonce().replace(/[^A-Za-z0-9_-]/g, '');
        if (!nonce) throw new TypeError('Invalid provider health nonce');
        const temp = join(this.directory, `snapshot.v1.json.tmp.${nonce}`);
        const target = join(this.directory, SNAPSHOT);
        const backup = join(this.directory, BACKUP);
        const handle = await fs.open(
            temp,
            constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                noFollow(),
            FILE_MODE
        );
        let expected: Stats;
        try {
            await handle.chmod(FILE_MODE);
            await handle.writeFile(data);
            await handle.sync();
            expected = await handle.stat();
        } finally {
            await handle.close();
        }
        try {
            const prior = await this.readSnapshot(SNAPSHOT);
            if (prior) {
                await writeAtomicFile(
                    this.directory,
                    BACKUP,
                    `${JSON.stringify(prior)}\n`,
                    `${nonce}-backup`,
                    this.beforeAtomicRename
                );
            }
            await this.beforeAtomicRename?.(temp, target);
            await assertPathIdentity(temp, expected);
            await fs.rename(temp, target);
            await syncDirectory(this.directory);
        } catch (error) {
            await fs.unlink(temp).catch(() => undefined);
            throw error;
        }
    }
}

function compactHistory(
    events: readonly HealthResult[],
    latest: readonly HealthResult[]
): HealthResult[] {
    const positions = new Map<string, number>();
    events.forEach((event, index) => {
        positions.set(`${resultKey(event)}\0${event.checkId}`, index);
    });
    const selected = [...latest];
    const includedEvents = new Set(
        latest.map((event) => `${resultKey(event)}\0${event.checkId}`)
    );
    for (let index = events.length - 1; index >= 0; index--) {
        if (selected.length >= MAX_SNAPSHOT_HISTORY) break;
        const event = events[index];
        const identity = `${resultKey(event)}\0${event.checkId}`;
        if (!includedEvents.has(identity)) {
            selected.push(event);
            includedEvents.add(identity);
        }
    }
    return selected.sort((a, b) => {
        const aPosition =
            positions.get(`${resultKey(a)}\0${a.checkId}`) ??
            Number.MAX_SAFE_INTEGER;
        const bPosition =
            positions.get(`${resultKey(b)}\0${b.checkId}`) ??
            Number.MAX_SAFE_INTEGER;
        return aPosition - bPosition || compareResults(a, b);
    });
}

function packHistory(events: readonly HealthResult[]): string[][] {
    const segments: string[][] = [];
    let lines: string[] = [];
    let bytes = 0;
    for (const event of events) {
        const line = `${JSON.stringify(event)}\n`;
        const size = Buffer.byteLength(line);
        if (size - 1 > MAX_EVENT_BYTES)
            throw new TypeError('Provider health event exceeds limit');
        if (
            lines.length &&
            (lines.length >= MAX_HISTORY_LINES ||
                bytes + size > MAX_HISTORY_BYTES)
        ) {
            segments.push(lines);
            lines = [];
            bytes = 0;
        }
        lines.push(line);
        bytes += size;
    }
    if (lines.length) segments.push(lines);
    return segments;
}

function sanitizeHealthResult(value: unknown): HealthResult {
    if (!isRecord(value) || value.schemaVersion !== 1)
        throw new TypeError('Invalid health result');
    const subject = sanitizeSubject(value.subject);
    const level = value.level;
    const outcome = value.outcome;
    if (
        !CHECK_LEVELS.includes(level as never) ||
        !['pass', 'fail', 'skipped'].includes(String(outcome))
    ) {
        throw new TypeError('Invalid health result enum');
    }
    const checkId = safeString(
        value.checkId,
        128,
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
    );
    const failureCode =
        value.failureCode === undefined
            ? undefined
            : safeString(value.failureCode, 64, /^[A-Z][A-Z0-9_]*$/);
    const failureClass = value.failureClass;
    if (
        failureClass !== undefined &&
        !FAILURE_CLASSES.includes(failureClass as never)
    )
        throw new TypeError('Invalid failure class');
    const disabledReason = value.disabledReason;
    const reasons = [
        'catalog',
        'family_deny',
        'family_not_allowed',
        'leaf_deny',
        'leaf_not_allowed',
        'host_deny',
        'host_not_allowed'
    ];
    if (
        disabledReason !== undefined &&
        !reasons.includes(String(disabledReason))
    )
        throw new TypeError('Invalid disabled reason');
    const durationMs = value.durationMs;
    if (
        !Number.isInteger(durationMs) ||
        Number(durationMs) < 0 ||
        Number(durationMs) > 60_000
    )
        throw new TypeError('Invalid duration');
    const checkedAt = safeIso(value.checkedAt);
    if (!isRecord(value.release)) throw new TypeError('Invalid release');
    const release = {
        version: safeString(
            value.release.version,
            64,
            /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
        ),
        commit: safeString(
            value.release.commit,
            64,
            /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
        )
    };
    return {
        schemaVersion: 1,
        checkId,
        subject,
        level: level as HealthResult['level'],
        outcome: outcome as HealthResult['outcome'],
        ...(failureClass === undefined
            ? {}
            : { failureClass: failureClass as HealthResult['failureClass'] }),
        ...(failureCode === undefined ? {} : { failureCode }),
        ...(disabledReason === undefined
            ? {}
            : {
                  disabledReason:
                      disabledReason as HealthResult['disabledReason']
              }),
        durationMs: Number(durationMs),
        checkedAt,
        release
    };
}

function sanitizeSubject(value: unknown): HealthSubject {
    if (!isRecord(value)) throw new TypeError('Invalid subject');
    const id = safeString(
        value.id,
        128,
        /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?$/
    );
    const familyId = safeString(
        value.familyId,
        64,
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    );
    if (value.kind === 'family' && id === familyId)
        return { id, kind: 'family', familyId };
    if (
        value.kind === 'leaf' &&
        id.startsWith(`${familyId}:`) &&
        value.upstreamId === id
    )
        return { id, kind: 'leaf', familyId, upstreamId: id };
    if (
        value.kind === 'embed_host' &&
        value.embedHostId === id &&
        !id.includes(':')
    )
        return { id, kind: 'embed_host', familyId, embedHostId: id };
    throw new TypeError('Inconsistent health subject');
}

function validateSnapshot(
    value: unknown,
    now: number
): asserts value is ProviderHealthSnapshot {
    if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.generation) ||
        Number(value.generation) < 0
    )
        throw new TypeError('Invalid snapshot');
    onlyKeys(value, [
        'schemaVersion',
        'generation',
        'generatedAt',
        'window',
        'latest',
        'history'
    ]);
    const generatedAt = Date.parse(safeIso(value.generatedAt));
    if (generatedAt > now) throw new TypeError('Future snapshot');
    if (!isRecord(value.window)) throw new TypeError('Invalid snapshot window');
    onlyKeys(value.window, ['from', 'to']);
    const from = Date.parse(safeIso(value.window.from));
    const to = Date.parse(safeIso(value.window.to));
    if (from > to || to !== generatedAt)
        throw new TypeError('Invalid snapshot window');
    if (
        !Array.isArray(value.latest) ||
        !Array.isArray(value.history) ||
        value.latest.length > MAX_SUBJECTS ||
        value.history.length > MAX_SNAPSHOT_HISTORY
    )
        throw new TypeError('Invalid snapshot bounds');
    for (const event of [...value.latest, ...value.history])
        assertStrictEvent(event);
    value.latest = value.latest.map(sanitizeHealthResult);
    value.history = value.history.map(sanitizeHealthResult);
    const eventTimes = [...value.latest, ...value.history].map(
        (event: HealthResult) => Date.parse(event.checkedAt)
    );
    if (eventTimes.some((time) => time > generatedAt))
        throw new TypeError('Future snapshot event');
    if (
        value.history.some(
            (event: HealthResult) =>
                Date.parse(event.checkedAt) < generatedAt - MAX_AGE_MS
        )
    )
        throw new TypeError('Expired snapshot history');
    const expectedFrom = value.history.length
        ? Math.min(
              ...value.history.map((event: HealthResult) =>
                  Date.parse(event.checkedAt)
              )
          )
        : generatedAt;
    if (from !== expectedFrom)
        throw new TypeError('Snapshot window does not match history');
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_SNAPSHOT_BYTES)
        throw new TypeError('Snapshot too large');
}

function emptySnapshot(now: number): ProviderHealthSnapshot {
    const time = new Date(now).toISOString();
    return {
        schemaVersion: 1,
        generation: 0,
        generatedAt: time,
        window: { from: time, to: time },
        latest: [],
        history: []
    };
}

async function secureDirectory(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    const handle = await fs.open(
        path,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollow()
    );
    try {
        const stat = await handle.stat();
        if (!stat.isDirectory())
            throw new TypeError('Unsafe provider health directory');
        await handle.chmod(DIRECTORY_MODE);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function regularFile(
    path: string,
    maximum: number
): Promise<Stats | undefined> {
    try {
        const stat = await fs.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
            throw new TypeError('Unsafe provider health file');
        return stat;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    }
}

async function readRegularFile(
    path: string,
    maximum: number
): Promise<{ data: string; stat: Stats } | undefined> {
    let handle;
    try {
        handle = await fs.open(path, constants.O_RDONLY | noFollow());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maximum)
            throw new TypeError('Unsafe provider health file');
        return { data: await handle.readFile('utf8'), stat };
    } finally {
        await handle.close();
    }
}

async function quarantineIfUnchanged(
    path: string,
    expected: Stats,
    nonceValue: string
): Promise<void> {
    const nonce = nonceValue.replace(/[^A-Za-z0-9_-]/g, '');
    if (!nonce) throw new TypeError('Invalid provider health nonce');
    const current = await fs.lstat(path);
    if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
    )
        throw new TypeError('Provider health segment changed');
    await fs.rename(path, `${path}.corrupt-${nonce}`);
    await syncDirectory(join(path, '..'));
}

async function writeAtomicFile(
    directory: string,
    name: string,
    data: string,
    nonceValue: string,
    beforeAtomicRename?: (temp: string, target: string) => Promise<void>
): Promise<void> {
    const nonce = nonceValue.replace(/[^A-Za-z0-9_-]/g, '');
    if (!nonce) throw new TypeError('Invalid provider health nonce');
    const temp = join(directory, `${name}.tmp.${nonce}`);
    const target = join(directory, name);
    const handle = await fs.open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
        FILE_MODE
    );
    let expected: Stats;
    try {
        await handle.chmod(FILE_MODE);
        await handle.writeFile(data);
        await handle.sync();
        expected = await handle.stat();
    } finally {
        await handle.close();
    }
    try {
        await beforeAtomicRename?.(temp, target);
        await assertPathIdentity(temp, expected);
        await fs.rename(temp, target);
        await syncDirectory(directory);
    } catch (error) {
        await fs.unlink(temp).catch(() => undefined);
        throw error;
    }
}

async function assertPathIdentity(
    path: string,
    expected: Stats
): Promise<void> {
    const current = await fs.lstat(path);
    if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
    )
        throw new TypeError('Provider health temp changed');
}

async function directoryIdentity(path: string): Promise<Stats | undefined> {
    try {
        const stat = await fs.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new TypeError('Unsafe provider health directory');
        return stat;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    }
}

async function assertDirectoryIdentity(
    path: string,
    expected: Stats
): Promise<void> {
    const current = await fs.lstat(path);
    if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
    )
        throw new TypeError('Provider health directory changed');
}

async function unlinkIfUnchanged(path: string, expected: Stats): Promise<void> {
    const current = await fs.lstat(path);
    if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
    )
        throw new TypeError('Provider health file changed');
    await fs.unlink(path);
}

function positiveInteger(value: number | undefined, fallback: number): number {
    const candidate = value ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate <= 0)
        throw new TypeError('Invalid provider health lock timing');
    return candidate;
}

function lockNonce(value: string): string {
    if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > MAX_LOCK_NONCE_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(value)
    )
        throw new TypeError('Invalid provider health lock nonce');
    return value;
}

function serializeLock(record: LockRecord): string {
    return `${JSON.stringify(record)}\n`;
}

function parseLock(data: string): LockRecord {
    if (Buffer.byteLength(data) > MAX_LOCK_BYTES)
        throw new TypeError('Provider health lock too large');
    const value: unknown = JSON.parse(data);
    if (
        !isRecord(value) ||
        Object.keys(value).length !== 4 ||
        value.version !== 1 ||
        !Number.isSafeInteger(value.pid) ||
        Number(value.pid) <= 0 ||
        !Number.isSafeInteger(value.heartbeatAt) ||
        Number(value.heartbeatAt) < 0
    )
        throw new TypeError('Invalid provider health lock');
    return {
        version: 1,
        pid: Number(value.pid),
        nonce: lockNonce(value.nonce),
        heartbeatAt: Number(value.heartbeatAt)
    };
}

async function writeLockRecord(
    handle: fs.FileHandle,
    record: LockRecord
): Promise<void> {
    const data = serializeLock(record);
    await handle.truncate(0);
    await handle.write(data, 0, 'utf8');
}

type ReadLock = { record: LockRecord; stat: Stats };

async function readLock(path: string): Promise<ReadLock | undefined> {
    const value = await readRegularFile(path, MAX_LOCK_BYTES);
    if (!value) return undefined;
    return { record: parseLock(value.data), stat: value.stat };
}

function sameIdentity(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function lockExpired(
    lock: ReadLock,
    now: number,
    staleMilliseconds: number
): boolean {
    return (
        now - lock.record.heartbeatAt > staleMilliseconds &&
        now - lock.stat.mtimeMs > staleMilliseconds
    );
}

async function assertLockOwnership(
    path: string,
    expected: Stats,
    nonce: string
): Promise<void> {
    const current = await readLock(path);
    if (
        !current ||
        !sameIdentity(current.stat, expected) ||
        current.record.nonce !== nonce
    )
        throw new TypeError('Provider health lock ownership changed');
}

async function releaseLock(
    path: string,
    expected: Stats,
    nonce: string
): Promise<void> {
    let current: ReadLock | undefined;
    try {
        current = await readLock(path);
    } catch {
        return;
    }
    if (
        !current ||
        !sameIdentity(current.stat, expected) ||
        current.record.nonce !== nonce
    )
        return;
    const quarantine = `${path}.release-${randomUUID()}`;
    await fs.rename(path, quarantine);
    const moved = await readLock(quarantine);
    if (
        !moved ||
        !sameIdentity(moved.stat, expected) ||
        moved.record.nonce !== nonce
    ) {
        await restoreQuarantinedLock(path, quarantine);
        return;
    }
    await fs.unlink(quarantine);
}

async function reclaimExpiredLock(
    path: string,
    expected: ReadLock,
    reclaimerNonce: string,
    staleMilliseconds: number
): Promise<void> {
    const current = await readLock(path);
    if (
        !current ||
        !sameIdentity(current.stat, expected.stat) ||
        current.record.nonce !== expected.record.nonce ||
        !lockExpired(current, Date.now(), staleMilliseconds)
    )
        return;
    const quarantine = `${path}.stale-${reclaimerNonce}-${randomUUID()}`;
    await fs.rename(path, quarantine);
    const moved = await readLock(quarantine);
    if (
        !moved ||
        !sameIdentity(moved.stat, expected.stat) ||
        moved.record.nonce !== expected.record.nonce
    ) {
        await restoreQuarantinedLock(path, quarantine);
        throw new TypeError('Provider health lock changed during reclaim');
    }
    await fs.unlink(quarantine);
    await syncDirectory(join(path, '..'));
}

async function restoreQuarantinedLock(
    path: string,
    quarantine: string
): Promise<void> {
    try {
        await fs.link(quarantine, path);
        await fs.unlink(quarantine);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
}

async function removeDirectoryIfUnchanged(
    path: string,
    expected: Stats
): Promise<void> {
    await assertDirectoryIdentity(path, expected);
    const entries = await fs.readdir(path, { withFileTypes: true });
    for (const entry of entries) {
        if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            !/^events\.(?:current|\d{4})\.jsonl(?:\.corrupt-[A-Za-z0-9_-]+)?$/.test(
                entry.name
            )
        )
            throw new TypeError('Unsafe provider health history artifact');
        const child = join(path, entry.name);
        const stat = await regularFile(child, MAX_HISTORY_BYTES);
        if (!stat) throw new TypeError('Provider health history changed');
        await unlinkIfUnchanged(child, stat);
    }
    await assertDirectoryIdentity(path, expected);
    await fs.rmdir(path);
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function syncDirectory(path: string): Promise<void> {
    const handle = await fs.open(path, constants.O_RDONLY);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function safeString(value: unknown, maximum: number, pattern: RegExp): string {
    if (
        typeof value !== 'string' ||
        Buffer.byteLength(value) > maximum ||
        !pattern.test(value)
    )
        throw new TypeError('Invalid bounded string');
    return value;
}

function safeIso(value: unknown): string {
    if (
        typeof value !== 'string' ||
        value.length > 32 ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value
    )
        throw new TypeError('Invalid timestamp');
    return value;
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[]
): void {
    if (Object.keys(value).some((key) => !allowed.includes(key))) {
        throw new TypeError('Unexpected provider health field');
    }
}

function assertStrictEvent(value: unknown): void {
    if (!isRecord(value)) throw new TypeError('Invalid snapshot event');
    onlyKeys(value, [
        'schemaVersion',
        'checkId',
        'subject',
        'level',
        'outcome',
        'failureClass',
        'failureCode',
        'disabledReason',
        'durationMs',
        'checkedAt',
        'release'
    ]);
    if (!isRecord(value.subject) || !isRecord(value.release))
        throw new TypeError('Invalid snapshot event');
    onlyKeys(value.subject, [
        'id',
        'kind',
        'familyId',
        'upstreamId',
        'embedHostId'
    ]);
    onlyKeys(value.release, ['version', 'commit']);
}

function compareResults(a: HealthResult, b: HealthResult): number {
    return (
        a.subject.id.localeCompare(b.subject.id) ||
        CHECK_LEVELS.indexOf(a.level) - CHECK_LEVELS.indexOf(b.level)
    );
}

function resultKey(result: HealthResult): string {
    return `${result.subject.id}\0${result.level}`;
}

function noFollow(): number {
    return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}
