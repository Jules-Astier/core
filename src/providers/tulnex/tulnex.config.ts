import {
    TULNEX_FAMILY_ID,
    TULNEX_LEAVES,
    type TulnexLeaf
} from './tulnex.identity.js';
import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';

export const TULNEX_ALLOW_ENV = 'TULNEX_LEAF_ALLOWLIST';
export const TULNEX_DENY_ENV = 'TULNEX_LEAF_DENYLIST';

export type TulnexLeafPolicy = Readonly<{
    enabledLeaves: ReadonlySet<TulnexLeaf>;
}>;

function parseList(
    value: string | undefined,
    variableName: string
): Set<TulnexLeaf> | undefined {
    if (value === undefined || value.trim() === '') return undefined;

    const leaves = new Set<TulnexLeaf>();
    for (const rawEntry of value.split(',')) {
        const entry = rawEntry.trim().toLowerCase();
        const leaf = entry.startsWith(`${TULNEX_FAMILY_ID}:`)
            ? entry.slice(TULNEX_FAMILY_ID.length + 1)
            : entry;
        if (!(TULNEX_LEAVES as readonly string[]).includes(leaf)) {
            // Do not echo the configuration value: deployment inputs can contain
            // secrets accidentally and startup errors must remain safe to log.
            throw new TypeError(
                `${variableName} contains an unknown Tulnex leaf`
            );
        }
        leaves.add(leaf as TulnexLeaf);
    }
    return leaves;
}

export function createTulnexLeafPolicy(
    environment: Readonly<Record<string, string | undefined>>
): TulnexLeafPolicy {
    const allow = parseList(environment[TULNEX_ALLOW_ENV], TULNEX_ALLOW_ENV);
    const globalAllow = globalLeafSwitch(
        environment,
        TULNEX_FAMILY_ID,
        'allow'
    );
    const deny =
        parseList(environment[TULNEX_DENY_ENV], TULNEX_DENY_ENV) ?? new Set();
    const globalDeny = globalLeafSwitch(environment, TULNEX_FAMILY_ID, 'deny');
    const enabledLeaves = new Set<TulnexLeaf>(
        (TULNEX_LEAVES as readonly TulnexLeaf[]).filter((leaf) =>
            allowedByBoth(leaf, allow, globalAllow)
        )
    );
    for (const leaf of deny) enabledLeaves.delete(leaf);
    for (const leaf of globalDeny ?? []) {
        enabledLeaves.delete(leaf as TulnexLeaf);
    }
    return Object.freeze({ enabledLeaves });
}

// Validate deployment configuration during module startup. The default preserves
// the legacy behavior in which every Tulnex leaf is enabled.
export const TULNEX_LEAF_POLICY = createTulnexLeafPolicy(process.env);
