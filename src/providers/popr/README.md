# Popr leaf controls

Popr queries all ten catalogued leaves by default, preserving the legacy
behavior. Deployments can limit individual leaves at startup:

- `POPR_LEAF_ALLOWLIST`: comma-separated allowlist.
- `POPR_LEAF_DENYLIST`: comma-separated denylist; deny takes precedence.

Values must be exact canonical IDs or explicit request/catalog aliases from
`popr.config.ts` (for example `popr:gama`, `Gama`, or `ynx_vidsrc`). Unknown
values fail startup validation. A leaf-level request failure is isolated and
does not suppress successful siblings.
