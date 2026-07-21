# OpenHanako Dev-Loop Setup Notes

Generated during the 2026-06-15 remote attachment preview fix closeout. Last revised during the 2026-07-21 attended prerelease-channel sync onto `train-13`.

## Discovery

- Repo: `karlorz/openhanako`
- Upstream: `liliMozi/openhanako`
- Current branch: `dev`
- GitHub CLI default repo: `karlorz/openhanako`
- App version: **`0.412.7`** after the attended optional prerelease-channel rebase onto upstream GitHub prerelease tag **`train-13`** (double consent). Prior stable base was `v0.407.15`; latest published fork release tag remains historical `v0.407.15-karlorz.7` until a new `-karlorz.N` is cut from this base.
- SkillWiki vault: resolved by `skillwiki path`; project wiki path `projects/openhanako`
- SkillWiki doctor: 32 pass, 6 info, 0 warn, 0 errors
- Dev-loop dependency probe: usable; required dependencies present
- Missing optional dependency: `claude-mem` only
- Existing CI: `.github/workflows/ci.yml`, targets `main` and `dev`
- Release workflow: `.github/workflows/build.yml`, tag-triggered `v*`
- Latest fork release tag (published): `v0.407.15-karlorz.7` on the prior stable package line; current `dev` package is **`0.412.7`** after `train-13` (LAN auth, scoped CSP, remote resource preview, dual-profile packaging, pick-from-main reclaim guards retained).
- Sync status (2026-07-21 post `train-13`): **lastSynced = `train-13`** (prerelease channel). Latest **stable** upstream remains `v0.407.15` (no newer non-prerelease). `--include-prerelease --check` is **up to date** on `train-13` (no longer a review-only ceiling waiting to sync). Bare `--check` still uses the stable channel by default and may report relative to `v0.407.15`. Further prerelease mutates still need `--i-accept-prerelease-sync` + `CONFIRM=<tag>`. Backup: `backup/dev-before-prerelease-train-13-20260721` @ `611fd08d`. PR #1 stays permanent draft never-merge. Tier 3A/3B still manual before deploy/tag.
- Upstream sync workflow: `node scripts/sync-upstream.mjs --check` checks stable upstream releases by default; prerelease candidate review uses `--include-prerelease --check`; prerelease **mutate** requires double consent (see `FORK_SYNC.md` optional prerelease channel)
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

## Remote prerequisite boundary

Remote assessment refresh is attended work. Set `WORK_ITEM_SPEC` to the
absolute candidate spec path, deliberately run the configured smoke command,
then run the offline checker. The checker reports `unknown` for absent,
invalid, or stale evidence and reads only the two paths supplied on its command
line. It does not use the network, SSH, keychain, renderer, localStorage, or
credentials, and it never contacts sg01 merely because prep is running.

Generic `/dev-loop prep` does not invoke this command. Automatic integration
requires a separate change and release in the dev-loop plugin source; never
apply an installed-cache patch. A `deployment-coupled` result must become
separate client, server, release, upgrade, and post-upgrade work rather than a
claim that the current host is ready.

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
- CI health: the `dev` branch trigger remains valid; release workflow run `29695065868` for tag `v0.407.15-karlorz.7` completed successfully and published the 20-asset legacy-raw prerelease surface (historical closeout on the prior stable line).
- Upstream release check: the 2026-07-18 stable sync rebased local `dev` onto upstream `v0.407.15`. On 2026-07-21 an attended **optional prerelease-channel** mutate rebased `dev` onto GitHub prerelease **`train-13`** (package **`0.412.7`**, lastSynced `train-13`). Stable detector still reports latest non-prerelease `v0.407.15` (no newer stable). PR #1 stays open draft never-merge. Default channel remains stable-only; further prerelease mutates need double consent.
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

## Fork Patch Closeout - 2026-06-30

- Patch target: `v0.346.18-karlorz.5` on branch `dev`; package version remains upstream-aligned at `0.346.18`.
- Reviewed commits: `4c82293b` fixed persisted marker-only image replay by preserving marker/path semantics instead of synthesizing direct provider image payloads; `b9d8a730` passed full session link context through ToolGroup file-detail links.
- Code-review follow-up: confirmed `client-user-*` UI ids now still use a valid persisted `sourceEntryId`; `hanaFetch` reads error response text once and extracts JSON or plain-text detail; session-meta sidecar traversal refs are covered by regression tests.
- Upstream issue docs: `scripts/track-upstream-issues.mjs` now tracks `session-replay-marker-only-image-regenerate` and `toolgroup-file-detail-link-context`; `docs/upstream-issues/README.md` and both draft issue files are generated from that source.
- sg01 deployment remains attended through `install-server upgrade --version v0.346.18-karlorz.5 --channel prerelease`, with dry-run before execute.

## Fork Patch Closeout - 2026-07-01

- Patch target: `v0.346.18-karlorz.6` on branch `dev`; package version remains upstream-aligned at `0.346.18`.
- Model-removal fix: Settings now removes provider models through the dedicated provider-model delete endpoint, server routes decode slash-bearing model ids before registry mutation, and explicit local provider `models` saves replace plugin model definitions instead of merging deleted entries back in.
- Regression coverage: `ProviderModelList` verifies DELETE endpoint usage and no broad `/api/config` rewrite; provider route tests cover encoded slash model ids; provider registry tests cover slash-bearing local provider plugin model removal.
- sg01 live validation: a temp provider/model with model id `codex/smoke-delete-*` was created through the remote server, removed through `DELETE /api/providers/:provider/models/:modelId`, verified absent, and cleaned up.
- sg01 memory diagnosis: high memory was tmpfs pressure from stale `/tmp/openhanako-*` and `/tmp/hanaagent-*` build/upgrade directories, not CPU saturation. Future attended hotfix builds should stage under disk-backed `/opt/hanaagent/build` and clean it after install.

## Stable Sync Closeout - 2026-07-04

- Sync target: upstream stable `v0.350.2`; previous fork stable baseline was `v0.349.5`.
- The rebased `dev` branch now carries upstream package metadata aligned to `0.350.2`.
- The upstream delta from `v0.349.5..v0.350.2` absorbed 8 non-merge commits across 48 files, including the MinGit runtime switch, desktop slash-command wiring, text-surface spellcheck disablement, MCP capability drift preservation, and stream-end stabilization.
- Verification passed: `node scripts/sync-upstream.mjs --post-rebase`, `npx vitest run tests/sync-upstream.test.mjs`, `npm run typecheck`, `git diff --check`, and `node scripts/sync-upstream.mjs --conflict-plan --json --local-only`.
- Tier 3A installed/codesigned local HanaAgent `0.350.2`; bundle metadata and `build-info.json` matched `package.json`, with `sourceRepo: karlorz/openhanako`, `baseTag: v0.350.2`, `dirty: false`, and local updates disabled.
- Tier 3B sg01 desktop smoke passed against `http://100.125.173.118:14500`: helper identity returned HTTP 200, WebSocket opened, a generated image was uploaded/sent, chat switch/return preserved the new smoke turn and Conversation Files row, and MediaViewer loaded the scoped remote resource URL at `1024x1024` without CSP or WebSocket regressions.
- Fork release target for this sync is `v0.350.2-karlorz.1`; the plain upstream tag `v0.350.2` remains unpushed to `origin`.
- Permanent dashboard PR #1 remains open, draft, and unmerged.

## Main-refresh pre-sync review - 2026-07-21 (historical, pre train-13 mutate)

- Refreshed `origin/main` from `upstream/main` via `node scripts/sync-upstream.mjs --conflict-plan` (base moved `9a5b8e9d` → `8a3cbbfc`; package tip `0.415.15` / tag `v0.415.15` without published GitHub release).
- Stable `--check` at that time: latest and last-synced both `v0.407.15`; no newer stable production sync available.
- Prerelease `--include-prerelease --check` at that time: new tag `train-13` available for **review**; mutate still required double consent (not silent bare `--include-prerelease`).
- Issue `status`/`search`: #1749 OPEN, #1811 CLOSED; inventory still tracks #1493/#1546 for plugin-iframe draft; no exact matches for pending drafts; no issue submitted.
- Local-only conflict plan (pre-mutate): 16 planned paths, 57 risky overlapping paths, 10 migration contracts, `stableActivationAllowed: false`.
- Safety at main-refresh: `dev` HEAD remained on the pre-mutate tip; package/lockfile stayed `0.407.15`; PR #1 remained OPEN draft with no auto-merge; no install, deploy, tag, or release during the refresh-only pass.

## Attended prerelease-channel sync - 2026-07-21 (`train-13`)

- Double-consent mutate: `CONFIRM=train-13 node scripts/sync-upstream.mjs --include-prerelease --i-accept-prerelease-sync`.
- Backup: `backup/dev-before-prerelease-train-13-20260721` @ `611fd08d`.
- Result: `dev` rebased onto `train-13`; package **`0.412.7`**; lastSynced **`train-13`**; `--include-prerelease --check` reports already up to date.
- Post-rebase Tier 0–2 green after restoring conflict-damaged test suites and fork assessment surfaces; typecheck clean.
- Tier 3A desktop install / Tier 3B sg01 smoke still manual; no host deploy/tag/fork release from this cycle.
- Docs: `FORK_SYNC.md` sync log + optional channel section; SkillWiki `projects/openhanako/requirements/2026-07-21-prerelease-channel-train-13-sync.md`.

## Fork release + dual deploy - 2026-07-21 (`v0.412.7-karlorz.1`)

- Published fork prerelease tag `v0.412.7-karlorz.1` (package `0.412.7`, legacy-raw profile, 20 assets).
- Local macOS: installed published `HanaAgent-0.412.7-macOS-arm64-legacy-raw.dmg`; codesign valid; build-info releaseTag matches.
- sg01: `install-server upgrade --version v0.412.7-karlorz.1 --channel prerelease` → ok, current `...-linux-arm64`, service active/enabled.
- CI: Build workflow success after dual-profile workflow/fix-modules restore; release job published assets.
- Follow-up on `dev` (`9eb42275`, 2026-07-22): restored SettingsPage / settings-content-root / remote-assessment hydrate on SettingsContent; rewired platform-qualified seed discovery + dual-profile Windows install surface; re-added per-platform `verify-seed-kit` steps before `electron-builder`; repinned CLI closure / persistence inventory / schema fingerprint. Package remains **`0.412.7`**.
