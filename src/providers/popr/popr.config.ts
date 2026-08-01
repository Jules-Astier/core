export const POPR_LEAVES = [
    {
        requestName: 'default',
        id: 'popr:default',
        displayName: 'Popr / Default'
    },
    {
        requestName: 'catflix',
        id: 'popr:catflix',
        displayName: 'Popr / CatFlix'
    },
    { requestName: 'hexa', id: 'popr:hexa', displayName: 'Popr / Hexa' },
    { requestName: 'Gama', id: 'popr:gama', displayName: 'Popr / Gama' },
    {
        requestName: 'Liligoon',
        id: 'popr:liligoon',
        displayName: 'Popr / Liligoon'
    },
    { requestName: 'Sigma', id: 'popr:sigma', displayName: 'Popr / Sigma' },
    { requestName: 'Prime', id: 'popr:prime', displayName: 'Popr / Prime' },
    { requestName: 'Alfa', id: 'popr:alfa', displayName: 'Popr / Alfa' },
    { requestName: 'Lamda', id: 'popr:lamda', displayName: 'Popr / Lamda' },
    {
        requestName: 'ynx_vidsrc',
        id: 'popr:ynx-vidsrc',
        displayName: 'Popr / YNX VidSrc'
    }
] as const;

export type PoprLeaf = (typeof POPR_LEAVES)[number];
export type PoprLeafId = PoprLeaf['id'];

export type PoprLeafPolicy = Readonly<{
    enabled: (leaf: PoprLeaf) => boolean;
}>;

export const POPR_ALLOW_ENV = 'POPR_LEAF_ALLOWLIST';
export const POPR_DENY_ENV = 'POPR_LEAF_DENYLIST';

type Environment = Readonly<Record<string, string | undefined>>;

const IDS = new Set<string>(POPR_LEAVES.map(({ id }) => id));
const ALIASES = new Map<string, PoprLeafId>();

for (const leaf of POPR_LEAVES) {
    ALIASES.set(leaf.id.toLowerCase(), leaf.id);
    ALIASES.set(leaf.requestName.toLowerCase(), leaf.id);
}
ALIASES.set('ynx-vidsrc', 'popr:ynx-vidsrc');

export function createPoprLeafPolicy(env: Environment): PoprLeafPolicy {
    const allow = readList(POPR_ALLOW_ENV, env[POPR_ALLOW_ENV]);
    const globalAllow = globalLeafSwitch(env, 'popr', 'allow');
    const deny =
        readList(POPR_DENY_ENV, env[POPR_DENY_ENV]) ?? new Set<PoprLeafId>();
    const globalDeny = globalLeafSwitch(env, 'popr', 'deny');

    return Object.freeze({
        enabled: (leaf: PoprLeaf) =>
            allowedByBoth(
                leaf.id,
                allow,
                globalAllow === undefined
                    ? undefined
                    : new Set(
                          [...globalAllow].map((suffix) => `popr:${suffix}`)
                      )
            ) &&
            !deny.has(leaf.id) &&
            !globalDeny?.has(leaf.id.slice('popr:'.length))
    });
}

function readList(
    name: string,
    value: string | undefined
): Set<PoprLeafId> | undefined {
    if (value === undefined || value.trim() === '') {
        return name.endsWith('ALLOWLIST') ? undefined : new Set<PoprLeafId>();
    }

    const ids = new Set<PoprLeafId>();
    for (const token of value.split(',').map((part) => part.trim())) {
        const id = ALIASES.get(token.toLowerCase());
        if (!id || !IDS.has(id)) {
            throw new TypeError(`${name} contains an unknown Popr leaf`);
        }
        if (ids.has(id)) {
            throw new TypeError(`${name} contains a duplicate Popr leaf`);
        }
        ids.add(id);
    }
    return ids;
}

// Validate deployment configuration at module startup. Empty/unset lists preserve
// the legacy behavior of querying every leaf.
export const POPR_LEAF_POLICY = createPoprLeafPolicy(process.env);
import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';
