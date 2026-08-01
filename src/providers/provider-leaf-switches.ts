export const GLOBAL_LEAF_ALLOW_ENV = 'CINEPRO_PROVIDER_LEAF_ALLOWLIST';
export const GLOBAL_LEAF_DENY_ENV = 'CINEPRO_PROVIDER_LEAF_DENYLIST';

const CANONICAL_LEAF_ID =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Returns the canonical leaf suffixes selected for one provider family.
 * An absent global allowlist returns undefined; a present allowlist with no
 * entries for this family returns an empty set and therefore disables its
 * leaves. Unknown-but-canonical identities are validated centrally against
 * the provider catalog by PE-009.
 */
export function globalLeafSwitch(
    environment: Environment,
    familyId: string,
    kind: 'allow' | 'deny'
): ReadonlySet<string> | undefined {
    const variableName =
        kind === 'allow' ? GLOBAL_LEAF_ALLOW_ENV : GLOBAL_LEAF_DENY_ENV;
    const raw = environment[variableName];
    if (raw === undefined || raw.trim() === '') {
        return kind === 'allow' ? undefined : new Set();
    }

    const identities = raw
        .split(',')
        .map((value) => value.trim().toLowerCase());
    if (
        identities.some((identity) => !CANONICAL_LEAF_ID.test(identity)) ||
        new Set(identities).size !== identities.length
    ) {
        throw new TypeError(
            `${variableName} contains invalid or duplicate canonical identities`
        );
    }

    const prefix = `${familyId}:`;
    return new Set(
        identities
            .filter((identity) => identity.startsWith(prefix))
            .map((identity) => identity.slice(prefix.length))
    );
}

export function allowedByBoth(
    leaf: string,
    localAllow: ReadonlySet<string> | undefined,
    globalAllow: ReadonlySet<string> | undefined
): boolean {
    return (
        (localAllow === undefined || localAllow.has(leaf)) &&
        (globalAllow === undefined || globalAllow.has(leaf))
    );
}
