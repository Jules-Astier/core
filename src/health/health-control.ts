import type { HealthSubject } from './provider-health.js';

export type HealthCatalogEntry = {
    id: string;
    kind: string;
    familyId?: string;
    status?: string;
    runtime?: {
        runtimeId?: string | null;
        enabledDefault?: boolean | string;
        healthCheck?: boolean;
    };
};

export type HealthSwitchConfig = {
    familyAllow: ReadonlySet<string>;
    familyDeny: ReadonlySet<string>;
    leafAllow: ReadonlySet<string>;
    leafDeny: ReadonlySet<string>;
    hostAllow: ReadonlySet<string>;
    hostDeny: ReadonlySet<string>;
};

export type HealthEligibility = {
    enabled: boolean;
    disabledReason?:
        | 'catalog'
        | 'family_deny'
        | 'family_not_allowed'
        | 'leaf_deny'
        | 'leaf_not_allowed'
        | 'host_deny'
        | 'host_not_allowed';
};

export type ProviderComponentEligibility = {
    subjects: ReadonlyMap<string, HealthEligibility>;
    get: (canonicalSubjectId: string) => HealthEligibility | undefined;
    isEnabled: (canonicalSubjectId: string) => boolean;
};

const ENV_KEYS = {
    familyAllow: 'CINEPRO_PROVIDER_FAMILY_ALLOWLIST',
    familyDeny: 'CINEPRO_PROVIDER_FAMILY_DENYLIST',
    leafAllow: 'CINEPRO_PROVIDER_LEAF_ALLOWLIST',
    leafDeny: 'CINEPRO_PROVIDER_LEAF_DENYLIST',
    hostAllow: 'CINEPRO_PROVIDER_HOST_ALLOWLIST',
    hostDeny: 'CINEPRO_PROVIDER_HOST_DENYLIST'
} as const;

export function parseHealthSwitchConfig(
    entries: readonly HealthCatalogEntry[],
    env: NodeJS.ProcessEnv
): HealthSwitchConfig {
    const byKind = {
        family: new Set(
            entries
                .filter(
                    (entry) =>
                        !entry.id.includes(':') && entry.kind !== 'embed_host'
                )
                .map((entry) => entry.id)
        ),
        leaf: new Set(
            entries
                .filter((entry) => entry.kind === 'upstream')
                .map((entry) => entry.id)
        ),
        host: new Set(
            entries
                .filter((entry) => entry.kind === 'embed_host')
                .map((entry) => entry.id)
        )
    };
    return {
        familyAllow: parseList(
            env[ENV_KEYS.familyAllow],
            byKind.family,
            ENV_KEYS.familyAllow
        ),
        familyDeny: parseList(
            env[ENV_KEYS.familyDeny],
            byKind.family,
            ENV_KEYS.familyDeny
        ),
        leafAllow: parseList(
            env[ENV_KEYS.leafAllow],
            byKind.leaf,
            ENV_KEYS.leafAllow
        ),
        leafDeny: parseList(
            env[ENV_KEYS.leafDeny],
            byKind.leaf,
            ENV_KEYS.leafDeny
        ),
        hostAllow: parseList(
            env[ENV_KEYS.hostAllow],
            byKind.host,
            ENV_KEYS.hostAllow
        ),
        hostDeny: parseList(
            env[ENV_KEYS.hostDeny],
            byKind.host,
            ENV_KEYS.hostDeny
        )
    };
}

export function evaluateHealthEligibility(
    subject: HealthSubject,
    entry: HealthCatalogEntry,
    switches: HealthSwitchConfig
): HealthEligibility {
    if (
        ['disabled', 'deferred', 'rejected', 'retired'].includes(
            entry.status ?? 'discovered'
        ) ||
        entry.runtime?.enabledDefault === false
    ) {
        return { enabled: false, disabledReason: 'catalog' };
    }
    if (switches.familyDeny.has(subject.familyId)) {
        return { enabled: false, disabledReason: 'family_deny' };
    }
    if (
        switches.familyAllow.size > 0 &&
        !switches.familyAllow.has(subject.familyId)
    ) {
        return { enabled: false, disabledReason: 'family_not_allowed' };
    }
    if (subject.kind === 'leaf') {
        if (switches.leafDeny.has(subject.id)) {
            return { enabled: false, disabledReason: 'leaf_deny' };
        }
        if (
            switches.leafAllow.size > 0 &&
            !switches.leafAllow.has(subject.id)
        ) {
            return { enabled: false, disabledReason: 'leaf_not_allowed' };
        }
    }
    if (subject.kind === 'embed_host') {
        if (switches.hostDeny.has(subject.id)) {
            return { enabled: false, disabledReason: 'host_deny' };
        }
        if (
            switches.hostAllow.size > 0 &&
            !switches.hostAllow.has(subject.id)
        ) {
            return { enabled: false, disabledReason: 'host_not_allowed' };
        }
    }
    return { enabled: true };
}

function parseList(
    raw: string | undefined,
    known: ReadonlySet<string>,
    name: string
): ReadonlySet<string> {
    if (!raw?.trim()) return new Set();
    const values = raw.split(',').map((value) => value.trim());
    if (values.some((value) => !value)) {
        throw new TypeError(`${name} contains an empty identity`);
    }
    const unique = new Set(values);
    if (unique.size !== values.length) {
        throw new TypeError(`${name} contains a duplicate identity`);
    }
    for (const value of unique) {
        if (!known.has(value)) {
            throw new TypeError(
                `${name} contains an unknown or noncanonical identity`
            );
        }
    }
    return unique;
}
