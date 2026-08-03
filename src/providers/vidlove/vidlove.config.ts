import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';
import {
    VIDLOVE_FAMILY_ID,
    VIDLOVE_LEAVES,
    type VidLoveLeaf
} from './vidlove.identity.js';

export const VIDLOVE_ALLOW_ENV = 'VIDLOVE_LEAF_ALLOWLIST';
export const VIDLOVE_DENY_ENV = 'VIDLOVE_LEAF_DENYLIST';

export type VidLoveLeafPolicy = Readonly<{
    enabledLeaves: ReadonlySet<VidLoveLeaf>;
}>;

function parseList(
    value: string | undefined,
    variableName: string
): Set<VidLoveLeaf> | undefined {
    if (value === undefined || value.trim() === '') return undefined;

    const leaves = new Set<VidLoveLeaf>();
    for (const rawEntry of value.split(',')) {
        const entry = rawEntry.trim().toLowerCase();
        const leaf = entry.startsWith(`${VIDLOVE_FAMILY_ID}:`)
            ? entry.slice(VIDLOVE_FAMILY_ID.length + 1)
            : entry;
        if (!(VIDLOVE_LEAVES as readonly string[]).includes(leaf)) {
            throw new TypeError(
                `${variableName} contains an unknown VidLove leaf`
            );
        }
        leaves.add(leaf as VidLoveLeaf);
    }
    return leaves;
}

export function createVidLoveLeafPolicy(
    environment: Readonly<Record<string, string | undefined>>
): VidLoveLeafPolicy {
    const allow = parseList(environment[VIDLOVE_ALLOW_ENV], VIDLOVE_ALLOW_ENV);
    const deny =
        parseList(environment[VIDLOVE_DENY_ENV], VIDLOVE_DENY_ENV) ?? new Set();
    const globalAllow = globalLeafSwitch(
        environment,
        VIDLOVE_FAMILY_ID,
        'allow'
    );
    const globalDeny = globalLeafSwitch(
        environment,
        VIDLOVE_FAMILY_ID,
        'deny'
    );
    const enabledLeaves = new Set<VidLoveLeaf>(
        VIDLOVE_LEAVES.filter((leaf) =>
            allowedByBoth(leaf, allow, globalAllow)
        )
    );
    for (const leaf of deny) enabledLeaves.delete(leaf);
    for (const leaf of globalDeny ?? []) {
        enabledLeaves.delete(leaf as VidLoveLeaf);
    }
    return Object.freeze({ enabledLeaves });
}

// IPCloud has completed a live manifest/child-playlist gate. The remaining
// implemented leaves stay opt-in until a known-working title is observed.
export const VIDLOVE_LEAF_POLICY = createVidLoveLeafPolicy({
    ...process.env,
    [VIDLOVE_ALLOW_ENV]:
        process.env[VIDLOVE_ALLOW_ENV]?.trim() || 'ipcloud'
});
