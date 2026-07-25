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

Current state (2026-07-25): the attended two-stage upstream sync and fork publication are complete. `dev` first rebased onto stable `v0.416.44`, then used explicit prerelease double consent to rebase all 220 fork commits onto `train-beta-17` / `v0.416.51` at upstream SHA `ef8a6f700191c2486effd3761a4bd2b7f3ad774c`. Package and lockfile metadata align to `0.416.51`; digest v1/v2 metadata is fork-aligned on `dev` at `ac3c2e7924fb4daa8d6b2fc086fb619022e4779a`. The immutable stable-base tag `v0.416.44-karlorz.1` points to its verified release-prep snapshot `271d2d6a045c7239381cbfd5c88da9cfc437b0aa`, and `v0.416.51-karlorz.1` points to `ac3c2e7924fb4daa8d6b2fc086fb619022e4779a`. Both GitHub releases are published as prereleases by fork policy with the complete 20-asset `legacy-raw` surface; Build runs `30162262114` and `30162931788` passed. The full sync suite (1,038 files / 10,338 tests plus six expected manual skips), focused sync/tracker suites, release digest validation, typecheck, diff-check, post-rebase gates, local-only conflict planning, push CI `30162299102`, and permanent-dashboard PR CI `30162300392` pass. Local signed HanaAgent `0.416.51` remains installed at `/Applications/HanaAgent.app` with strict deep codesign and updates disabled. Live sg01 helper and installed-app smoke passed identity/WebSocket, image upload/send, chat switch/return, restored 1024×1024 transcript thumbnail, Conversation Files rehydration, and a nonblank full preview with no observed CSP/WebSocket/page error. sg01 itself remains on the immutable `v0.416.43-karlorz.1` release and was not deployed or modified. PR #1 remains permanent draft never-merge. See `FORK_SYNC.md` for exact backups, receipts, issue #2188 tracking, release URLs, and closeout evidence.

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

Also run `npm run typecheck` and `git diff --check`. For user-facing desktop fixes, build/install with `SKIP_NOTARIZE=true npm run install:local`, verify codesign, then confirm `/Applications/HanaAgent.app` bundle metadata, `Contents/Resources/build-info.json`, and Settings → About all match the `package.json` version before manual smoke.

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
