# Marketplace Legacy Preference Retirement and Credential Healing Design

**Date:** 2026-08-10
**Status:** Amended — approved 2026-08-10; implemented and verified locally (evidence in the corrections work item)
**Scope:** Local `dev` release-prework for upstream base `v0.446.6`

## Context

The Marketplace skill-package work moved per-agent opt-outs from the legacy
control-plane map (`activations.agentSkillOverrides`) to agent configuration
(`skills.marketplace_overrides`). Agent configuration is the documented
user-facing source of truth: an absent override means an installed skill is
enabled by default.

The handed-off candidate attempted to preserve a migration-completion signal by
rewriting the legacy record to `{ enabled: false, migrated: true }`. That is not
safe because existing control-plane activation readers still interpret that
object as an active disabled override. A user can remove the config tombstone
yet still have the runtime activation API report the skill disabled. The
candidate also reads and writes the complete activation map once per legacy
entry, so a concurrent control-plane mutation can be overwritten.

The same candidate added a startup custody pass for source-qualified plugin
configuration and secrets files. Its raw two-level directory walk treats any
`plugin-data/<name>/<name>/config.json` as Marketplace-owned. That overlaps
explicitly excluded runtime state such as `plugin-data/office/jobs`,
`plugin-data/office/generated`, and `plugin-data/mcp`. It also follows root or
intermediate symlinks and can apply file mode to a directory named
`config.json` or `secrets.json`.

This design corrects both regressions without expanding into a generic
filesystem permission sweep, changing Marketplace UI semantics, or performing
any GitHub, deployment, or release mutation.

## Goals

1. Preserve an explicit legacy opt-out exactly once in agent configuration,
   while ensuring a later user enable remains enabled across Skills reloads.
2. Retire only the exact migrated legacy activation entries, atomically and
   without overwriting unrelated control-plane changes.
3. Heal only credential files belonging to known source-qualified Marketplace
   plugin identities, without traversing arbitrary plugin runtime data.
4. Never follow symlinks or chmod non-regular credential-file targets.
5. Bring the entire dedicated `plugin-secrets` credential path to owner-only
   directory mode while retaining existing bare-plugin config healing.
6. Add regression tests for the failure and concurrency boundaries, then run
   the required release-prework validation layers.

## Non-goals

- No change to the normal Marketplace package activation model, source gates,
  native plugin access, or user-visible Settings schema.
- No recursive chmod of `plugin-data`, arbitrary plugin data, jobs, generated
  output, MCP state, or plugin runtime payloads.
- No migration of unqualified legacy plugin data paths.
- No push, tag, release, dashboard refresh, deployment, `sg01` contact, or
  GitHub issue/PR/discussion mutation.
- No attempt to repair unrelated full-suite/typecheck baseline failures as part
  of these two behavioral fixes.

## Alternatives Considered

### A. Config metadata plus atomic exact retirement — selected

Persist the active disabled preference and a small opaque migration-completion
record together in the agent configuration. The completion record is not an
activation input. After that durable write succeeds, submit all exact legacy
references to one registry-owned atomic retirement operation that deletes only
still-eligible legacy false entries.

This keeps configuration as the only active per-agent preference source,
survives a registry-write failure followed by a user re-enable, and avoids
teaching every activation consumer about a compatibility marker.

### B. Leave `{ enabled: false, migrated: true }` in the legacy map

Every existing and future control-plane reader would have to ignore the marker,
including activation, source-reference accounting, cleanup, and diagnostics.
That creates a second semantic representation of an opt-out in a live map and
is easy to miss when new consumers are added. It is rejected.

### C. Infer Marketplace credential ownership from directory depth

An exact two-level walk is smaller initially, but a valid-looking directory is
not proof of Marketplace ownership. The persistence registry already documents
collisions under `plugin-data`; a depth-based scan will silently expand again
as future stores are added. It is rejected.

## Approved Design

### 1. Legacy preference migration

`skills.marketplace_overrides` remains the sole source of active per-agent
Marketplace skill preferences. Add
`skills.marketplace_legacy_skill_migrations`, a normalized sorted object whose
strict source-qualified legacy skill-ref keys have the literal value `true`.
For example:

```yaml
skills:
  marketplace_legacy_skill_migrations:
    wiki-query@llm-wiki/skillwiki: true
```

It is private migration metadata only: skill activation, Settings
serialization, and the package gate must not read it as an opt-out.

For each known currently present Marketplace skill membership:

1. Parse the legacy ref strictly and consider only an explicit legacy disabled
   record. Malformed, unknown, global, source-mismatched, and enabled records
   remain untouched.
2. If completion metadata is absent, construct the next agent config by adding
   the disabled tombstone and the completion ref in the same `updateConfig`
   persistence operation.
3. If the tombstone already exists from a prior build but completion metadata
   is absent, persist the completion metadata before retirement; do not create
   a duplicate tombstone.
4. If completion metadata already exists, never re-add a tombstone. This is
   what protects a deliberate user re-enable if a prior registry retirement
   did not complete.
5. Only after the agent config persistence succeeds, return the exact legacy
   reference as a retirement candidate. A config write failure returns no
   candidate for that agent and leaves the legacy record intact for retry.

The pure migration helper must return candidates; it must not expose an
optional caller callback that claims a reference was consumed when no
retirement happened. A result distinguishes successful config writes, eligible
retirement candidates, and actual retired references.

The engine passes the complete candidate batch to a dedicated
`PluginMarketplaceService`/registry migration operation. That operation owns
the mutable control-plane schema and, while holding the registry lock, reloads
the durable file, removes only matching explicit false records for the supplied
`agentId + legacyRef` pairs, prunes empty agent override maps, and writes at
most once. It must not replace a full stale activation snapshot, must not add a
`migrated` marker, and must leave unrelated sibling records unchanged. Its
result reports only records actually removed.

The operation is an internal startup migration, not a user-driven Studio
control-plane write. It therefore uses the registry's lock-and-reload
transform rather than a stale externally supplied revision/digest snapshot.
Existing user-facing control-plane writes retain their revision/digest and
owner checks.

For compatibility with a local uncommitted candidate state, a legacy object
that already carries `{ enabled: false, migrated: true }` is recognized only
as an obsolete completion signal. The migration first persists the opaque
configuration completion metadata without restoring a disabled tombstone, then
removes that obsolete legacy object through the same atomic operation. This is
not a new durable runtime representation.

When the corresponding source-qualified package is fully uninstalled, remove
both its active preference tombstones and its migration-completion metadata.
The normal uninstall path already removes matching legacy activation records;
this keeps the private metadata bounded and makes a later independent install
start cleanly.

### 2. Source-qualified credential healing

The startup healer keeps its existing direct legacy pass for
`plugin-data/<pluginId>/config.json`. It does not use that pass for
source-qualified Marketplace paths.

Add a narrow identity enumerator owned by Marketplace install records. It
returns deduplicated, validated `{ marketplaceId, pluginId }` pairs for
source-qualified active and retained Marketplace installs, skipping the
unqualified legacy sentinel and malformed entries. The healer uses the shared
`marketplacePluginDataDir` and `marketplacePluginSecretsDir` builders for each
identity rather than constructing path segments from arbitrary directory names.

For every known identity, the healer considers only:

```text
plugin-data/<marketplaceId>/<pluginId>/config.json
plugin-secrets/<marketplaceId>/<pluginId>/secrets.json
```

It first verifies every existing root and intermediate component with `lstat`:
each must be a real directory and not a symlink. It verifies the final target
is a real regular file and not a symlink before applying file mode. Missing,
unreadable, symlinked, or non-regular targets are skipped and never followed.

For the dedicated `plugin-secrets` tree only, the healer tightens the root,
recognized Marketplace parent, and recognized plugin directory to `0700`, and
tightens `secrets.json` to `0600`. It does not recurse beneath those directories.
`config.json` is tightened to `0600`, but its `plugin-data` parent directories
are not chmod'd because that tree also contains non-secret runtime data.

Export the public/secrets filenames and root directory names from the
plugin-config storage owner so the writer, PluginManager, engine, routes, and
healer share the same layout constants. The implementation may use one private
parameterized safe-target helper to keep the source-qualified config and secret
checks identical; it must not turn into a generic tree walker.

### Data flow

```text
legacy false record + known installed skill
  -> atomically persist config tombstone + completion metadata
  -> enqueue exact legacy reference
  -> registry lock/reload/transform once
  -> remove exact legacy record
  -> config remains the sole active preference source

user enables the skill later
  -> removes only config tombstone
  -> durable completion metadata prevents legacy re-migration
  -> no legacy activation record remains
  -> runtime activation resolves enabled by default

install records
  -> validated source-qualified identity pairs
  -> canonical config/secrets paths
  -> lstat real-directory / real-regular-file guards
  -> credential-only chmod operations
```

## Error Handling and Compatibility

- Agent-config persistence failure is diagnostic-only for startup and leaves
  every candidate legacy record untouched, so the next pass can retry safely.
- Registry retirement failure is diagnostic-only after config persistence. The
  durable completion metadata prevents a later user enable from being undone;
  the next pass retries exact retirement.
- A missing/corrupt Marketplace install-record file produces no
  source-qualified credential targets, rather than falling back to arbitrary
  filesystem discovery. Existing top-level, agent, secret-tree, and bare
  plugin-config healing remains available.
- All security-path failures are reported through the existing healer result
  and error-bus conventions without blocking application startup.
- No active code path treats migration metadata or an obsolete `migrated:true`
  legacy object as an enabled/disabled activation request.

## Testing and Verification

### Migration regression coverage

1. Legacy disabled record → migration → user enable → Skills reload results in
   an enabled package gate **and** `getMarketplaceSkillActivation(..., { agentId
   })` reporting enabled.
2. A config write failure retains every matching legacy record and writes no
   completion metadata or partial retirement.
3. Existing tombstone without metadata gains metadata then retires the exact
   legacy record without adding a duplicate preference.
4. Completion metadata prevents re-migration after a user enable even when a
   previous registry retirement failed.
5. Atomic batch retirement preserves sibling agent overrides, unrelated
   activation categories, and a contemporaneous control-plane mutation.
6. An obsolete local `{ enabled: false, migrated: true }` candidate record is
   converted to config metadata and removed without disabling a re-enabled
   skill.
7. Full source-qualified package uninstall removes the matching preference and
   completion metadata only.

### Credential-healer regression coverage

1. A known Marketplace record causes its exact public `config.json` and
   `secrets.json` to become `0600`; the secrets root, source, and plugin
   directories become `0700`.
2. Existing bare `plugin-data/<pluginId>/config.json` healing remains intact.
3. `plugin-data/office/jobs/config.json`,
   `plugin-data/office/generated/config.json`, and
   `plugin-data/mcp/<runtime-child>/config.json` retain their original modes.
   The existing bare `plugin-data/mcp/config.json` is an independently owned
   MCP credential config and remains covered by the established direct
   bare-plugin config pass.
4. Marketplace-looking but unregistered directory pairs retain their original
   modes; no raw depth-based fallback is allowed.
5. Data/secrets root, source, plugin, and final-file symlinks are skipped;
   external targets retain their original modes.
6. Directories named `config.json` or `secrets.json` are skipped rather than
   chmod'd as files. Unrelated files beneath recognized data directories also
   retain their modes.
7. The secret-file custody static census continues to recognize the correct
   writer and healer responsibility, without a vacuous string-only test.

### Required validation after implementation

- Run the focused migration, engine, credential-healer, secret-custody,
  Marketplace, persistence, and release-receipt test suites.
- Run `git diff --check`, generated receipt validators, the offline
  GitHub-mutation guard test, and the required simplification review.
- Re-run `node scripts/sync-upstream.mjs --post-rebase`.
- Diagnose the existing local dependency/typecheck/full-suite baseline before
  calling release prework complete.
- Only after all automated gates are clean, rebuild/install locally with the
  established non-notarized workflow and perform the Tier 3A local smoke.

## Acceptance Criteria

- Re-enabling a migrated Marketplace skill stays enabled across a reload in
  both config-driven and legacy activation APIs.
- No live `migrated:true` legacy record remains after successful retirement.
- A registry mutation during migration cannot lose unrelated activation state.
- Only known source-qualified Marketplace credential files receive the new
  source-qualified custody treatment.
- No excluded runtime store, symlink target, directory target, or unrelated
  neighbor has its mode changed.
- All newly added regression tests fail against the handed-off candidate and
  pass against the corrected implementation.
- Repository docs and the active SkillWiki release work item record the actual
  post-validation outcome before any publication authority is considered.
