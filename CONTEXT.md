# OpenHanako / HanaAgent Context

## Project Shape

OpenHanako is the HanaAgent desktop/server application. This checkout is the personal fork `karlorz/openhanako` on branch `dev`, with upstream at `liliMozi/openhanako` on `main`.

The important deployment target is sg01:

- Server URL: `http://100.125.173.118:14500`
- Role: headless HanaAgent server in LAN mode
- Client: macOS `/Applications/HanaAgent.app`
- Local workspace: `/Users/karlchow/Desktop/code/openhanako`
- Project wiki: `projects/openhanako` under the vault returned by `skillwiki path`

## Operating Stance

This is a permanent personal fork unless upstream accepts equivalent fixes. See `FORK_SYNC.md` for the sync runbook and per-file conflict policy.

Use release-tag syncs from upstream, not continuous upstream `main` tracking. Preserve local fixes by behavior and tests, not by blindly preferring either side during conflicts.

Current post-rebase state (2026-08-10): local `dev` was rebased onto upstream
stable **`v0.446.6`** at `5f08a4f30203abb61dafac7dbb7ab92d11c23efa`;
the rebase-completion head was
`84c95a469d49d132f7a423ccc45579fad61b68f5`. The separate
**`train-beta-26`** prerelease label points to the same commit but does not
replace the stable-tag production identity. Recoverable pre-rebase state is
preserved at `backup/dev-before-stable-v0.446.6-20260810` /
`95b23b0829176c2858030e6dd8d9f2b712daa62f`. `package.json`, the lockfile
root, and upstream-owned digest entries now report **`0.446.6`** /
**`v0.446.6`**. The rewritten branch is intentionally not published:
`origin/dev` remains `875c26d3780bb1fc9f19e113c3e364121eea09ef`.

The focused Marketplace/persistence/security baseline is green (11 files,
209 tests), but this release is **not ready to publish**. Two unimplemented
regressions remain: a legacy Marketplace opt-out can be re-migrated after a
user re-enables it, and the credential-file healer does not yet cover
source-qualified Marketplace config/secrets paths. The installed local app is
still `0.421.24`, so current-branch Tier 3A and local Marketplace smoke remain
pending. No push, tag, release, dashboard refresh, sg01 contact, deployment,
or GitHub social/upstream mutation has occurred in this stage.

## Core Terms

- **Local owner connection**: Electron desktop owns and spawns its own local server; local file URLs can use `platform.getFileUrl`.
- **LAN client connection**: Electron desktop connects to an external HanaAgent server such as sg01; renderer resource URLs must go through HTTP APIs on the active server.
- **Device credential**: `hana_dev_...` access key used by LAN desktop clients.
- **Runtime connection CSP**: `desktop/src/modules/connection-csp.js`; reads `hana-server-connections-v1` from `localStorage` at renderer startup and scopes the active server origin into CSP.
- **Session file**: server-managed file registered for a chat/session, commonly with `sf_*` IDs.
- **Session registry**: per-session file registry in the client store; powers Conversation Files and previews.
- **Resource content URL**: `/api/resources/<resourceId>/content`; the correct preview path for remote server-owned files.
- **Client-owned path**: a path from macOS paste/drop/select such as `/Users/...`; remote Linux servers cannot import it by path, so the desktop must upload bytes.
- **Server-owned path**: a path originating from HanaAgent workspace/session UI; it already belongs to the active server and must not be re-uploaded.
- **Optimistic attachment**: transient UI attachment before server echo; may carry inline base64 bytes for immediate preview.
- **Display message attachment**: persisted message payload; should not store base64 payloads.

## Upstream Collaboration Language

- **Upstream read**: A side-effect-free search, list, view, public GET, reference, or download involving `liliMozi/openhanako`. _Avoid_: “upstream access,” because that can also imply write authority.
- **Local upstream draft**: Reviewable Markdown and supporting evidence kept in this fork or its SkillWiki project for possible human use. Creating or approving a draft has no external side effect. _Avoid_: “pending submission,” which implies that publication is automatic.
- **Upstream mutation**: Any state change under `liliMozi/openhanako`, including creating, editing, commenting on, closing, reopening, labeling, reacting to, transferring, or deleting an issue, pull request, discussion, release, or other repository object. Codex and Claude are never authorized to perform an upstream mutation. _Avoid_: “submit issue” as the whole boundary, because comments and edits are mutations too.
- **Draft approval**: A human decision that the wording and evidence in a local upstream draft are acceptable. Draft approval never grants posting authority. _Avoid_: “approved to submit.”
- **Human submission**: An upstream mutation performed manually by a human outside a Codex or Claude session. It is the only permitted path from a local upstream draft to an upstream repository object. _Avoid_: “agent-assisted submission,” because an agent may help prepare content but may not execute the mutation.

## Model capability SoT (Vision auxiliary)

Provider catalog model object fields (Settings → Providers → edit model) are the durable authority for `image` / vision, `video`, `audio`, and `reasoning` after the user saves. Runtime `model-sync` projects those fields into `models.json` `input`; the Vision auxiliary picker only lists models whose projected `input` includes `"image"`.

- Dictionary sources (`known-models.json` partitions, `known-model-fallbacks.json`) are optional best-effort fill when catalog fields are **absent**. They must not silently steal another provider's partition for a custom hub, and they are not day-to-day maintenance for unknown model ids.
- Model edit Save materializes `true` capabilities shown from dictionary defaults without a re-toggle; it materializes `false` only when the catalog already had that field or the user toggled it (preserves Ollama name-inference).
- Fork fix tracked as `vision-capability-settings-sot` (commit `a98f86a9`, UAT-passed 2026-07-26). Upstream relatives: #1904, #538, #594; #2252 is an adjacent `google-generative-ai` Vision Bridge adapter failure, not an equivalent catalog-source-of-truth fix. Draft: `docs/upstream-issues/drafts/vision-capability-settings-sot.md`.

## Critical Paths

- LAN connect/auth:
  - `core/server-auth.ts`
  - `desktop/src/react/services/server-connection.ts`
  - `desktop/main.cjs`
  - `desktop/preload.cjs`
- Remote attachment upload/preview:
  - `desktop/src/modules/connection-csp.js`
  - `desktop/src/react/MainContent.tsx`
  - `desktop/src/react/components/InputArea.tsx`
  - `desktop/src/react/services/resource-url.ts`
  - `desktop/src/react/utils/user-attachment-media.ts`
  - `desktop/src/react/stores/chat-slice.ts`
  - `desktop/src/react/stores/selectors/file-refs.ts`
  - `server/routes/upload.ts`
- Packaging/local install:
  - `package.json`
  - `scripts/build-server.mjs`
  - `scripts/sign-local.cjs`
  - `.github/workflows/build.yml`
  - `.github/workflows/ci.yml`
- Marketplace native/runtime, skill packages, and Manage Plugins:
  - `docs/plugins/marketplace-handbook.md`
  - `core/plugin-config.ts` (ordinary/secrets split and scoped migration)
  - `core/plugin-manager.ts` (source-qualified native data/secrets roots)
  - `lib/plugin-install-records.ts` (active and retained artifact identity)
  - `lib/plugin-trust-store.ts` (source/digest-qualified trust)
  - `lib/plugin-marketplace-service.ts` (source snapshots, boot seed, installed skill inventory)
  - `lib/plugin-marketplace-activation.ts` (`marketplaceSkillPackages` gate)
  - `server/routes/plugins-marketplace.ts`
    - `GET /api/plugins/marketplace/installed-skill-packages`
    - `DELETE /api/plugins/:pluginId/artifacts/:marketplaceId/:artifactDigest`
    - `DELETE /api/plugins/:pluginId/state/:marketplaceId`
    - `DELETE /api/plugins/marketplace/:id/skills`
  - `core/skill-manager.ts` (package gate resolver)
  - `desktop/src/react/settings/tabs/PluginsTab.tsx`
  - `desktop/src/react/settings/tabs/PluginMarketplaceTab.tsx`
  - `desktop/src/react/settings/components/MarketplaceSourcesPanel.tsx`
  - `desktop/src/react/settings/tabs/skills/SkillRow.tsx`
  - `tests/plugin-marketplace-retention-routes.test.ts`
  - `tests/plugin-marketplace-official-seed.test.ts`
  - `tests/plugin-config.test.ts`
  - `tests/plugin-manager.test.ts`
  - `tests/agent-platform-prompt.test.ts`
  - SkillWiki: `projects/openhanako/work/2026-07-31-manage-plugins-marketplace-skill-packages/`

## Verification Expectations

For LAN/remote attachment work, run the focused Vitest suite before claiming completion:

```bash
npx vitest run \
  tests/csp-sync.test.ts \
  desktop/src/react/__tests__/components/MainContent.drag.test.tsx \
  desktop/src/react/__tests__/components/InputArea.paste-and-slash.test.tsx \
  desktop/src/react/__tests__/components/InputArea.media-send.test.tsx \
  desktop/src/react/__tests__/services/ws-message-handler.test.ts \
  desktop/src/react/__tests__/services/resource-url.test.ts \
  desktop/src/react/__tests__/stores/chat-slice.test.ts \
  desktop/src/react/__tests__/stores/selectors/file-refs.test.ts \
  desktop/src/react/__tests__/components/shared/MediaViewer/media-source.test.ts \
  desktop/src/react/__tests__/utils/open-media-viewer.test.ts \
  desktop/src/react/__tests__/utils/user-attachment-media.test.ts \
  desktop/src/react/__tests__/components/RightWorkspacePanel.test.tsx \
  tests/upload-route.test.ts \
  --exclude "**/node_modules/**"
```

Also run `npm run typecheck` and `git diff --check`. For user-facing desktop fixes, build/install with `SKIP_NOTARIZE=true npm run install:local` (current working tree on the checked-out branch; packs arm64 into `/Applications/HanaAgent.app`), verify codesign, then confirm bundle metadata, `Contents/Resources/build-info.json` (`channel: local`, `gitSha` = intended commit), and Settings → About all match the `package.json` version before manual smoke.

For Manage Plugins / marketplace skill-package changes, additionally run:

```bash
npx vitest run tests/plugin-marketplace-*.test.ts \
  tests/plugin-marketplace.test.ts \
  tests/http-route-security.test.ts \
  tests/skill-manager.test.ts \
  tests/skills-route.test.ts \
  tests/plugin-config.test.ts \
  tests/plugin-manager.test.ts \
  tests/plugin-trust-store.test.ts \
  tests/plugin-routes.test.ts \
  tests/agent-platform-prompt.test.ts \
  desktop/src/react/__tests__/settings/AddMarketplaceSourceDialog.test.tsx \
  desktop/src/react/__tests__/settings/MarketplaceSourcesPanel.test.tsx \
  desktop/src/react/__tests__/settings/PluginMarketplaceTab.test.tsx \
  desktop/src/react/__tests__/settings/PluginsTab.test.tsx \
  desktop/src/react/__tests__/settings/marketplace/ManagePluginsSkillPackagesPanel.test.tsx \
  desktop/src/react/__tests__/settings/marketplace/MarketplacePluginInspector.busy.test.tsx \
  desktop/src/react/settings/tabs/skills/__tests__/SkillRow.test.tsx \
  tests/i18n-locale-parity.test.ts \
  tests/react-locale-coverage.test.ts
```

Then run `npm run typecheck` and `git diff --check`.

Local packaged manual smoke for Marketplace pre-work:

1. Confirm the official source is visible and startup remains usable offline.
2. Submit a failing Add Source request; verify the dialog remains open, input is preserved, and the error is inline. Then add a valid disposable source.
3. Verify technical details start collapsed and expand to location/ref/index/revision/digest/fetched-time/diagnostics.
4. Verify visible localized **Refresh**, **Remove**, **Enable/Disable**, and **Manage in Skills** actions; pressed controls expose state.
5. Install a Hana-skill package and confirm the Manage Plugins Hana skills row.
6. Verify the explicit **Package**, **Agent preference**, and **Effective availability** layers; turn the package off/on, open Manage in Skills, and turn one skill off/on for a selected Agent.
7. Uninstall the skill package through its dedicated lifecycle.
8. Confirm native HyperFrames inventory/toggle and the native PluginManager dropzone are unchanged.

This 2026-08-09 pre-sync goal is local-only. Do not run the remote sg01 smoke, deployment, upgrade, or release flow as part of this pre-work closeout. The remote checklist below applies to an attended sync/release stage that explicitly includes sg01.

Manual smoke for the remote server:

1. Connect to `http://100.125.173.118:14500`.
   - To clear `localStorage` and reconnect without retyping a previously saved key, run `node scripts/hana-desktop-smoke-helper.mjs --restart --verify --url http://100.125.173.118:14500`.
   - Contract gates are explicit and repeatable, for example `--require-contract input.drafts@1`; evidence defaults to `.claude/remote-assessment/latest.json` and can be changed with `--assessment-out PATH`. Exit `3` means functional verification passed but a requested contract is missing, unconfirmed, or deployment-coupled. `websocket.ticket@1` is migration-readiness evidence, not a generic LAN core requirement.
   - If the LAN connection has never been saved in this app profile, prefer `HANA_DESKTOP_SMOKE_TOKEN=<device-key>` over `--token` for the first helper run.
   - A normal `--verify` run always reports two independent results: `functional.status` for identity/WebSocket operation and `environment.status` for server release freshness, feature-contract evidence, and host compatibility. `functional.status: pass` does not mean the Remote Server is current. Environment attention or an unavailable GitHub release lookup remains non-fatal in Phase 1; identity or WebSocket failure still exits nonzero.
   - Desktop Settings → Access & Devices (remote mode) surfaces the same layered assessment (core connection, transport, server update/freshness, feature support, host compatibility), not a single recovery-only “Compatibility: Ready” label. Optional host CLI: `install-server status --check-updates --json` (read-only; never upgrades).
2. Paste/upload an image.
3. Send it.
4. Switch chats and return.
5. Confirm chat thumbnail and Conversation Files preview still render, including older sessions.

### Offline work-item prerequisite check

Candidate specs may declare `remote_requirements` in YAML frontmatter. An
attended operator sets `WORK_ITEM_SPEC` to the candidate spec's absolute path,
refreshes `.claude/remote-assessment/latest.json` with the desktop smoke helper,
and then runs the configured `check-remote-prerequisites.mjs` command. Refresh
evidence only with attended authority.
Attended refresh is the only supported evidence refresh workflow.

The checker is offline, credential-free, and read-only: it reads only the
supplied work-item and assessment paths. It reports `unknown` when evidence is
absent, invalid, or stale. Prep must not scrape credentials, read renderer or
localStorage state, or contact sg01 merely because a candidate has remote
requirements. Generic `/dev-loop prep` does not invoke this checker.

When the result is `deployment-coupled`, split the work into explicit client,
server, release, upgrade, and post-upgrade verification stages. Automatic prep
integration requires a separate dev-loop plugin source change and release; do
not patch an installed plugin cache.

## Dev-Loop Notes

- Root agent guide: `CLAUDE.md`.
- Primary dev-loop config: `.claude/dev-loop.config.md`.
- Resolve the SkillWiki vault with `skillwiki path`; project-relative wiki paths should use `projects/openhanako` so the docs remain valid on remote workspaces.
- GitHub CLI default repo should be `karlorz/openhanako`; use `gh repo set-default karlorz/openhanako` if `gh repo view` resolves to upstream.
- Release branch is `dev`; CI targets `main` and `dev`.
- Browser verification expects a dev server at `${HANA_BROWSER_VERIFY_URL:-http://localhost:5173}`.
- `skillwiki doctor` can exit non-zero when only warnings exist; inspect its JSON summary before treating it as a blocker.
- The old sg01 SSH deploy helper is retired. Server install/upgrade/status planning lives in `scripts/install-server.mjs` and `docs/server-install.md`; destructive reset/import behavior is separately scoped in `docs/reinit-data-failsafe.md`. Dev-loop `deploy_script` remains unset so unattended cycles do not deploy hosts.
