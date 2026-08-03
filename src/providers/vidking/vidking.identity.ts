import { createProviderIdentityCatalog } from '../../provider-identity.js';

export const VIDKING_FAMILY_ID = 'vidking';

export const VIDKING_LEAVES = [
    'yoru',
    'cypher',
    'breach',
    'neon',
    'vyse',
    'killjoy',
    'fade',
    'omen',
    'raze'
] as const;

export type VidKingLeaf = (typeof VIDKING_LEAVES)[number];

const identityEntries = [
    { id: VIDKING_FAMILY_ID, kind: 'aggregator' },
    ...VIDKING_LEAVES.map((leaf) => ({
        id: `${VIDKING_FAMILY_ID}:${leaf}`,
        familyId: VIDKING_FAMILY_ID,
        kind: 'upstream'
    }))
] as const;

export const vidKingIdentityCatalog =
    createProviderIdentityCatalog(identityEntries);

export function vidKingUpstreamId(
    leaf: VidKingLeaf
): `vidking:${VidKingLeaf}` {
    return vidKingIdentityCatalog.resolve(
        leaf,
        VIDKING_FAMILY_ID
    ) as `vidking:${VidKingLeaf}`;
}
