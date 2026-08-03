import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';
import {
    VIDKING_FAMILY_ID,
    VIDKING_LEAVES,
    type VidKingLeaf
} from './vidking.identity.js';

export const VIDKING_ALLOW_ENV = 'VIDKING_LEAF_ALLOWLIST';
export const VIDKING_DENY_ENV = 'VIDKING_LEAF_DENYLIST';

export type VidKingLeafPolicy = Readonly<{
    enabledLeaves: ReadonlySet<VidKingLeaf>;
}>;

function parseList(
    value: string | undefined,
    variableName: string
): Set<VidKingLeaf> | undefined {
    if (value === undefined || value.trim() === '') return undefined;

    const leaves = new Set<VidKingLeaf>();
    for (const rawEntry of value.split(',')) {
        const entry = rawEntry.trim().toLowerCase();
        const leaf = entry.startsWith(`${VIDKING_FAMILY_ID}:`)
            ? entry.slice(VIDKING_FAMILY_ID.length + 1)
            : entry;
        if (!(VIDKING_LEAVES as readonly string[]).includes(leaf)) {
            throw new TypeError(
                `${variableName} contains an unknown VidKing leaf`
            );
        }
        leaves.add(leaf as VidKingLeaf);
    }
    return leaves;
}

export function createVidKingLeafPolicy(
    environment: Readonly<Record<string, string | undefined>>
): VidKingLeafPolicy {
    const allow = parseList(environment[VIDKING_ALLOW_ENV], VIDKING_ALLOW_ENV);
    const deny =
        parseList(environment[VIDKING_DENY_ENV], VIDKING_DENY_ENV) ?? new Set();
    const globalAllow = globalLeafSwitch(
        environment,
        VIDKING_FAMILY_ID,
        'allow'
    );
    const globalDeny = globalLeafSwitch(
        environment,
        VIDKING_FAMILY_ID,
        'deny'
    );
    const enabledLeaves = new Set<VidKingLeaf>(
        VIDKING_LEAVES.filter((leaf) =>
            allowedByBoth(leaf, allow, globalAllow)
        )
    );
    for (const leaf of deny) enabledLeaves.delete(leaf);
    for (const leaf of globalDeny ?? []) {
        enabledLeaves.delete(leaf as VidKingLeaf);
    }
    return Object.freeze({ enabledLeaves });
}

// Yoru and Breach each completed at least one manifest/segment gate. Other
// implemented leaves stay opt-in until they independently pass one.
export const VIDKING_LEAF_POLICY = createVidKingLeafPolicy({
    ...process.env,
    [VIDKING_ALLOW_ENV]: process.env[VIDKING_ALLOW_ENV] ?? 'yoru,breach'
});
