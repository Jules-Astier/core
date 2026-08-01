# Provider catalog

`config/provider-catalog.yaml` is CinePro's version-controlled planning source
of truth for provider identity, classification, lifecycle, runtime discovery,
evidence, relationships, risks, and terminal dispositions. Runtime health is a
separate concern: an enabled runtime class is not automatically certified.

## Portable file format

The `.yaml` file deliberately contains JSON, which is a valid YAML 1.2
document. This JSON-compatible YAML convention lets the catalog tools use
Node.js `JSON.parse` and the standard library without adding or changing a
package dependency. Keep keys and strings JSON-quoted; YAML-only syntax is not
accepted.

`entryDefaults` makes planning-only rows concise. The loader expands each row
into the complete contract before validation or reporting. An entry override
wins over the default; an omitted `familyId` becomes the entry's own ID.
`config/provider-catalog.schema.json` describes the on-disk document, while the
validator enforces the expanded cross-entry and source-code constraints that
JSON Schema cannot express.

## Identity and aliases

Canonical IDs are lower-case kebab case and may contain one family separator:
`family` or `family:upstream`. Leading digits are significant. Runtime casing
is preserved in `runtime.runtimeId`; `CineSu`, `Icefy`, `Peachify`, and
`Videasy` also have exact `runtime-id` aliases.

Aliases normalize by lowercasing and mapping spaces/underscores to hyphens.
Upstream aliases must include a matching `scope`, so a shared name such as
`moviebox`, `vidlink`, `catflix`, or `lamda` can never become a global alias.
Embed hosts remain separate entries and relationships; mirror host names are
not provider aliases.

## Lifecycle and evidence

The release lifecycle is:

`discovered` → `researching` → `seed-needed` → `reproducible` →
`implementing` → `deterministic-pass` → `live-pass` → `saucy-pass` →
`browser-pass` → `canary` → `enabled`.

Released entries may move through `degraded`, `healing`, `broken`, and
`disabled`. Any pre-enable entry may become `deferred`, `rejected`, or
`retired`.

Advancing through the release states requires the corresponding entries in
`evidence.gates`. `enabled` additionally requires a deterministic fixture and
at least two authorized seed URLs. `rejected` requires `rejectionReason`;
`deferred` requires `deferReason`. Current runtime enablement is recorded under
`runtime.enabledDefault` and does not imply a lifecycle transition. Evidence
records public repository/manifest provenance, source files, authorized seed
URLs, review date, fixture location, and completed gates.

## Commands

Validate the catalog and its live filesystem discovery coverage:

```sh
node scripts/validate-provider-catalog.mjs
```

Regenerate or check the deterministic report:

```sh
node scripts/generate-provider-report.mjs
node scripts/generate-provider-report.mjs --check
```

The validator executes `config/provider-catalog.schema.json` with all errors
enabled, then enforces cross-entry, alias, lifecycle, and live source-tree
constraints. The committed report is
`docs/generated/provider-catalog-report.md`. It is
sorted by canonical ID and includes lifecycle, classification, capability,
runtime, health, family/leaf, risk, backlog, orphan, and code-absence views.

## Editing policy

- Never remove a candidate merely because it is deferred, rejected, retired,
  seed-needed, or classification-ambiguous.
- Add a scoped leaf for every code-visible aggregator upstream, including
  disabled and requested/handler-mismatch leaves.
- Preserve exact runtime IDs and source metadata; the validator reads
  `src/providers/**/*.ts` rather than trusting a registry constant.
- Regenerate the report and run `node --test test/provider-catalog.test.mjs`
  after every catalog or policy change.
