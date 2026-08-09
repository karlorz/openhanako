# Pick-from-main decisions (2026-08-10)

> **Machine-readable source of truth:** `docs/fork-sync/pick-from-main-decisions.yml`
> (loaded by `scripts/sync-upstream.mjs`). Keep this human table aligned when editing.

Baseline (updated 2026-08-10 after the attended stable rebase): local `dev`
contains stable **`v0.446.6`**, package **`0.446.6`**, at upstream SHA
`5f08a4f30203abb61dafac7dbb7ab92d11c23efa`. Dashboard pick-from-main still
forbids cosmetic force-adopt. The local-only plan is conflict-free, but its
remote comparison still sees stale unpublished `origin/dev`; that is a
publication opportunity, not a remaining rebase.
Pre-rebase backup: `backup/dev-before-stable-v0.446.6-20260810` @ `95b23b08`.

## Objective honesty

| Wish | Decision |
|------|----------|
| 0 conflicts | Observed in the local-only plan; it does not authorize a dashboard write or remove the permanent-fork policy |
| Green/mergeable PR #1 | **Forbidden** — permanent draft dashboard; never merge/auto-merge/close as merge vehicle |
| Pick from main tip | **Allowed only** for policy-safe take-main paths that do not import prerelease digests/package version or break fork dual-profile |

## Path decisions

| Path | Planner strategy | Decision | Reason |
|------|------------------|----------|--------|
| `.github/workflows/build.yml` | preserve-both | **preserve-fork** | Dual signed/legacy-raw release profile is permanent fork ops |
| `build/cli-runtime-closure.json` | take-main | **wait-stable** | Generated census tracks open-composition/main tip graph; current tree fails tripwire if force-adopted without full train rebase |
| `build/installer.nsh` | take-main | **wait-stable** | Main is seed-only verify; fork still needs legacy-raw surface checks for dual-profile installs |
| `build/persistence-schema-fingerprint.json` | take-main | **wait-stable** | Fingerprint of main-era schema; adopt breaks tripwire without whole-tree migration |
| `build/persistence-store-inventory.json` | take-main | **wait-stable** | Same as fingerprint — census of main tip stores |
| `core/engine.ts` | preserve-both | **preserve-fork** | Remote feature-contract advertisement / fork server compatibility |
| `core/session-turn-actions.ts` | take-main | **wait-stable** | Trial adopt from main failed: imports missing `session-operation-lock.ts` and other main-only modules — requires full train package, not single-file pick |
| `desktop/main.cjs` | human-review | **preserve-fork** | Probe + dual-profile boot orchestration; already isolated helpers |
| `desktop/src/shared/launch-integrity.cjs` | take-main | **wait-stable** | Main is seed-only; fork retains legacy-raw install surface validation |
| `package.json` | defer-to-stable-production-sync | **wait-stable** | Upstream-owned package **`0.446.6`** after the completed stable rebase; dashboard must not write or pre-bump toward a later main tip for cosmetics — further package identity only via attended sync/release |
| `package-lock.json` | (paired with package) | **wait-stable** | Same as package.json |
| `release-digest.v1.json` | take-main | **wait-stable** | Keep the attended `v0.446.6` digest; policy forbids copying a later unreleased main digest into dev |
| `release-digest.v2.json` | take-main | **wait-stable** | Keep v2 aligned with `v0.446.6`; same stable digest-family policy |
| `scripts/build-server.mjs` | preserve-both | **preserve-fork** | Compatibility-manifest / build-info packaging |
| `scripts/fix-modules.cjs` | take-main | **wait-stable** | Fork carries explicit legacy-raw validation path required by dual-profile |
| `server/index.ts` | preserve-both | **preserve-fork** | Feature contracts / build-info advertisement |
| `tests/build-server-artifact.test.ts` | take-main | **wait-stable** | Trial adopt failed against fork `build-server-artifact.mjs` API (e.g. `seedManifestFileName`) |

## Adopt-now set

**Empty.** No path is safe to pick from main tip without either (a) importing prerelease release identity, (b) breaking legacy-raw dual-profile, or (c) pulling an incomplete module graph from the train.

## Expected residual conflicts

The completed `v0.446.6` rebase currently has zero conflicts in
`--conflict-plan --json --local-only`, which reports
`stableSyncAvailable: false` and `prUpdated: false`. `origin/dev` remains
unpublished, but that is a fork-publication concern—not another local rebase.
Dashboard paths remain protected from cosmetic force-adoption; the next
**stable** production sync waits for a published non-prerelease newer than
`v0.446.6`.

## PR #1

Remains OPEN draft and never-merge. Its live mergeability is diagnostic only;
success is this decision table plus a truthful outlook, not merging the branch.
