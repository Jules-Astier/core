# ADR-0002: Awaited provider health control

## Status

Accepted for PE-009; extended for PE-013.

## Context

OMSS provider health is a legacy `Promise<boolean>` contract. Its public health
service invokes the registry health suite without awaiting it, while the
registry runs providers serially. That behavior can leave work running after a
health response and cannot distinguish timeout or failure ownership.

PE-003 defines family, leaf, and embed-host identities. Health must use those
same canonical catalog identities and must never persist or log request,
media, or upstream error data.

## Decision

CinePro owns a local, awaited evaluator with a fixed worker pool. Concurrency is
bounded to 1–16 (default 4); lightweight checks time out after 8 seconds by
default and all level timeouts are startup-bounded to 1–60 seconds. Results are
sorted by canonical subject ID and check level and contain only closed enums,
stable bounded codes, duration, timestamp, check ID, and release identity.
Unknown exceptions become `internal/UNCLASSIFIED`; legacy `false` becomes
`internal/HEALTH_FALSE`. Raw errors are discarded.

Startup reads and validates exact canonical catalog IDs from:

- `CINEPRO_PROVIDER_FAMILY_ALLOWLIST` / `CINEPRO_PROVIDER_FAMILY_DENYLIST`
- `CINEPRO_PROVIDER_LEAF_ALLOWLIST` / `CINEPRO_PROVIDER_LEAF_DENYLIST`
- `CINEPRO_PROVIDER_HOST_ALLOWLIST` / `CINEPRO_PROVIDER_HOST_DENYLIST`

Lists are comma-separated. Empty allowlists allow eligible catalog entries.
Unknown, duplicate, empty, or noncanonical values fail startup. Catalog
disablement applies first, then family and subject switches; deny always wins.
Leaf allowlisting cannot override family denial.
Disabled registered providers remain in the result inventory as `skipped` with
a stable `disabledReason`; providers without a legacy health adapter are also
`skipped` rather than guessed healthy or broken.

Family ineligibility sets the framework's native provider `enabled` selection
flag false and therefore flows through movie, TV, and live request-time
selection without changing registration, lookup, count, or registry methods.
Catalog leaf and embed-host subjects are also installed in the inventory. The
control exposes a read-only canonical-subject eligibility interface for
provider and embed components; those components must consult it before using a
leaf or host. The five currently attributed aggregators consume the same global
leaf allow/deny variables during their existing startup policy construction;
their provider-local switches intersect with the global allowlist and both deny
lists win. The PE-017 embed registry consumes the host eligibility interface.
Deny wins at every level.

The server awaits one lightweight evaluation after provider discovery and
before listening. It replaces only the registry's request-time
`healthCheckAll()` behavior with a read of the latest completed snapshot. This
keeps the existing OMSS response shape and makes its legacy fire-and-forget
call harmless. Refreshes are single-flight.

On timeout the runner aborts and allows a bounded cleanup grace. If a legacy
check ignores cancellation and remains active, its worker slot is quarantined
for the rest of that run. Checks that cannot be admitted within the remaining
true concurrency capacity are `skipped/CONCURRENCY_QUARANTINED`. Thus a
non-cooperative check can reduce health coverage, but cannot cause later checks
to escape the configured outbound concurrency bound.

During the catalog migration, runtime-enabled entries in pre-release lifecycle
states remain eligible unless their state is `disabled`, `deferred`,
`rejected`, or `retired`. This preserves existing CinePro availability while
the catalog release states are populated.

## Alternatives considered

- Changing OMSS public health responses: deferred because PE-009 can close the
  execution defect at the CinePro seam without a framework release.
- Running all checks with `Promise.all`: rejected because registry size must
  not determine outbound concurrency.
- Persistence and fixed-canary rechecks were delivered by PE-010 and PE-013.

## Consequences

Startup waits for bounded deadlines and cleanup grace for admitted checks.
Provider failures do not abort siblings while capacity remains. PE-010 can consume the
structured results without changing this runner. Playback probes, schedules,
and arbitrary URL controls remain intentionally absent.

## PE-013 fixed-canary extension

`ProviderHealthControl.recheck()` accepts one exact canonical family ID. It
fails closed for unknown IDs, leaf or embed-host IDs, disabled families, and
providers that do not advertise both movie and TV support. Catalog mapping,
not caller input, selects the single registered runtime provider.

Every accepted recheck executes exactly two compile-time resolver canaries:
movie TMDB `550`, IMDb `tt0137523`, year `1999`; and TV TMDB `1399`, IMDb
`tt0944947`, year `2011`, season 1 episode 1. Callers cannot provide a URL,
title, media identity, headers, or alternate body fields. The provider's two
results are reduced inside the health runner to one resolver-level
`HealthResult`; sources, subtitles, diagnostics, exceptions, and raw upstream
data are discarded. Resolver timeouts use the existing abort and
non-cooperative-work quarantine behavior.

Rechecks are single-flight per canonical family. Successful completion updates
only that in-memory latest key and persists only the new sanitized event.
PE-010 persistence merges that key with untouched latest keys while appending
the event to bounded history.

The optional internal listener exists only when
`CINEPRO_INTERNAL_RECHECK_TOKEN` is a whitespace-free 32–256 byte startup
secret. Bind, port, global concurrency, and resolver timeout are fixed,
bounded startup settings. Its only route is exact
`POST /internal/provider-health/recheck/:id`, protected by timing-safe Bearer
verification. It accepts only `Content-Type: application/json` and an empty
JSON object within 1 KiB. It emits no CORS headers and all responses use
`no-store` and `nosniff`. The service is intended only for a private Compose
service network and must have no published port.
