# OpenHanako Dev-Loop Setup Notes

Generated during the 2026-06-15 remote attachment preview fix closeout. Last revised during the 2026-06-28 closeout for the stable sync to upstream `v0.346.18`.

## Discovery

- Repo: `karlorz/openhanako`
- Upstream: `liliMozi/openhanako`
- Current branch: `dev`
- GitHub CLI default repo: `karlorz/openhanako`
- App version: `0.346.18` after the stable sync rebase. Tier 3A local desktop install/version verification and Tier 3B sg01 desktop smoke passed on 2026-06-27 before the fork release tag was published.
- SkillWiki vault: resolved by `skillwiki path`; project wiki path `projects/openhanako`
- SkillWiki doctor: 32 pass, 6 info, 0 warn, 0 errors
- Dev-loop dependency probe: usable; required dependencies present
- Missing optional dependency: `claude-mem` only
- Existing CI: `.github/workflows/ci.yml`, targets `main` and `dev`
- Release workflow: `.github/workflows/build.yml`, tag-triggered `v*`
- Latest fork release tag: `v0.346.18-karlorz.1`; GitHub Actions run `28293195697` completed successfully and published 20 release assets.
- Upstream sync workflow: `node scripts/sync-upstream.mjs --check` checks stable upstream releases by default; prerelease candidate review requires `--include-prerelease`
- Fork sync rules: `docs/fork-sync/rules.yml` is the machine-readable policy used by `scripts/sync-upstream.mjs`.
- Post-rebase fork sync verification: `node scripts/sync-upstream.mjs --post-rebase` prints Tier 3A local desktop install/version verification before Tier 3B sg01 live smoke. The installed `/Applications/HanaAgent.app` bundle metadata, `build-info.json`, and Settings → About must match `package.json` before the live smoke counts.
- Tier 3B helper: `node scripts/hana-desktop-smoke-helper.mjs --restart --verify --url http://100.125.173.118:14500` restarts HanaAgent with Chromium remote debugging, clears renderer `localStorage`, restores only the saved LAN connection registry, reloads, then verifies token-auth identity fetch plus WebSocket open from the renderer. If no saved connection exists, prefer `HANA_DESKTOP_SMOKE_TOKEN=<device-key>` for the first helper run; `--token` is available for one-off local use but can leak through shell history or process listings. The helper must not print device tokens.
- Web framework: Vite + React + Electron
- Browser verification capability: `playwright-cli` plugin present
- Deep research capability: `deep-research` plugin present
- Codex companion: available and authenticated; optional second reviewer kept disabled by default

## Recommended Dev-Loop Defaults

- `prd_layer`: `superpowers`
- `knowledge_layer`: `skillwiki`
- `release_branch`: `dev`
- `publish_via`: `ci-tag-trigger`
- `remote_hosts`: empty for unattended loops; server install/upgrade remains manual via `scripts/install-server.mjs`
- `interview_backend`: `grill-me`
- `interview_trigger`: `auto`
- External memory: none for now; do not add a `memory_layer` field to dev-loop config because v1.24.7 does not parse it.
- PR safety: PR #1 is a permanent draft dashboard from `dev` to `main`; never merge it, never enable auto-merge for it, and never treat `main` as the dev-loop release branch.
- Rebased branch publication: attended stable syncs may require `git push --force-with-lease origin dev` after all docs/wiki closeout and release checks are complete, because local `dev` is intentionally rebased onto the upstream stable tag.
- `fact_check`: local repo + SkillWiki + web when available
- `browser_verification`: enable for renderer/UI changes with Vite/Electron smoke
- `reactive_debugging`: enable with 2 retries and captured evidence
- `code_review.codex`: disabled in normal/high by default to avoid surprise cost

## Critical Paths

- `lan_connect_auth`
  - `core/server-auth.ts`
  - `desktop/src/react/services/server-connection.ts`
  - `desktop/main.cjs`
  - `desktop/preload.cjs`
- `remote_attachment_preview`
  - `desktop/src/modules/connection-csp.js`
  - `desktop/src/react/MainContent.tsx`
  - `desktop/src/react/components/InputArea.tsx`
  - `desktop/src/react/services/resource-url.ts`
  - `desktop/src/react/utils/user-attachment-media.ts`
  - `desktop/src/react/stores/chat-slice.ts`
  - `desktop/src/react/stores/selectors/file-refs.ts`
  - `server/routes/upload.ts`
- `desktop_packaging`
  - `package.json`
  - `scripts/build-server.mjs`
  - `scripts/sign-local.cjs`
  - `.github/workflows/build.yml`
  - `.github/workflows/ci.yml`
- `fork_sync_maintenance`
  - `FORK_SYNC.md`
  - `docs/fork-sync/rules.yml`
  - `scripts/hana-desktop-smoke-helper.mjs`
  - `scripts/sync-upstream.mjs`
  - `scripts/track-upstream-issues.mjs`
  - `docs/upstream-issues/**`
  - `tests/hana-desktop-smoke-helper.test.mjs`
  - `tests/sync-upstream.test.mjs`
  - `tests/upstream-issue-tracker.test.mjs`
- `install_server_maintenance`
  - `scripts/install-server.mjs`
  - `tests/install-server-upgrade.test.mjs`
  - `docs/server-install.md`
  - `docs/reinit-data-failsafe.md`

## Grill-Me Decision

The fork policy says the working/default branch is `dev`, so `.github/workflows/ci.yml` now runs on both `main` and `dev`.

Decision: **yes, add `dev` to CI triggers** because dev-loop will operate on `dev`. Branch protection remains manual until the repo owner chooses to enable it.

Decision update 2026-06-20: PR #1 is protected review infrastructure, not a dev-loop merge PR. `release_branch` stays `dev`; `origin/main` may mirror `upstream/main` for the conflict dashboard only; dashboard refresh must use `node scripts/sync-upstream.mjs --conflict-plan` and must not merge, rebase, reset, stage, or write `dev`.

## Dev-Loop Cycle Audit

Ran a manual core `/dev-loop` cycle audit on 2026-06-15 after the remote preview fix was confirmed in the desktop app.

- Work inventory: no claimable OpenHanako work remains. The two existing work items are `completed`, and `/dev-loop prep --all` reports zero candidates.
- Config schema: `.claude/dev-loop.config.md` now uses the current dev-loop v1.24.5 fields for `knowledge_backends.skillwiki.vault`, `interview.work_item`, `ci_configured`, `ci_discovery`, and `required_checks`.
- Required backend caps: SkillWiki config explicitly includes `save_retro` and `drift_check`, so future cycles do not fall back to local retros or skip drift checks by accident.
- Browser gate: the prerequisite now checks the default Vite URL or `HANA_BROWSER_VERIFY_URL`; it no longer fails just because the env var is unset.
- Vault sync caveat: installed SkillWiki v0.9.4 exposes `skillwiki sync lock/unlock`, while dev-loop v1.24.4 probes for the older `--acquire-lock` flag. `vault_sync.peer_aware` is set to `false` until that probe is updated; launchd vault-sync remains active outside dev-loop.
- Doctor caveat: `skillwiki doctor` reports `32 pass`, `1 warn`, `0 errors`, but exits non-zero with the warning. Treat the JSON summary as authoritative for blocking decisions, not the exit code alone.
- GitHub CLI caveat: plain `gh repo view` initially resolved to upstream `liliMozi/openhanako`. Ran `gh repo set-default karlorz/openhanako`; future CI/PR checks should still prefer explicit `--repo karlorz/openhanako` when scripted.
- CI health: the `dev` branch trigger is proven by the 2026-06-27 UTC post-force-push runs for docs closeout commit `7628f54f`: push run `28295481409` and PR dashboard run `28295481912` both completed successfully on macOS and Windows.
- Upstream release check: the 2026-06-27 stable sync rebased local `dev` from the `v0.345.3` baseline onto upstream `v0.346.18`. `node scripts/sync-upstream.mjs` and `node scripts/sync-upstream.mjs --post-rebase` passed Tier 0 through Tier 2. Tier 3A local desktop install/version verification and Tier 3B sg01 desktop live smoke both passed. `--include-prerelease --check` remains only for explicit prerelease candidate review.
- Codex cache caveat: dev-loop's cached skill copy references `skills/dev-loop/scripts/preflight-inventory.js`, but the Codex plugin package currently stores that helper at plugin root `scripts/preflight-inventory.js`. Use the plugin-root script as the fallback until the packaging layout is repaired upstream.

## Claude Review Follow-Up

Claude Code review found that the remote preview implementation was orphaned from active work tracking. The fix is now represented by `projects/openhanako/work/2026-06-15-remote-attachment-preview-closeout/`, marked completed because the behavior was already implemented and verified before this audit.

Config cleanup performed after the review:

- Removed unparsed top-level `memory_layer`, duplicate `ci:` block, and extra `interview.work_item.default/source` fields.
- Moved custom repo/context metadata under `notes`.
- Set `remote_hosts: []`; `deploy_script` stays unset so unattended dev-loop cycles do not deploy hosts. Server operations use `scripts/install-server.mjs` / `docs/server-install.md`.
- Added `CLAUDE.md` so AUDIT and DEPLOY fallback discovery have a repo-local operating guide.
- Retired the local sg01 SSH deploy helper after `install-server` coverage existed for install, upgrade, and status planning.
- Patched the local dev-loop skill source/cache to document manual fallback when worker Agent spawn fails before returning JSON.
- Repaired the active Codex dev-loop cache so `skills/dev-loop/references/codex-tools.md` exists at the skill-relative path used by `SKILL.md`; patched the cache sync helper to preserve that path on future syncs.

## Post-Cycle Tuning

After the 2026-06-16 maintenance cycle, the compact config now treats fork-sync and install-server as the two automation-ready maintenance paths. The old shell sync helper and sg01 deploy helper are retired; unattended dev-loop runs should test and review these paths but never push, pull, deploy, or target `sg01` unless a later attended release explicitly changes the config.

## Stable Sync Closeout - 2026-06-28

- Sync target: upstream stable `v0.346.18`; previous fork baseline was `v0.345.3`.
- Rule update required: `docs/fork-sync/rules.yml` now marks `desktop/src/react/services/resource-url.ts` as critical and requires the fork LAN transport invariant `!connection || connection.kind === 'local'`.
- Semantic regression fixed post-rebase: upstream's owner-only local transport predicate was replaced with the fork LAN-safe predicate, with focused regression coverage in `desktop/src/react/__tests__/services/resource-url.test.ts`.
- Release tag: `v0.346.18-karlorz.1`; release workflow run `28293195697` completed successfully, then published the prerelease with 20 assets.
- Release assets verified by CI: macOS arm64/x64 DMG and ZIP, Windows x64 EXE, Linux AppImage and deb, `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, and all five server bundles with `.sha256` sidecars.
- Post-force-push CI: docs closeout commit `7628f54f` completed successfully on push run `28295481409` and permanent dashboard PR run `28295481912`, both covering macOS and Windows.
- Final sync check: `node scripts/sync-upstream.mjs --check` reports latest upstream tag and last synced tag both `v0.346.18`.
- Permanent dashboard PR #1 remained open, draft, and unmerged.
