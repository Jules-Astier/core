# ADR-0001: Construct canonical provider source identity

## Status

Accepted as the CinePro cross-reference for PE-003.

## Context

The accepted provider-expansion program distinguishes a registered provider
family, its resolver leaf, and the embed host that delivers media. OMSS owns
the additive public `SourceIdentity` contract and its identity-aware response
deduplication; Saucy owns tolerant legacy normalization and family grouping.

## Decision

CinePro constructs source identity through the pure
`src/provider-identity.ts` boundary. It canonicalizes IDs with the PE-003
grammar, resolves only aliases explicitly supplied by the provider catalog,
preserves `provider.name`, and asserts:

- a family source has `provider.id === providerFamilyId`;
- a leaf has `provider.id === upstreamId` and belongs to its family;
- `embedHostId` is a separate canonical catalog embed-host identity.

Provider-owned PE-004 through PE-008 slices will adopt this helper. PE-003 does
not change providers, the registry, or server behavior.

## Consequences

Malformed, unknown, noncanonical, or cross-family producer metadata fails at
construction instead of reaching OMSS. Existing providers remain parent-only
until their owned migration slices. Consumer compatibility, cache migration,
and deduplication remain governed by the accepted PE-003 identity contract and
the OMSS identity ADR.
