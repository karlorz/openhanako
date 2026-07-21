# Pick-from-main decisions (2026-07-21)

> **Machine-readable source of truth:** `docs/fork-sync/pick-from-main-decisions.yml`
> (loaded by `scripts/sync-upstream.mjs`). Keep this human table aligned when editing.

Baseline (updated 2026-07-21 after attended prerelease channel): `dev` rebased onto
upstream GitHub prerelease **`train-13`**, package **`0.412.7`**. Latest stable
upstream remains `v0.407.15`. Dashboard pick-from-main still forbids cosmetic
force-adopt; residual PR #1 conflicts are expected under permanent-fork dual-profile.
Pre-rebase backup: `backup/dev-before-prerelease-train-13-20260721` @ `611fd08d`.

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
| `package.json` | defer-to-stable-production-sync | **wait-stable** | Version `0.407.15` vs main `0.415.15` — no dashboard pre-bump |
| `package-lock.json` | (paired with package) | **wait-stable** | Same as package.json |
| `release-digest.v1.json` | take-main | **wait-stable** | Prerelease digest for `v0.415.15` — policy forbids early copy into dev |
| `release-digest.v2.json` | take-main | **wait-stable** | Same prerelease digest family |
| `scripts/build-server.mjs` | preserve-both | **preserve-fork** | Compatibility-manifest / build-info packaging |
| `scripts/fix-modules.cjs` | take-main | **wait-stable** | Fork carries explicit legacy-raw validation path required by dual-profile |
| `server/index.ts` | preserve-both | **preserve-fork** | Feature contracts / build-info advertisement |
| `tests/build-server-artifact.test.ts` | take-main | **wait-stable** | Trial adopt failed against fork `build-server-artifact.mjs` API (e.g. `seedManifestFileName`) |

## Adopt-now set

**Empty.** No path is safe to pick from main tip without either (a) importing prerelease release identity, (b) breaking legacy-raw dual-profile, or (c) pulling an incomplete module graph from the train.

## Expected residual conflicts

Still **16** until attended stable production sync onto a published non-prerelease newer than `v0.407.15`, at which point take-main packaging noise can land with the full package version alignment.

## PR #1

Remains OPEN draft, mergeable CONFLICTING by design. Success is this decision table + truthful outlook, not a green merge.
