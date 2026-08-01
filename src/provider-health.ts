import type {
    BaseProvider,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import type { ProviderRegistry } from '@omss/framework';
import {
    evaluateHealthEligibility,
    parseHealthSwitchConfig,
    type HealthCatalogEntry,
    type HealthEligibility,
    type ProviderComponentEligibility
} from './health/health-control.js';
import {
    ProviderHealthRunner,
    type HealthCheck,
    type HealthResult,
    type ProviderHealthRunnerOptions
} from './health/provider-health.js';
import {
    ProviderHealthStore,
    type ProviderHealthPersistenceState
} from './health/provider-health-store.js';

export type ProviderHealthControl = {
    results: readonly HealthResult[];
    refresh: () => Promise<readonly HealthResult[]>;
    recheck: (canonicalFamilyId: string) => Promise<HealthResult>;
    eligibility: ProviderComponentEligibility;
    persistence: ProviderHealthPersistenceState;
};

const recheckSettlements = new WeakMap<Promise<HealthResult>, Promise<void>>();

export function providerRecheckSettlement(
    work: Promise<HealthResult>
): Promise<void> {
    return (
        recheckSettlements.get(work) ??
        work.then(
            () => undefined,
            () => undefined
        )
    );
}

const MOVIE_CANARY: Readonly<ProviderMediaObject> = Object.freeze({
    type: 'movie',
    tmdbId: '550',
    imdbId: 'tt0137523',
    releaseYear: '1999',
    title: 'Fight Club'
});
const TV_CANARY: Readonly<ProviderMediaObject> = Object.freeze({
    type: 'tv',
    tmdbId: '1399',
    imdbId: 'tt0944947',
    releaseYear: '2011',
    title: 'Game of Thrones',
    s: 1,
    e: 1
});

export async function installProviderHealthControl(
    registry: ProviderRegistry,
    entries: readonly HealthCatalogEntry[],
    env: NodeJS.ProcessEnv = process.env,
    runnerOptions: ProviderHealthRunnerOptions = {}
): Promise<ProviderHealthControl> {
    const switches = parseHealthSwitchConfig(entries, env);
    const store = env.CINEPRO_PROVIDER_HEALTH_DIR
        ? new ProviderHealthStore({
              directory: env.CINEPRO_PROVIDER_HEALTH_DIR
          })
        : undefined;
    if (store) await store.initialize();
    const runner = new ProviderHealthRunner({
        concurrency: numberEnv(env.CINEPRO_HEALTH_CONCURRENCY, 4),
        timeoutsMs: {
            lightweight: numberEnv(
                env.CINEPRO_HEALTH_LIGHTWEIGHT_TIMEOUT_MS,
                8_000
            ),
            resolver: numberEnv(env.CINEPRO_HEALTH_RESOLVER_TIMEOUT_MS, 20_000)
        },
        release: {
            version: env.npm_package_version ?? '1.0.0',
            commit: env.CINEPRO_RELEASE_COMMIT ?? 'unknown'
        },
        ...runnerOptions
    });
    const catalogByRuntimeId = new Map(
        entries
            .filter((entry) => entry.runtime?.runtimeId)
            .map((entry) => [entry.runtime!.runtimeId!, entry])
    );
    const eligibilityBySubject = new Map<string, HealthEligibility>();
    const providerByFamilyId = new Map<string, BaseProvider>();
    const checks: HealthCheck[] = [];

    for (const entry of entries) {
        const subject = catalogSubject(entry);
        if (!subject) continue;
        const eligibility = evaluateHealthEligibility(subject, entry, switches);
        eligibilityBySubject.set(subject.id, eligibility);
        if (subject.kind !== 'family') {
            checks.push({
                subject,
                level: subject.kind === 'leaf' ? 'resolver' : 'playback',
                ...(eligibility.enabled
                    ? {}
                    : { disabledReason: eligibility.disabledReason }),
                run: async () => ({
                    outcome: 'skipped',
                    failureCode: eligibility.enabled
                        ? 'HEALTH_CHECK_UNAVAILABLE'
                        : 'DISABLED'
                })
            });
        }
    }

    for (const provider of registry.getProviders()) {
        const entry = catalogByRuntimeId.get(provider.id);
        if (!entry) {
            throw new TypeError(
                `Registered provider "${provider.id}" has no catalog identity`
            );
        }
        const subject = catalogSubject(entry);
        if (!subject || subject.kind !== 'family') {
            throw new TypeError('Registered provider catalog kind is invalid');
        }
        const eligibility = eligibilityBySubject.get(subject.id)!;
        providerByFamilyId.set(subject.id, provider);
        if (!eligibility.enabled) {
            (provider as unknown as { enabled: boolean }).enabled = false;
        }
        if (!provider.enabled || !eligibility.enabled) {
            checks.push({
                subject,
                level: 'lightweight',
                disabledReason: eligibility.disabledReason ?? 'catalog',
                run: async () => ({
                    outcome: 'skipped',
                    failureCode: 'DISABLED'
                })
            });
        } else if (entry.runtime?.healthCheck) {
            checks.push(legacyProviderCheck(provider, subject));
        } else {
            checks.push({
                subject,
                level: 'lightweight',
                run: async () => ({
                    outcome: 'skipped',
                    failureCode: 'HEALTH_CHECK_UNAVAILABLE'
                })
            });
        }
    }

    let latest: readonly HealthResult[] = [];
    let inFlight: Promise<readonly HealthResult[]> | undefined;
    const rechecks = new Map<string, Promise<HealthResult>>();
    const resolverCapacity = numberEnv(env.CINEPRO_HEALTH_CONCURRENCY, 4);
    let activeResolvers = 0;
    const refresh = () => {
        if (!inFlight) {
            inFlight = runner
                .run(checks)
                .then((results) => {
                    latest = mergeLatestMany(latest, results);
                    return store
                        ? store.persist(results).then(() => latest)
                        : latest;
                })
                .finally(() => {
                    inFlight = undefined;
                });
        }
        return inFlight;
    };
    await refresh();

    const recheck = (canonicalFamilyId: string): Promise<HealthResult> => {
        const existing = rechecks.get(canonicalFamilyId);
        if (existing) return existing;
        const provider = providerByFamilyId.get(canonicalFamilyId);
        const eligibility = eligibilityBySubject.get(canonicalFamilyId);
        if (!provider || !eligibility) {
            return Promise.reject(
                new Error(
                    entries.some((entry) => entry.id === canonicalFamilyId)
                        ? 'UNSUPPORTED_SUBJECT'
                        : 'UNKNOWN_PROVIDER'
                )
            );
        }
        if (!provider.enabled || !eligibility.enabled) {
            return Promise.reject(new Error('PROVIDER_DISABLED'));
        }
        const capabilities = provider.capabilities?.supportedContentTypes;
        if (
            !Array.isArray(capabilities) ||
            !capabilities.includes('movies') ||
            !capabilities.includes('tv')
        ) {
            return Promise.reject(new Error('PROVIDER_UNSUPPORTED'));
        }
        if (activeResolvers >= resolverCapacity) {
            return Promise.reject(new Error('RECHECK_BUSY'));
        }
        activeResolvers++;
        const subject = {
            id: canonicalFamilyId,
            kind: 'family' as const,
            familyId: canonicalFamilyId
        };
        let releaseResolverLease!: () => void;
        const resolverSettled = new Promise<void>((resolve) => {
            releaseResolverLease = resolve;
        });
        const work = runner
            .run([
                {
                    subject,
                    level: 'resolver',
                    run: async () => {
                        const outcomes = await Promise.allSettled([
                            Promise.resolve().then(() =>
                                provider.getMovieSources(MOVIE_CANARY)
                            ),
                            Promise.resolve().then(() =>
                                provider.getTVSources(TV_CANARY)
                            )
                        ]).finally(releaseResolverLease);
                        if (
                            outcomes.some(
                                (outcome) => outcome.status === 'rejected'
                            )
                        ) {
                            return {
                                outcome: 'fail' as const,
                                failureClass: 'internal' as const,
                                failureCode: 'RESOLVER_FAILED'
                            };
                        }
                        if (
                            outcomes.some(
                                (outcome) =>
                                    outcome.status !== 'fulfilled' ||
                                    !hasSources(outcome.value)
                            )
                        ) {
                            return {
                                outcome: 'fail' as const,
                                failureClass: 'no_sources' as const,
                                failureCode: 'CANARY_NO_SOURCES'
                            };
                        }
                        return { outcome: 'pass' as const };
                    }
                }
            ])
            .then(async ([result]) => {
                latest = mergeLatest(latest, result);
                if (store) await store.persist([result]);
                return result;
            });
        rechecks.set(canonicalFamilyId, work);
        recheckSettlements.set(work, resolverSettled);
        void resolverSettled.then(() => {
            activeResolvers--;
            if (rechecks.get(canonicalFamilyId) === work) {
                rechecks.delete(canonicalFamilyId);
            }
        });
        return work;
    };

    // OMSS currently invokes this method without awaiting it from /v1/health.
    // Serve the completed snapshot so that request-time liveness never starts
    // provider I/O or creates an unhandled promise.
    registry.healthCheckAll = async () =>
        new Map(
            registry.getProviders().map((provider) => {
                const entry = catalogByRuntimeId.get(provider.id)!;
                const result = latest.find(
                    (candidate) =>
                        candidate.subject.kind === 'family' &&
                        candidate.subject.id === entry.id
                );
                return [provider.id, result?.outcome === 'pass'];
            })
        );

    return {
        get results() {
            return latest;
        },
        refresh,
        recheck,
        get persistence() {
            return (
                store?.state ?? {
                    enabled: false as const,
                    status: 'disabled' as const
                }
            );
        },
        eligibility: {
            subjects: eligibilityBySubject,
            get: (canonicalSubjectId) =>
                eligibilityBySubject.get(canonicalSubjectId),
            isEnabled: (canonicalSubjectId) =>
                eligibilityBySubject.get(canonicalSubjectId)?.enabled === true
        }
    };
}

function hasSources(result: ProviderResult): boolean {
    return (
        typeof result === 'object' &&
        result !== null &&
        Array.isArray(result.sources) &&
        result.sources.length > 0
    );
}

function mergeLatest(
    current: readonly HealthResult[],
    replacement: HealthResult
): readonly HealthResult[] {
    return [
        ...current.filter(
            (result) =>
                result.subject.id !== replacement.subject.id ||
                result.level !== replacement.level
        ),
        replacement
    ].sort(
        (a, b) =>
            a.subject.id.localeCompare(b.subject.id) ||
            CHECK_LEVEL_ORDER[a.level] - CHECK_LEVEL_ORDER[b.level]
    );
}

function mergeLatestMany(
    current: readonly HealthResult[],
    replacements: readonly HealthResult[]
): readonly HealthResult[] {
    return replacements.reduce<readonly HealthResult[]>(
        (merged, replacement) => mergeLatest(merged, replacement),
        current
    );
}

const CHECK_LEVEL_ORDER = {
    lightweight: 0,
    resolver: 1,
    playback: 2
} as const;

function catalogSubject(entry: HealthCatalogEntry) {
    if (entry.kind === 'upstream') {
        return {
            id: entry.id,
            kind: 'leaf' as const,
            familyId: entry.familyId ?? '',
            upstreamId: entry.id
        };
    }
    if (entry.kind === 'embed_host') {
        return {
            id: entry.id,
            kind: 'embed_host' as const,
            familyId: entry.familyId ?? entry.id,
            embedHostId: entry.id
        };
    }
    if (entry.runtime?.runtimeId) {
        return {
            id: entry.id,
            kind: 'family' as const,
            familyId: entry.familyId ?? entry.id
        };
    }
    return undefined;
}

function legacyProviderCheck(
    provider: BaseProvider,
    subject: { id: string; kind: 'family'; familyId: string }
): HealthCheck {
    return {
        subject,
        level: 'lightweight',
        run: async () => provider.healthCheck()
    };
}

function numberEnv(value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new TypeError(
            'Provider health numeric configuration must be an integer'
        );
    }
    return parsed;
}
