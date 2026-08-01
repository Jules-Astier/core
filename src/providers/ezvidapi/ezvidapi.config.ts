import { allowedByBoth, globalLeafSwitch } from '../provider-leaf-switches.js';

export const EZVIDAPI_FAMILY_ID = 'ezvidapi';

export const EZVIDAPI_LEAVES = [
    { slug: 'vidsrc', id: 'ezvidapi:vidsrc', label: 'VidSrc' },
    { slug: 'vidrock', id: 'ezvidapi:vidrock', label: 'VidRock' },
    { slug: 'vidzee', id: 'ezvidapi:vidzee', label: 'VidZee' },
    { slug: 'icefy', id: 'ezvidapi:icefy', label: 'Icefy' },
    { slug: 'vidlink', id: 'ezvidapi:vidlink', label: 'VidLink' },
    { slug: 'vidnest', id: 'ezvidapi:vidnest', label: 'VidNest' },
    { slug: 'vixsrc', id: 'ezvidapi:vixsrc', label: 'VixSrc' },
    { slug: 'popr', id: 'ezvidapi:popr', label: 'Popr' }
] as const;

export type EzVidApiLeaf = (typeof EZVIDAPI_LEAVES)[number];
export type EzVidApiEnvironment = Readonly<Record<string, string | undefined>>;

const NORMALIZED_ALIASES: Readonly<Record<string, EzVidApiLeaf>> =
    Object.freeze(
        Object.fromEntries(
            EZVIDAPI_LEAVES.flatMap((leaf) => [
                [normalizeEzVidApiName(leaf.slug), leaf],
                [normalizeEzVidApiName(leaf.label), leaf]
            ])
        )
    );

export function normalizeEzVidApiName(value: string): string {
    return value
        .trim()
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolve only names explicitly represented by the immutable alias table.
 * Normalization makes upstream case and punctuation cosmetic, but never turns
 * an unknown name into a new runtime provider identity.
 */
export function resolveEzVidApiLeaf(value: string): EzVidApiLeaf | undefined {
    const normalized = normalizeEzVidApiName(value);
    return normalized ? NORMALIZED_ALIASES[normalized] : undefined;
}

export function createEzVidApiLeafPolicy(
    environment: EzVidApiEnvironment = process.env
) {
    const globalAllow = globalLeafSwitch(
        environment,
        EZVIDAPI_FAMILY_ID,
        'allow'
    );
    const globalDeny = globalLeafSwitch(
        environment,
        EZVIDAPI_FAMILY_ID,
        'deny'
    );

    return Object.freeze({
        enabled(leaf: EzVidApiLeaf): boolean {
            return (
                allowedByBoth(leaf.slug, undefined, globalAllow) &&
                !globalDeny?.has(leaf.slug)
            );
        }
    });
}
