# Pick-from-main decisions (2026-07-28)

> **Machine-readable source of truth:** `docs/fork-sync/pick-from-main-decisions.yml`
> (loaded by `scripts/sync-upstream.mjs`). Keep this human table aligned when editing.

Baseline (updated 2026-07-28 after the attended stable sync): `dev` rebased
onto stable **`v0.421.24`**, package **`0.421.24`**, at upstream SHA
`e87769a070d12803247e5cc619dacf5814fe1f52`. Dashboard pick-from-main still forbids cosmetic
force-adopt; residual PR #1 conflicts are expected under permanent-fork dual-profile.
Pre-rebase backup: `backup/dev-before-stable-v0.421.24-20260728` @ `a21ffcb5`.

## Objective honesty

| Wish | Decision |
|------|----------|
| 0 conflicts | **Infeasible now** without abandoning permanent fork product or rebasing onto prerelease main |
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
| `package.json` | defer-to-stable-production-sync | **wait-stable** | Live package **`0.421.24`** after the attended stable sync; dashboard must not pre-bump toward an unreleased main tip for cosmetics — further package identity only via attended sync/release |
| `package-lock.json` | (paired with package) | **wait-stable** | Same as package.json |
| `release-digest.v1.json` | take-main | **wait-stable** | Keep the attended `v0.421.24` digest; policy forbids copying a later unreleased main digest into dev |
| `release-digest.v2.json` | take-main | **wait-stable** | Keep v2 aligned with `v0.421.24`; same stable digest-family policy |
| `scripts/build-server.mjs` | preserve-both | **preserve-fork** | Compatibility-manifest / build-info packaging |
| `scripts/fix-modules.cjs` | take-main | **wait-stable** | Fork carries explicit legacy-raw validation path required by dual-profile |
| `server/index.ts` | preserve-both | **preserve-fork** | Feature contracts / build-info advertisement |
| `tests/build-server-artifact.test.ts` | take-main | **wait-stable** | Trial adopt failed against fork `build-server-artifact.mjs` API (e.g. `seedManifestFileName`) |

## Adopt-now set

**Empty.** No path is safe to pick from main tip without either (a) importing prerelease release identity, (b) breaking legacy-raw dual-profile, or (c) pulling an incomplete module graph from the train.

## Expected residual conflicts

Dashboard may still list packaging/digest dual-profile paths as CONFLICTING after
`v0.421.24`. Residual conflict count is re-read from live `--conflict-plan`;
absolute zero conflicts remains infeasible without abandoning permanent-fork
dual-profile. The next **stable** production sync waits for a published
non-prerelease newer than `v0.421.24`.

## PR #1

Remains OPEN draft and never-merge. Its live mergeability is diagnostic only;
success is this decision table plus a truthful outlook, not merging the branch.
