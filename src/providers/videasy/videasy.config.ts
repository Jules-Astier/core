import type { VideasyServer } from './videasy.types.js';
import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';

export const VIDEASY_FAMILY_ID = 'videasy';
const API_BASE_URL = 'https://api.speedracelight.com';

export const VIDEASY_ACTIVE_SERVERS = [
    {
        name: 'cdn',
        url: `${API_BASE_URL}/cdn/sources-with-title`,
        language: 'en',
        languageLabel: 'English'
    },
    {
        name: 'm4uhd',
        url: `${API_BASE_URL}/m4uhd/sources-with-title`,
        language: 'en',
        languageLabel: 'English'
    },
    {
        name: 'hdmovie',
        url: `${API_BASE_URL}/hdmovie/sources-with-title`,
        language: 'mul',
        languageLabel: 'Multi'
    },
    {
        name: 'meine-de',
        url: `${API_BASE_URL}/meine/sources-with-title`,
        language: 'de',
        languageLabel: 'German',
        requestLanguage: 'german'
    },
    {
        name: 'lamovie',
        url: `${API_BASE_URL}/lamovie/sources-with-title`,
        language: 'es',
        languageLabel: 'Spanish'
    },
    {
        name: 'superflix',
        url: `${API_BASE_URL}/superflix/sources-with-title`,
        language: 'pt',
        languageLabel: 'Portuguese'
    }
] as const satisfies readonly VideasyServer[];

export const VIDEASY_DISABLED_LEAVES = [
    { name: 'primesrcme', status: 'seed-needed', enabled: false },
    { name: 'overflix', status: 'seed-needed', enabled: false },
    { name: 'visioncine', status: 'seed-needed', enabled: false },
    { name: 'meine-it', status: 'seed-needed', enabled: false },
    { name: 'meine-fr', status: 'seed-needed', enabled: false },
    { name: 'primewire', status: 'seed-needed', enabled: false }
] as const;

export const VIDEASY_RETIRED_LEAVES = [
    { name: 'cuevana', status: 'retired', enabled: false },
    { name: 'mb-flix', status: 'retired', enabled: false },
    { name: '1movies', status: 'retired', enabled: false }
] as const;

const LEGACY_ALIASES: Readonly<Record<string, string>> = {
    yoru: 'cdn',
    breach: 'm4uhd',
    killjoy: 'meine-de',
    vyse: 'hdmovie',
    fade: 'hdmovie',
    omen: 'lamovie',
    raze: 'superflix'
};

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
            const leaf = normalized.startsWith('videasy:')
                ? normalized.slice('videasy:'.length)
                : normalized;
            return LEGACY_ALIASES[leaf] ?? leaf;
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
        [...VIDEASY_DISABLED_LEAVES, ...VIDEASY_RETIRED_LEAVES].map(
            ({ name: leaf }) => leaf
        )
    );
    for (const value of unique) {
        if (disabled.has(value)) {
            throw new TypeError(
                `${name} references a retired or seed-gated Videasy leaf`
            );
        }
        if (!active.has(value)) {
            throw new TypeError(`${name} references an unknown Videasy leaf`);
        }
    }
    return unique;
}
