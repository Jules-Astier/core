import { randomUUID } from 'node:crypto';

export const CHECK_LEVELS = ['lightweight', 'resolver', 'playback'] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];

export const FAILURE_CLASSES = [
    'dns',
    'tls',
    'redirect_drift',
    'http_4xx',
    'http_5xx',
    'rate_limited',
    'anti_bot',
    'auth_required',
    'geo_blocked',
    'drm',
    'parse',
    'not_found',
    'no_sources',
    'proxy',
    'manifest',
    'segment',
    'embed_frame',
    'codec',
    'timeout',
    'internal'
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type HealthSubject =
    | { id: string; kind: 'family'; familyId: string }
    | {
          id: string;
          kind: 'leaf';
          familyId: string;
          upstreamId: string;
      }
    | {
          id: string;
          kind: 'embed_host';
          familyId: string;
          embedHostId: string;
      };

export type HealthResult = {
    schemaVersion: 1;
    checkId: string;
    subject: HealthSubject;
    level: CheckLevel;
    outcome: 'pass' | 'fail' | 'skipped';
    failureClass?: FailureClass;
    failureCode?: string;
    disabledReason?:
        | 'catalog'
        | 'family_deny'
        | 'family_not_allowed'
        | 'leaf_deny'
        | 'leaf_not_allowed'
        | 'host_deny'
        | 'host_not_allowed';
    durationMs: number;
    checkedAt: string;
    release: { version: string; commit: string };
};

export type HealthProbeResult =
    | boolean
    | { outcome: 'pass' }
    | {
          outcome: 'fail';
          failureClass: FailureClass;
          failureCode: string;
      }
    | { outcome: 'skipped'; failureCode: string };

export type HealthCheck = {
    subject: HealthSubject;
    level: CheckLevel;
    disabledReason?: HealthResult['disabledReason'];
    run: (signal: AbortSignal) => Promise<HealthProbeResult>;
};

export class ProviderHealthFailure extends Error {
    constructor(
        readonly failureClass: FailureClass,
        readonly failureCode: string
    ) {
        super('Provider health check failed');
        this.name = 'ProviderHealthFailure';
    }
}

export class ProviderHealthHttpFailure extends Error {
    constructor(readonly status: number) {
        super('Provider health HTTP check failed');
        this.name = 'ProviderHealthHttpFailure';
    }
}

export function classifyProviderHealthError(error: unknown): {
    outcome: 'fail';
    failureClass: FailureClass;
    failureCode: string;
} {
    if (error instanceof ProviderHealthFailure) {
        return {
            outcome: 'fail',
            failureClass: error.failureClass,
            failureCode: normalizeFailureCode(error.failureCode)
        };
    }
    if (error instanceof ProviderHealthHttpFailure) {
        if (error.status === 401 || error.status === 407) {
            return {
                outcome: 'fail',
                failureClass: 'auth_required',
                failureCode: `HTTP_${error.status}`
            };
        }
        if (error.status === 404 || error.status === 410) {
            return {
                outcome: 'fail',
                failureClass: 'not_found',
                failureCode: `HTTP_${error.status}`
            };
        }
        if (error.status === 429) {
            return {
                outcome: 'fail',
                failureClass: 'rate_limited',
                failureCode: 'HTTP_429'
            };
        }
        if (error.status >= 400 && error.status < 500) {
            return {
                outcome: 'fail',
                failureClass: 'http_4xx',
                failureCode: 'HTTP_4XX'
            };
        }
        if (error.status >= 500 && error.status < 600) {
            return {
                outcome: 'fail',
                failureClass: 'http_5xx',
                failureCode: 'HTTP_5XX'
            };
        }
    }
    return {
        outcome: 'fail',
        failureClass: 'internal',
        failureCode: 'UNCLASSIFIED'
    };
}

export type ProviderHealthRunnerOptions = {
    concurrency?: number;
    timeoutsMs?: Partial<Record<CheckLevel, number>>;
    release?: { version: string; commit: string };
    now?: () => number;
    createCheckId?: () => string;
    cleanupGraceMs?: number;
};

const DEFAULT_TIMEOUTS: Record<CheckLevel, number> = {
    lightweight: 8_000,
    resolver: 20_000,
    playback: 30_000
};

export class ProviderHealthRunner {
    private readonly concurrency: number;
    private readonly timeoutsMs: Record<CheckLevel, number>;
    private readonly release: { version: string; commit: string };
    private readonly now: () => number;
    private readonly createCheckId: () => string;
    private readonly cleanupGraceMs: number;

    constructor(options: ProviderHealthRunnerOptions = {}) {
        this.concurrency = boundedInteger(
            options.concurrency ?? 4,
            1,
            16,
            'health concurrency'
        );
        this.timeoutsMs = {
            lightweight: boundedInteger(
                options.timeoutsMs?.lightweight ?? DEFAULT_TIMEOUTS.lightweight,
                1_000,
                60_000,
                'lightweight timeout'
            ),
            resolver: boundedInteger(
                options.timeoutsMs?.resolver ?? DEFAULT_TIMEOUTS.resolver,
                1_000,
                60_000,
                'resolver timeout'
            ),
            playback: boundedInteger(
                options.timeoutsMs?.playback ?? DEFAULT_TIMEOUTS.playback,
                1_000,
                60_000,
                'playback timeout'
            )
        };
        this.release = sanitizeRelease(options.release);
        this.now = options.now ?? Date.now;
        this.createCheckId = options.createCheckId ?? randomUUID;
        this.cleanupGraceMs = boundedInteger(
            options.cleanupGraceMs ?? 100,
            0,
            5_000,
            'health cleanup grace'
        );
    }

    async run(checks: readonly HealthCheck[]): Promise<HealthResult[]> {
        const ordered = [...checks].sort(compareChecks);
        const results = new Array<HealthResult>(ordered.length);
        const allocations = ordered.map(() => ({
            checkId: normalizeCheckId(this.createCheckId()),
            startedAt: this.now()
        }));
        let nextIndex = 0;

        const worker = async () => {
            while (nextIndex < ordered.length) {
                const index = nextIndex++;
                const completed = await this.runOne(
                    ordered[index],
                    allocations[index]
                );
                results[index] = completed.result;
                if (!completed.slotReusable) return;
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(this.concurrency, ordered.length) },
                worker
            )
        );
        while (nextIndex < ordered.length) {
            const index = nextIndex++;
            results[index] = this.skippedWithoutRunning(
                ordered[index],
                allocations[index],
                'CONCURRENCY_QUARANTINED'
            );
        }
        return results;
    }

    private async runOne(
        check: HealthCheck,
        allocation: { checkId: string; startedAt: number }
    ): Promise<{ result: HealthResult; slotReusable: boolean }> {
        assertSubject(check.subject);
        if (!CHECK_LEVELS.includes(check.level)) {
            throw new TypeError('Unknown provider health check level');
        }

        const { checkId, startedAt } = allocation;
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        let timedOut = false;
        let probeSettled = false;
        const probePromise = Promise.resolve()
            .then(() => check.run(controller.signal))
            .finally(() => {
                probeSettled = true;
            });
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(new ProviderHealthFailure('timeout', 'DEADLINE'));
            }, this.timeoutsMs[check.level]);
        });

        let probe: HealthProbeResult;
        try {
            probe = await Promise.race([probePromise, timeout]);
        } catch (error) {
            probe = classifyProviderHealthError(error);
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (timedOut && !probeSettled && this.cleanupGraceMs > 0) {
            await Promise.race([
                probePromise.catch(() => undefined),
                new Promise((resolve) =>
                    setTimeout(resolve, this.cleanupGraceMs)
                )
            ]);
        }

        const normalized = normalizeProbeResult(probe);
        return {
            slotReusable: !timedOut || probeSettled,
            result: {
                schemaVersion: 1,
                checkId,
                subject: check.subject,
                level: check.level,
                outcome: normalized.outcome,
                ...(normalized.outcome === 'fail'
                    ? {
                          failureClass: normalized.failureClass,
                          failureCode: normalized.failureCode
                      }
                    : normalized.outcome === 'skipped'
                      ? { failureCode: normalized.failureCode }
                      : {}),
                ...(check.disabledReason
                    ? { disabledReason: check.disabledReason }
                    : {}),
                durationMs: Math.max(0, Math.round(this.now() - startedAt)),
                checkedAt: new Date(startedAt).toISOString(),
                release: this.release
            }
        };
    }

    private skippedWithoutRunning(
        check: HealthCheck,
        allocation: { checkId: string; startedAt: number },
        failureCode: string
    ): HealthResult {
        assertSubject(check.subject);
        return {
            schemaVersion: 1,
            checkId: allocation.checkId,
            subject: check.subject,
            level: check.level,
            outcome: 'skipped',
            failureCode,
            durationMs: 0,
            checkedAt: new Date(allocation.startedAt).toISOString(),
            release: this.release
        };
    }
}

function normalizeProbeResult(
    probe: HealthProbeResult
): Exclude<HealthProbeResult, boolean> {
    if (probe === true) return { outcome: 'pass' };
    if (probe === false) {
        return {
            outcome: 'fail',
            failureClass: 'internal',
            failureCode: 'HEALTH_FALSE'
        };
    }
    if (probe.outcome === 'fail') {
        if (!FAILURE_CLASSES.includes(probe.failureClass)) {
            return {
                outcome: 'fail',
                failureClass: 'internal',
                failureCode: 'UNCLASSIFIED'
            };
        }
        return {
            ...probe,
            failureCode: normalizeFailureCode(probe.failureCode)
        };
    }
    if (probe.outcome === 'skipped') {
        return {
            ...probe,
            failureCode: normalizeFailureCode(probe.failureCode)
        };
    }
    return probe;
}

function normalizeFailureCode(value: string): string {
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'UNCLASSIFIED';
}

function compareChecks(a: HealthCheck, b: HealthCheck): number {
    return (
        a.subject.id.localeCompare(b.subject.id) ||
        CHECK_LEVELS.indexOf(a.level) - CHECK_LEVELS.indexOf(b.level)
    );
}

function assertSubject(subject: HealthSubject): void {
    const component = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const provider = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
    if (!provider.test(subject.id) || !component.test(subject.familyId)) {
        throw new TypeError('Health subject identity must be canonical');
    }
    if (subject.kind === 'family' && subject.id !== subject.familyId) {
        throw new TypeError('Family health subject identity is inconsistent');
    }
    if (
        subject.kind === 'leaf' &&
        (subject.id !== subject.upstreamId ||
            !subject.id.startsWith(`${subject.familyId}:`))
    ) {
        throw new TypeError('Leaf health subject identity is inconsistent');
    }
    if (
        subject.kind === 'embed_host' &&
        (subject.id !== subject.embedHostId ||
            !component.test(subject.embedHostId))
    ) {
        throw new TypeError(
            'Embed-host health subject identity is inconsistent'
        );
    }
}

function boundedInteger(
    value: number,
    minimum: number,
    maximum: number,
    label: string
): number {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(
            `${label} must be an integer from ${minimum} to ${maximum}`
        );
    }
    return value;
}

function sanitizeRelease(release: ProviderHealthRunnerOptions['release']): {
    version: string;
    commit: string;
} {
    return {
        version: sanitizeReleasePart(release?.version),
        commit: sanitizeReleasePart(release?.commit)
    };
}

function sanitizeReleasePart(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)) {
        return 'unknown';
    }
    return value;
}

function normalizeCheckId(value: string): string {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
        ? value
        : 'invalid-check-id';
}
