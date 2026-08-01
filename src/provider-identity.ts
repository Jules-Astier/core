import type { Source } from '@omss/framework';

const COMPONENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVIDER_ID_PATTERN =
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export type SourceIdentity = {
    providerFamilyId: string;
    upstreamId?: string;
    embedHostId?: string;
};

export type IdentifiedSource = Source & SourceIdentity;

export type ProviderCatalogAlias = {
    value: string;
    scope?: string;
};

export type ProviderCatalogIdentityEntry = {
    id: string;
    familyId?: string;
    kind?: string;
    aliases?: readonly ProviderCatalogAlias[];
};

export type ProviderIdentityInput = {
    familyId: string;
    providerName: string;
    upstreamId?: string;
    embedHostId?: string;
};

export type SourceWithoutProviderIdentity = Omit<
    Source,
    'provider' | keyof SourceIdentity
>;

export function canonicalizeIdentityComponent(value: string): string {
    const canonical = value
        .trim()
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    if (!canonical || !COMPONENT_PATTERN.test(canonical)) {
        throw new TypeError(
            `Cannot canonicalize identity component "${value}"`
        );
    }
    return canonical;
}

export function canonicalizeProviderId(value: string): string {
    const parts = value.split(':');
    if (parts.length > 2 || parts.some((part) => part.trim() === '')) {
        throw new TypeError(`Invalid provider ID "${value}"`);
    }
    return parts.map(canonicalizeIdentityComponent).join(':');
}

export function assertSourceIdentity(
    source: Pick<IdentifiedSource, 'provider' | keyof SourceIdentity>
): void {
    const providerId = source.provider.id;
    const familyId = source.providerFamilyId;

    assertCanonicalProviderId(providerId, 'provider.id');
    assertCanonicalComponent(familyId, 'providerFamilyId');
    assertDisplayName(source.provider.name);

    if (source.upstreamId === undefined) {
        if (providerId !== familyId) {
            throw new TypeError(
                'A family source requires provider.id to equal providerFamilyId'
            );
        }
    } else {
        assertCanonicalProviderId(source.upstreamId, 'upstreamId');
        if (
            source.upstreamId !== providerId ||
            !source.upstreamId.startsWith(`${familyId}:`)
        ) {
            throw new TypeError(
                'A leaf source requires provider.id === upstreamId with the providerFamilyId prefix'
            );
        }
    }

    if (source.embedHostId !== undefined) {
        assertCanonicalComponent(source.embedHostId, 'embedHostId');
    }
}

export function createProviderIdentityCatalog(
    entries: readonly ProviderCatalogIdentityEntry[]
) {
    const canonicalIds = new Set<string>();
    const aliases = new Map<string, string>();

    for (const entry of entries) {
        assertCanonicalProviderId(entry.id, 'catalog entry ID');
        canonicalIds.add(entry.id);
    }

    for (const entry of entries) {
        for (const alias of entry.aliases ?? []) {
            const normalizedAlias = canonicalizeIdentityComponent(alias.value);
            const key = alias.scope
                ? `${canonicalizeIdentityComponent(alias.scope)}:${normalizedAlias}`
                : normalizedAlias;
            const previous = aliases.get(key);
            if (previous && previous !== entry.id) {
                throw new TypeError(
                    `Catalog alias "${key}" is ambiguous between "${previous}" and "${entry.id}"`
                );
            }
            aliases.set(key, entry.id);
        }
    }

    function resolve(value: string, scope?: string): string {
        const normalized = canonicalizeProviderId(value);
        const canonicalScope =
            scope === undefined
                ? undefined
                : canonicalizeIdentityComponent(scope);
        if (
            canonicalScope &&
            normalized.includes(':') &&
            !normalized.startsWith(`${canonicalScope}:`)
        ) {
            throw new TypeError(
                `Provider identity "${normalized}" is outside scope "${canonicalScope}"`
            );
        }
        const key =
            canonicalScope && !normalized.includes(':')
                ? `${canonicalScope}:${normalized}`
                : normalized;
        const resolved =
            aliases.get(key) ?? (canonicalIds.has(key) ? key : normalized);
        if (!canonicalIds.has(resolved)) {
            throw new TypeError(`Unknown catalog provider identity "${value}"`);
        }
        return resolved;
    }

    function identifySource(
        source: SourceWithoutProviderIdentity,
        input: ProviderIdentityInput
    ): IdentifiedSource {
        const familyId = resolve(input.familyId);
        if (familyId.includes(':')) {
            throw new TypeError(
                `Provider family "${familyId}" cannot be a leaf`
            );
        }

        const upstreamId =
            input.upstreamId === undefined
                ? undefined
                : resolve(input.upstreamId, familyId);
        const providerId = upstreamId ?? familyId;
        const identified: IdentifiedSource = {
            ...source,
            provider: { id: providerId, name: input.providerName },
            providerFamilyId: familyId,
            ...(upstreamId === undefined ? {} : { upstreamId }),
            ...(input.embedHostId === undefined
                ? {}
                : {
                      embedHostId: resolveEmbedHost(input.embedHostId)
                  })
        };
        assertSourceIdentity(identified);
        return identified;
    }

    function resolveEmbedHost(value: string): string {
        const resolved = resolve(value);
        const entry = entries.find(({ id }) => id === resolved);
        if (entry?.kind !== 'embed_host') {
            throw new TypeError(
                `Catalog identity "${resolved}" is not an embed host`
            );
        }
        return resolved;
    }

    return Object.freeze({
        resolve,
        identifySource,
        assertSourceIdentity
    });
}

function assertCanonicalComponent(value: string, field: string): void {
    if (!COMPONENT_PATTERN.test(value)) {
        throw new TypeError(`${field} must be a canonical identity component`);
    }
}

function assertCanonicalProviderId(value: string, field: string): void {
    if (!PROVIDER_ID_PATTERN.test(value)) {
        throw new TypeError(`${field} must be a canonical provider ID`);
    }
}

function assertDisplayName(value: string): void {
    if (!value.trim()) {
        throw new TypeError('provider.name must not be empty');
    }
}
