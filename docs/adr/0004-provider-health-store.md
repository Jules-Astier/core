# ADR-0004: CinePro-owned provider health persistence

## Status

Accepted for PE-010.

## Context

PE-009 produces awaited, bounded, closed provider-health results, but process
memory cannot support restart recovery or a later read-only administrative
view. The Phase-A audit also established that provider health must not reuse
recording storage, manager-public state, or Saucy's title-bearing Convex rows.

## Decision

Persistence is optional and enabled only by the single startup setting
`CINEPRO_PROVIDER_HEALTH_DIR`. CinePro owns that fixed directory; no request,
provider, or media input can select a path. The directory and its `history`
child are mode `0700`; snapshots and event files are mode `0600`. Existing
symlinks and non-regular artifacts are rejected.

The public `snapshot.v1.json` contract has exactly these top-level fields:
`schemaVersion`, `generation`, `generatedAt`, `window`, `latest`, and
`history`. Both result arrays contain only revalidated PE-009 fields. Unknown
fields are never serialized, and a persisted snapshot containing unknown
fields is rejected in full. Identifiers, stable codes, release fields,
timestamps, durations, subjects, arrays, event lines, the snapshot, and total
history all have hard bounds. Snapshot history retains at most 1,000 recent
events inside seven days relative to snapshot generation; snapshots violating
that age bound are rejected at startup. Disk history rotation retains at most
12 total replayable segments, including `events.current.jsonl`.

Every refresh persistence operation joins one in-process serialization queue.
Accepted events are split across segments as necessary and appended to
`history/events.current.jsonl`, followed by `fdatasync`. No segment may exceed
4 MiB or 10,000 lines, including when one accepted refresh batch crosses a
boundary. Creation and rotation fsync the history directory. Snapshot
publication uses a unique same-directory `O_EXCL`/no-follow temporary file,
file `fsync`, atomic rename, and directory `fsync`. The prior snapshot is
copied to `snapshot.v1.backup.json` only after descriptor-based read and full
schema/clock validation; backup replacement itself uses an fsynced temporary,
atomic rename, and directory fsync. Both publication paths retain the written
temporary inode identity and recheck the path against it immediately before
rename, rejecting a replaced temporary entry.

Startup removes only exact matching snapshot temp artifacts older than one
hour. It attempts the current snapshot, then the compatible backup, then a
bounded replay of exact history filenames. Recovery always atomically repairs
the fixed public snapshot before initialization succeeds. One truncated final
line in the current history is ignored; other corrupt segments are renamed
individually without copying any prefix from that segment into state.
Replay first enforces the same 12-segment retained set and then reads that
complete set.
Supported artifacts are opened with no-follow semantics, validated with
`fstat`, and read through the same descriptor; identity is rechecked before a
path-based quarantine or rotation rename. Unsupported, oversized, corrupt,
symlinked, or non-regular data is never partially trusted.

Generations are non-negative safe integers. Snapshot generation and event
clocks cannot be in the future; `window.to` equals `generatedAt`, and
`window.from` equals the oldest retained history event (or `generatedAt` for
empty history). A recovered store remains writable and reports `ready` with
`failureCode: "STORE_CORRUPT"` for the lifetime of that initialization so an
operator can observe the recovery.

The provider-health control awaits persistence after a successful awaited
refresh. Storage errors do not change provider results or fail source
resolution. They are represented only by the fixed sanitized persistence
state:

```ts
{ enabled: false, status: "disabled" }
{ enabled: true, status: "ready" }
{ enabled: true, status: "ready", failureCode: "STORE_CORRUPT" }
{ enabled: true, status: "unavailable", failureCode: "STORE_UNAVAILABLE" }
```

No URL, header, token, cookie, title, media identity, watch history, raw error,
stack, or unbounded identifier is accepted into either snapshot or history.

## Consequences

Operators must provision and back up the dedicated directory separately from
application releases. With mode `0700`/`0600`, a later Saucy read-only mount
requires an explicit deployment-level identity or permission design; PE-010
does not weaken ownership to anticipate PE-011. Persistence may be repaired
or disabled independently while in-memory health continues to operate.

No Saucy API/UI, Compose mount, provider/media/network call, scheduler, or
recheck route is introduced by this decision.

## Alternatives considered

- Recording or manager-public storage was rejected because it crosses audited
  trust boundaries and lifecycle ownership.
- Request-selectable snapshot paths were rejected because they create a file
  traversal boundary.
- Treating persistence as mandatory was rejected because an optional
  observability store must not take provider resolution offline.
- Persisting raw PE-009 objects without revalidation was rejected because
  future or untrusted adapters could reintroduce sensitive fields.

## Rollback and recovery

Unset `CINEPRO_PROVIDER_HEALTH_DIR` to return to memory-only PE-009 behavior.
Retain the directory during rollback. Older code can ignore it, and future
schema versions must use new versioned filenames rather than destructively
downgrading `snapshot.v1.json`.
