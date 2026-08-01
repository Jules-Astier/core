# ADR-0003: Keep the debrid HTTPS prototype disabled and isolated

## Status

Accepted as PE-021 prototype evidence. This is not a playback enablement
decision; PE-024 owns that decision.

## Context

PE-020 adds optional, metadata-only OMSS `TorrentCandidate` objects alongside
playable sources. A debrid service could translate a cached candidate into an
HTTPS media link, but introduces a server credential, expiring URLs, service
availability, privacy, quota, and seek-compatibility concerns.

No service, addon, torrent, tracker, peer, or media endpoint was contacted while
building or testing this prototype. Tests use an injected fake transport and a
synthetic Sintel public-domain metadata fixture.

## Decision

`src/torrent/debrid` is a provider-neutral, server-only experiment. It accepts
a structural subset compatible with OMSS `TorrentCandidate`; it is not imported
by the server, provider registry, or UI.

- The immutable default config has `enabled: false`.
- When explicitly enabled, the secret is resolved by environment-variable name
  at call time. The public config, result, and observation types contain no
  credential field. Only the injected transport receives a Bearer value.
- Calls have a 2-second default timeout, at most one retry, four candidates,
  three returned links, and a three-failure/30-second in-memory circuit.
- Candidates are examined in input order. The first candidate with accepted
  links wins; duplicate links retain their first capability metadata.
- Cache miss, disabled, missing-secret, circuit-open, timeout, transport error,
  and invalid response are explicit bounded states.
- Only credential-free HTTPS URLs without URL user-info are returned. HTTP,
  malformed, or duplicate URLs are rejected.
- Range support is explicit. `seekable` is true only when byte-range support is
  affirmatively reported; it is never inferred from filename or container.
- Observability is counters and enum outcomes only. It excludes hashes, names,
  URLs, tokens, transport messages, and errors. The diagnostic redactor removes
  URLs, Bearer values, token-like query fields, supplied secrets, and truncates.

Configuration values are intentionally code-local because PE-021 forbids
package, deployment config, server, and provider integration. Enabling this
class in production requires later configuration, privacy/security review,
service-specific transport work, and the PE-024 architecture decision.

## Consequences

The prototype demonstrates the narrow cache-to-HTTPS boundary and its failure
states without making torrent metadata playable or exposing secrets to a
browser. Circuit state is process-local and deliberately non-durable. Link
expiry/refresh, provider quotas, codec/container support, jurisdiction,
disclosure/consent, multi-instance circuit coordination, and URL handoff
redaction remain unresolved production risks.

Rollback is deletion of this isolated directory, test, and ADR. There is no
runtime configuration, persistent state, network service, or migration to
clean up.

## References

- PE-020 accepted design:
  `saucy-streams/.codex-subagents/evidence/PE-020/torrent-contract-design.md`
- OMSS ADR-0002: non-playable torrent candidate metadata
- Provider expansion ledger entries PE-020, PE-021, and PE-024
