# Videasy provider configuration

The six reviewed active leaves are enabled by default in catalog order.
`VIDEASY_LEAF_ALLOWLIST` selects a comma-separated subset; unset or empty means
all active leaves. `VIDEASY_LEAF_DENYLIST` skips a comma-separated subset.

Valid values are `cuevana`, `mb-flix`, `1movies`, `cdn`, `superflix`, and
`lamovie`. Deny entries take precedence over allow entries. Unknown, duplicate,
and disabled values fail provider construction. Nine disabled candidates are
recorded in `videasy.config.ts` as `seed-needed`; configuration cannot enable
them. Retest them only after current authorized seeds are supplied.
