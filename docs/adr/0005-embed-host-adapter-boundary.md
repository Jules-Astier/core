# ADR-0005: Keep embed hosts behind a bounded delivery adapter

## Status

Accepted for PE-017.

## Context

Provider identity discovery and media delivery are separate responsibilities.
PE-003 defines family and upstream attribution while keeping `embedHostId`
orthogonal. PE-009 defines host eligibility and closed health failures. The
eight catalogued host candidates have no authorized two-context evidence, so
PE-017 must establish a safe seam without certifying or contacting a host.

## Decision

Embed hosts are catalog-backed delivery adapters selected by exact canonical
hostname aliases and explicit, anchored URL-role rules. The versioned
production catalog is initially empty; reviewed domains and adapters are
separate PE-018 changes.

The caller supplies a valid provider/upstream identity, which the registry
copies unchanged. An adapter can add only its canonical host identity. The
registry consumes PE-009's canonical read-only eligibility instead of parsing
duplicate allow/deny policy. It applies a bounded deadline, forwards
pre-existing aborts, performs strict output validation and safe request-context
handling, deterministically deduplicates within an upstream, and reconstructs
closed redacted failures. Timed-out non-cooperative work is quarantined with at
most one active invocation per host until it settles.

Only `Accept`, `Origin`, `Referer`, and one fixed `User-Agent` profile may cross
the boundary. Provider context hostnames are validated and bounded before
adapter invocation, then passed as a canonical frozen snapshot. Origin and
Referer must be HTTPS and explicitly contextual.
Credentials, cookies, authorization, arbitrary headers, IP literals, local
names, non-default ports, fuzzy domains, non-HTTPS URLs, ad/tracker/CDN roles,
non-embed paths, and explicit DRM, CAPTCHA, or anti-bot indicators are rejected.
HeadlessVidX is an injected fixed private/loopback IP origin retained as
canonical primitive text, with a fresh URL constructed for every transport
invocation. It has its own input, body, response, and deadline limits and is
never an identity.

Catalogs and adapter rules are validated, cloned, and frozen at registration.
Catalog regexes must be anchored and stateless; canonical, alias, redirect,
blocked/output host rules reject IP literals, local names, and unsafe
authorities; redirect hosts and query keys are validated; and each host has
exactly one canonical domain.

Adapters return raw validated targets. Provider integrations remain responsible
for constructing OMSS sources and proxy URLs. The registry never evaluates
scripts, downloads runtime rules, solves challenges, recursively browses
iframes, mutates configuration, or falls back across adapters.

## Consequences

PE-017 changes no provider or runtime behavior. Each PE-018 adapter requires
reviewed aliases, paths, output hosts, sanitized fixtures, and two authorized
provider contexts. Cross-upstream URL matches remain distinct because collapsing
them would erase attribution. Operators can disable an individual host using
the same `catalog`, `host_deny`, and `host_not_allowed` meanings used by PE-009.
