# Provider recheck runbook

The CinePro recheck listener is an internal control-plane boundary. Do not
publish its port or route it through the public CinePro ingress.

## Enable

Provision a unique random whitespace-free token of 32-256 bytes, then set these fixed
startup values on the CinePro service:

```text
CINEPRO_INTERNAL_RECHECK_TOKEN=<secret>
CINEPRO_INTERNAL_RECHECK_HOST=127.0.0.1
CINEPRO_INTERNAL_RECHECK_PORT=3011
CINEPRO_INTERNAL_RECHECK_CONCURRENCY=4
CINEPRO_HEALTH_RESOLVER_TIMEOUT_MS=20000
```

The host is closed to explicit literals: `127.0.0.1`, `::1`, `0.0.0.0`, or
`::`. Use a wildcard only inside a container whose recheck port is not
published. Public IP addresses and DNS names are rejected at startup.

Keep the token in deployment secret storage. The calling service must share a
private Compose network with CinePro. Do not add a `ports` mapping for 3011.
Restart CinePro after changing any value.

## Invoke

The caller sends only an exact canonical family ID and an empty JSON object:

```sh
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $CINEPRO_INTERNAL_RECHECK_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}' \
  "http://cinepro-core:3011/internal/provider-health/recheck/tulnex"
```

Never place the token in a URL or log the Authorization header. The response
contains one sanitized provider health result. CinePro always chooses its two
fixed movie/episode identities; the caller cannot select media, titles, URLs,
or request fields.

The fixed movie is _Fight Club_ (TMDB 550, IMDb `tt0137523`, 1999). The fixed
episode is _Game of Thrones_ S1E1 (TMDB 1399, IMDb `tt0944947`, 2011). Both
must resolve at least one source for a passing family recheck.

`401` means authentication failed, `404` means the path or family is unknown,
`400` means the body/subject/provider is ineligible, and `429` means the global
recheck bound is occupied. Duplicate requests for the same family join one
in-flight recheck.

## Component rollout and kill switches

The six optional controls accept comma-separated exact canonical catalog IDs:

- `CINEPRO_PROVIDER_FAMILY_ALLOWLIST` and
  `CINEPRO_PROVIDER_FAMILY_DENYLIST`
- `CINEPRO_PROVIDER_LEAF_ALLOWLIST` and `CINEPRO_PROVIDER_LEAF_DENYLIST`
- `CINEPRO_PROVIDER_HOST_ALLOWLIST` and `CINEPRO_PROVIDER_HOST_DENYLIST`

Blank controls preserve catalog defaults. A nonempty allowlist disables every
unmatched identity, while a deny always wins. Empty entries, duplicates,
unknown IDs, and noncanonical IDs fail startup closed. Examples are `tulnex`
for a family, `tulnex:onion` for a leaf, and `streamwish` for an embed host.

For a staged rollout, validate the IDs against the generated catalog report,
start with a narrow allowlist or one deny entry, restart CinePro, invoke the
fixed-canary recheck, inspect the sanitized health snapshot, and widen only
after the gate passes. Compose users must pass these variables through the
`cinepro-core.environment` section; the repository Compose file already does.

## Rollback

Unset `CINEPRO_INTERNAL_RECHECK_TOKEN` and restart CinePro. The internal
listener will not start. Existing health snapshots and ordinary startup health
checks remain available.

To roll back a component rollout, remove its allow/deny overrides to restore
catalog defaults, or retain/add a deny entry to keep the component disabled,
then restart CinePro.
