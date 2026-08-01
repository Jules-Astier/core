export const PEACHIFY_FAMILY_ID = 'peachify';

export const PEACHIFY_LEAVES = [
    {
        name: 'moviebox',
        id: 'peachify:moviebox',
        baseUrl: 'https://uwu.eat-peach.sbs/moviebox'
    },
    {
        name: 'holly',
        id: 'peachify:holly',
        baseUrl: 'https://usa.eat-peach.sbs/holly'
    },
    {
        name: 'air',
        id: 'peachify:air',
        baseUrl: 'https://usa.eat-peach.sbs/air'
    },
    {
        name: 'multi',
        id: 'peachify:multi',
        baseUrl: 'https://usa.eat-peach.sbs/multi'
    },
    {
        name: 'net',
        id: 'peachify:net',
        baseUrl: 'https://uwu.eat-peach.sbs/net'
    },
    {
        name: 'bmb',
        id: 'peachify:bmb',
        baseUrl: 'https://uwu.eat-peach.sbs/bmb'
    }
] as const;

export type PeachifyLeaf = (typeof PEACHIFY_LEAVES)[number];
export const PEACHIFY_ALLOW_ENV = 'PEACHIFY_LEAF_ALLOWLIST';
export const PEACHIFY_DENY_ENV = 'PEACHIFY_LEAF_DENYLIST';
export type PeachifyLeafEnvironment = Readonly<
    Partial<
        Record<typeof PEACHIFY_ALLOW_ENV | typeof PEACHIFY_DENY_ENV, string>
    >
>;

export function resolvePeachifyLeaves(
    environment: PeachifyLeafEnvironment = process.env
): readonly PeachifyLeaf[] {
    const allow = parseLeafList(
        PEACHIFY_ALLOW_ENV,
        environment[PEACHIFY_ALLOW_ENV]
    );
    const deny = parseLeafList(
        PEACHIFY_DENY_ENV,
        environment[PEACHIFY_DENY_ENV]
    );
    const globalAllow = globalLeafSwitch(
        environment,
        PEACHIFY_FAMILY_ID,
        'allow'
    );
    const globalDeny = globalLeafSwitch(
        environment,
        PEACHIFY_FAMILY_ID,
        'deny'
    );
    return Object.freeze(
        PEACHIFY_LEAVES.filter(
            ({ name }) =>
                allowedByBoth(name, allow, globalAllow) &&
                !deny?.has(name) &&
                !globalDeny?.has(name)
        )
    );
}

function parseLeafList(
    variableName: string,
    raw: string | undefined
): ReadonlySet<string> | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const leaves = new Set<string>();
    for (const token of raw.split(',')) {
        const normalized = token.trim().toLowerCase();
        const leaf = normalized.startsWith(`${PEACHIFY_FAMILY_ID}:`)
            ? normalized.slice(PEACHIFY_FAMILY_ID.length + 1)
            : normalized;
        if (!PEACHIFY_LEAVES.some(({ name }) => name === leaf)) {
            throw new TypeError(
                `${variableName} contains an unknown Peachify leaf`
            );
        }
        if (leaves.has(leaf)) {
            throw new TypeError(
                `${variableName} contains a duplicate Peachify leaf`
            );
        }
        leaves.add(leaf);
    }
    return leaves;
}

// Validate configuration at module startup. Unset lists retain legacy fan-out.
export const PEACHIFY_ENABLED_LEAVES = resolvePeachifyLeaves(process.env);
import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';
