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
   - If the LAN connection has never been saved in this app profile, prefer `HANA_DESKTOP_SMOKE_TOKEN=<device-key>` over `--token` for the first helper run.
2. Paste/upload an image.
3. Send it.
4. Switch chats and return.
5. Confirm chat thumbnail and Conversation Files preview still render, including older sessions.

## Dev-Loop Notes

- Root agent guide: `CLAUDE.md`.
- Primary dev-loop config: `.claude/dev-loop.config.md`.
- Resolve the SkillWiki vault with `skillwiki path`; project-relative wiki paths should use `projects/openhanako` so the docs remain valid on remote workspaces.
- GitHub CLI default repo should be `karlorz/openhanako`; use `gh repo set-default karlorz/openhanako` if `gh repo view` resolves to upstream.
- Release branch is `dev`; CI targets `main` and `dev`.
- Browser verification expects a dev server at `${HANA_BROWSER_VERIFY_URL:-http://localhost:5173}`.
- `skillwiki doctor` can exit non-zero when only warnings exist; inspect its JSON summary before treating it as a blocker.
- The old sg01 SSH deploy helper is retired. Server install/upgrade/status planning lives in `scripts/install-server.mjs` and `docs/server-install.md`; destructive reset/import behavior is separately scoped in `docs/reinit-data-failsafe.md`. Dev-loop `deploy_script` remains unset so unattended cycles do not deploy hosts.
