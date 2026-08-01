# ADR-0006: Bounded redirect-drift guard

## Status

Accepted for PE-016.

## Context

The Animetsu investigation found an indexed provider origin redirecting to
unrelated generic content, with no maintained primary manifest or two
authorized identities proving a legitimate migration. Animetsu therefore
remains retired. A redirect loading successfully is not provider-health proof:
unrestricted following can mistake parking, advertising, or domain takeover
for a healthy provider.

PE-009 defines `redirect_drift` as a closed health failure and prohibits raw
URLs, signed parameters, headers, response bodies, titles, and upstream errors
in health results.

## Decision

CinePro provides a pure, injected redirect guard for health, provider, and
embed fetch seams. The transport runs with manual redirects. Configuration is
copied, frozen, and validated at startup:

- the canonical origin and every reviewed migration origin are exact HTTPS
  origins without paths, queries, fragments, credentials, or IP literals;
- reviewed origins are explicit and unique;
- redirect hops, timeout, and optional fingerprint bytes have hard bounds;
- an optional expected fingerprint is an exact lowercase SHA-256 value.

Each runtime request must start at the canonical origin. Every redirect is
resolved and checked before the next request. HTTPS downgrade, credentials,
IP literals, unreviewed cross-origin targets, invalid locations, loops, and
excess hops fail closed. Same-origin redirects and explicitly reviewed
migration origins are allowed. Final content may be compared using SHA-256
over a bounded prefix; a mismatch fails closed.

All drift variants throw `RedirectDriftFailure` with PE-009 class
`redirect_drift`, stable code `REDIRECT_DRIFT`, and a closed reason enum.
No URL or upstream value is copied into the exception or result. Successful
results contain only a hop count, canonical/reviewed class, and optional
SHA-256. Caller abort and the bounded timeout signal are passed to the injected
transport and propagate without being mislabeled as redirect drift. Fetch,
stream reads, and body cancellation are raced against that deadline, so a
non-cooperative transport or stream cannot hold the check open. Late transport
settlement is observed, and every response available on an unsuccessful exit
receives bounded best-effort body disposal without changing the closed,
sanitized result.

## Consequences

Callers retain ownership of HTTP status and non-redirect health
classification. The guard does not perform DNS policy or rebinding checks;
the transport seam must enforce those network-level PE-009 controls. It does
not accept arbitrary origins, update allowlists, discover replacement domains,
follow live evidence, or self-heal provider configuration.

Animetsu stays retired. Reconsideration requires a maintained primary manifest,
an intentionally reviewed origin change, and two authorized media identities;
an allowlisted redirect alone is insufficient.
