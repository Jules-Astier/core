import { createProviderIdentityCatalog } from '../../provider-identity.js';

export const TULNEX_FAMILY_ID = 'tulnex';

export const TULNEX_LEAVES = [
    'onion',
    'vidzee',
    'icefy',
    'tik',
    'vaplayer',
    'vidfast-alpha',
    'uniquestream',
    'vidfast-mega',
    'vidfast-vrapid',
    'allmovies',
    'vidlink',
    'vidfast-vedge',
    'vidfast-vfast',
    'moviebox'
] as const;

export type TulnexLeaf = (typeof TULNEX_LEAVES)[number];

const identityEntries = [
    { id: TULNEX_FAMILY_ID, kind: 'aggregator' },
    ...TULNEX_LEAVES.map((leaf) => ({
        id: `${TULNEX_FAMILY_ID}:${leaf}`,
        familyId: TULNEX_FAMILY_ID,
        kind: 'upstream'
    }))
] as const;

export const tulnexIdentityCatalog =
    createProviderIdentityCatalog(identityEntries);

export function tulnexUpstreamId(leaf: TulnexLeaf): `tulnex:${TulnexLeaf}` {
    return tulnexIdentityCatalog.resolve(
        leaf,
        TULNEX_FAMILY_ID
    ) as `tulnex:${TulnexLeaf}`;
}
