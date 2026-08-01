import type { VideasyServer } from './videasy.types.js';
import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';

export const VIDEASY_FAMILY_ID = 'videasy';

export const VIDEASY_ACTIVE_SERVERS = [
    {
        name: 'cuevana',
        url: 'https://api2.videasy.net/cuevana/sources-with-title',
        language: 'english'
    },
    {
        name: 'mb-flix',
        url: 'https://api.videasy.net/mb-flix/sources-with-title',
        language: 'english'
    },
    {
        name: '1movies',
        url: 'https://api.videasy.net/1movies/sources-with-title',
        language: 'english'
    },
    {
        name: 'cdn',
        url: 'https://api.videasy.net/cdn/sources-with-title',
        language: 'english'
    },
    {
        name: 'superflix',
        url: 'https://api.videasy.net/superflix/sources-with-title',
        language: 'english'
    },
    {
        name: 'lamovie',
        url: 'https://api.videasy.net/lamovie/sources-with-title',
        language: 'english'
    }
] as const satisfies readonly VideasyServer[];

export const VIDEASY_DISABLED_LEAVES = [
    {
        name: 'primesrcme',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized seed required'
    },
    {
        name: 'm4uhd',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized seed required'
    },
    {
        name: 'meine-de',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized German seed required'
    },
    {
        name: 'meine-it',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized Italian seed required'
    },
    {
        name: 'meine-fr',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized French seed required'
    },
    {
        name: 'overflix',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized seed required'
    },
    {
        name: 'visioncine',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized seed required'
    },
    {
        name: 'hdmovie',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized seed required; quality may contain a language label'
    },
    {
        name: 'primewire',
        status: 'seed-needed',
        enabled: false,
        reason: 'authorized seed required'
    }
] as const;

export type VideasyLeafEnvironment = Readonly<
    Partial<Record<'VIDEASY_LEAF_ALLOWLIST' | 'VIDEASY_LEAF_DENYLIST', string>>
>;

export function resolveVideasyServers(
    environment: VideasyLeafEnvironment = process.env
): readonly VideasyServer[] {
    const allow = parseLeafList(
        'VIDEASY_LEAF_ALLOWLIST',
        environment.VIDEASY_LEAF_ALLOWLIST
    );
    const deny = parseLeafList(
        'VIDEASY_LEAF_DENYLIST',
        environment.VIDEASY_LEAF_DENYLIST
    );
    const globalAllow = globalLeafSwitch(
        environment,
        VIDEASY_FAMILY_ID,
        'allow'
    );
    const globalDeny = globalLeafSwitch(environment, VIDEASY_FAMILY_ID, 'deny');
    return Object.freeze(
        VIDEASY_ACTIVE_SERVERS.filter(
            ({ name }) =>
                allowedByBoth(
                    name,
                    allow.size === 0 ? undefined : allow,
                    globalAllow
                ) &&
                !deny.has(name) &&
                !globalDeny?.has(name)
        )
    );
}

function parseLeafList(name: string, raw: string | undefined): Set<string> {
    const values = (raw ?? '')
        .split(',')
        .map((value) => {
            const normalized = value.trim().toLowerCase();
            return normalized.startsWith('videasy:')
                ? normalized.slice('videasy:'.length)
                : normalized;
        })
        .filter(Boolean);
    const unique = new Set(values);
    if (unique.size !== values.length) {
        throw new TypeError(`${name} contains a duplicate Videasy leaf`);
    }
    const active = new Set<string>(
        VIDEASY_ACTIVE_SERVERS.map(({ name: leaf }) => leaf)
    );
    const disabled = new Set<string>(
        VIDEASY_DISABLED_LEAVES.map(({ name: leaf }) => leaf)
    );
    for (const value of unique) {
        if (disabled.has(value)) {
            throw new TypeError(
                `${name} references a disabled Videasy leaf; an authorized seed review is required`
            );
        }
        if (!active.has(value)) {
            throw new TypeError(`${name} references an unknown Videasy leaf`);
        }
    }
    return unique;
}
