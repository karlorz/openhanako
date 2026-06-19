# OpenHanako Dev-Loop Setup Notes

Generated during the 2026-06-15 remote attachment preview fix closeout.

## Discovery

- Repo: `karlorz/openhanako`
- Upstream: `liliMozi/openhanako`
- Current branch: `dev`
- GitHub CLI default repo: `karlorz/openhanako`
- App version: `0.323.0`
- SkillWiki vault: resolved by `skillwiki path`; project wiki path `projects/openhanako`
- SkillWiki doctor: 32 pass, 1 warn, 0 errors
- Dev-loop dependency probe: usable; required dependencies present
- Missing optional dependency: `claude-mem` only
- Existing CI: `.github/workflows/ci.yml`, targets `main` and `dev`
- Release workflow: `.github/workflows/build.yml`, tag-triggered `v*`
- Upstream sync workflow: `node scripts/sync-upstream.mjs --check` checks stable upstream releases by default; prerelease candidate review requires `--include-prerelease`
- Fork sync rules: `docs/fork-sync/rules.yml` is the machine-readable policy used by `scripts/sync-upstream.mjs`.
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
  - `scripts/sync-upstream.mjs`
  - `scripts/track-upstream-issues.mjs`
  - `docs/upstream-issues/**`
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
- CI health: no recent GitHub Actions runs exist on `dev` yet after adding the branch trigger, so the workflow is configured but not proven by a post-change run.
- Upstream release check: `v0.324.0` is a GitHub prerelease. The sync helper ignores prereleases by default and reports the fork up to date at the `v0.323.0` stable baseline; `--include-prerelease --check` is the explicit prerelease review path.
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
