export const VIDNEST_FAMILY_ID = 'vidnest';

export const VIDNEST_REQUESTED_SERVERS = [
    'moviebox',
    'allmovies',
    'catflix',
    'purstream',
    'hollymoviehd',
    'lamda',
    'flixhq',
    'vidlink',
    'onehd',
    'klikxxi'
] as const;

export const VIDNEST_ELIGIBLE_LEAVES = [
    'moviebox',
    'allmovies',
    'purstream',
    'hollymoviehd',
    'vidlink',
    'onehd',
    'klikxxi'
] as const;

export const VIDNEST_MISSING_HANDLERS = [
    { name: 'catflix', status: 'seed-needed', enabled: false },
    { name: 'lamda', status: 'seed-needed', enabled: false },
    { name: 'flixhq', status: 'seed-needed', enabled: false }
] as const;

export const VIDNEST_DISABLED_LEAVES = [
    { name: 'delta', status: 'disabled', enabled: false }
] as const;

export const VIDNEST_ALLOW_ENV = 'VIDNEST_LEAF_ALLOWLIST';
export const VIDNEST_DENY_ENV = 'VIDNEST_LEAF_DENYLIST';

export type VidnestLeaf = (typeof VIDNEST_ELIGIBLE_LEAVES)[number];
export type VidnestLeafEnvironment = Readonly<
    Partial<Record<typeof VIDNEST_ALLOW_ENV | typeof VIDNEST_DENY_ENV, string>>
>;

export type VidnestLeafPolicy = Readonly<{
    enabled: (leaf: VidnestLeaf) => boolean;
}>;

const ELIGIBLE = new Set<string>(VIDNEST_ELIGIBLE_LEAVES);
const INELIGIBLE = new Set<string>([
    ...VIDNEST_MISSING_HANDLERS.map(({ name }) => name),
    ...VIDNEST_DISABLED_LEAVES.map(({ name }) => name)
]);

export function createVidnestLeafPolicy(
    environment: VidnestLeafEnvironment
): VidnestLeafPolicy {
    const allow = parseList(VIDNEST_ALLOW_ENV, environment[VIDNEST_ALLOW_ENV]);
    const globalAllow = globalLeafSwitch(
        environment,
        VIDNEST_FAMILY_ID,
        'allow'
    );
    const deny =
        parseList(VIDNEST_DENY_ENV, environment[VIDNEST_DENY_ENV]) ??
        new Set<VidnestLeaf>();
    const globalDeny = globalLeafSwitch(environment, VIDNEST_FAMILY_ID, 'deny');

    return Object.freeze({
        enabled: (leaf: VidnestLeaf) =>
            allowedByBoth(leaf, allow, globalAllow) &&
            !deny.has(leaf) &&
            !globalDeny?.has(leaf)
    });
}

function parseList(
    name: string,
    raw: string | undefined
): Set<VidnestLeaf> | undefined {
    if (raw === undefined || raw.trim() === '') {
        return name === VIDNEST_ALLOW_ENV ? undefined : new Set<VidnestLeaf>();
    }

    const leaves = new Set<VidnestLeaf>();
    const tokens = raw.split(',').map((value) => value.trim().toLowerCase());
    for (const token of tokens) {
        if (INELIGIBLE.has(token)) {
            throw new TypeError(
                `${name} references an ineligible VidNest leaf`
            );
        }
        if (!ELIGIBLE.has(token)) {
            throw new TypeError(`${name} references an unknown VidNest leaf`);
        }
        if (leaves.has(token as VidnestLeaf)) {
            throw new TypeError(`${name} contains a duplicate VidNest leaf`);
        }
        leaves.add(token as VidnestLeaf);
    }
    return leaves;
}

// Validate deployment configuration when the provider module is loaded.
export const VIDNEST_LEAF_POLICY = createVidnestLeafPolicy(process.env);
import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';
