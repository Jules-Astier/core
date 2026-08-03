import { createProviderIdentityCatalog } from '../../provider-identity.js';

export const VIDLOVE_FAMILY_ID = 'vidlove';

export const VIDLOVE_LEAVES = [
    'ipcloud',
    'moviebox',
    'vidapi',
    'tcloud',
    'vixsrc',
    '1embed',
    'xpass',
    'vidrift',
    'lookmovie',
    'vidnest'
] as const;

export type VidLoveLeaf = (typeof VIDLOVE_LEAVES)[number];

const identityEntries = [
    { id: VIDLOVE_FAMILY_ID, kind: 'aggregator' },
    ...VIDLOVE_LEAVES.map((leaf) => ({
        id: `${VIDLOVE_FAMILY_ID}:${leaf}`,
        familyId: VIDLOVE_FAMILY_ID,
        kind: 'upstream'
    }))
] as const;

export const vidLoveIdentityCatalog =
    createProviderIdentityCatalog(identityEntries);

export function vidLoveUpstreamId(
    leaf: VidLoveLeaf
): `vidlove:${VidLoveLeaf}` {
    return vidLoveIdentityCatalog.resolve(
        leaf,
        VIDLOVE_FAMILY_ID
    ) as `vidlove:${VidLoveLeaf}`;
}
