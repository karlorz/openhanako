# Fork Sync Policy

This fork (`karlorz/openhanako`, default branch `dev`) carries local fixes that diverge from upstream (`liliMozi/openhanako`, branch `main`). This document is the **operational runbook** for syncing upstream releases without losing the local fixes.

For the *why* behind these decisions, see the wiki: `projects/openhanako/fork-sync-policy.md`.

---

## Stance

- **Permanent fork.** We maintain this for personal use. No PR planned upstream.
- **Upstream issue tracker:** [#1749](https://github.com/liliMozi/openhanako/issues/1749) — our bug report (CSP + WS auth). If the maintainer ever accepts equivalent fixes upstream, revisit the permanent-fork decision.
- **Issue tracking rule:** every local fix gets a tracking row. Only upstream-eligible fixes get issue search/draft work; fork-only maintenance is documented without upstream issue noise.

## Upstream issue tracking

Run the tracker whenever a local fix is added or before an upstream release-tag sync:

```bash
node scripts/track-upstream-issues.mjs status
node scripts/track-upstream-issues.mjs search
node scripts/track-upstream-issues.mjs draft
```

The script never submits GitHub issues. It only prints/searches upstream state and writes local draft issue files under `docs/upstream-issues/drafts/`.

Current status:

| Fix | Status | Upstream issue state | Action |
|-----|--------|----------------------|--------|
| LAN/Tailscale CSP + WebSocket auth | `existing/open` | [#1749](https://github.com/liliMozi/openhanako/issues/1749) OPEN; [#1811](https://github.com/liliMozi/openhanako/issues/1811) CLOSED | Check during every sync; close or shrink divergence only if upstream accepts equivalent behavior. |
| Remote plugin iframe credential query leak | `draft/pending-approval` | No exact issue found; related [#1493](https://github.com/liliMozi/openhanako/issues/1493), [#1546](https://github.com/liliMozi/openhanako/issues/1546) | Review `docs/upstream-issues/drafts/plugin-iframe-remote-credential-query-leak.md`; submit only after owner approval. |
| Remote attachment preview persistence | `draft/pending-approval` | No exact issue found | Review `docs/upstream-issues/drafts/remote-attachment-preview-persistence.md`; submit only after owner approval. |
| Local fork build identity + disabled local auto-update | `tracked/no-upstream-issue` | Fork-only | Keep local; no upstream issue unless this becomes a general local-build-channel feature request. |
| Fork sync issue tracking + prerelease policy | `tracked/no-upstream-issue` | Fork-only | Keep local; documents and automates this fork's maintenance workflow. |

## Sync cadence

- **Stable release-tag sync, manual.** Pull when upstream cuts a new non-prerelease release tag. Do NOT track `main` HEAD and do NOT treat prereleases as production sync targets.
- **Permanent PR dashboard.** PR [#1](https://github.com/karlorz/openhanako/pull/1) is a permanent draft dashboard from `dev` to `main`. It is for human review and agent drilldown only; never merge it.
- **Dashboard base.** `origin/main` is a disposable mirror of `liliMozi/openhanako/main`. The conflict dashboard helper may replace `origin/main` from `upstream/main`, but it must never mutate `dev`, the index, or the working tree.
- **Machine-readable rules:** `docs/fork-sync/rules.yml` is the source of truth for release-target policy, diverging-file rules, fork-only-file rules, issue-tracking states, and verification commands. This runbook explains the same policy for humans.
- **Detection:** run `node scripts/sync-upstream.mjs --check` anytime. It compares the latest stable upstream release tag against the sync log (below), reports diverging files upstream touched, and verifies all `forkOnlyFiles` patterns still match tracked files in the working tree.
- **Fork-only file protection:** `docs/fork-sync/rules.yml` `conflictRules.forkOnlyFiles` lists fork-only new files (scripts, tests, docs, examples, config) that do not exist upstream. After every rebase, the sync helper runs a Tier 0 gate that verifies each pattern still matches at least one tracked file. If any go missing, the sync fails before Tier 1 tests — an upstream rebase that silently drops a fork feature is caught here, not by indirect test breakage.
- **Dashboard refresh:** run `node scripts/sync-upstream.mjs --conflict-plan` anytime. It refreshes `origin/main` from `upstream/main`, computes a dry-run merge-tree plan against `origin/dev`, updates the generated block in PR #1, and leaves `dev` untouched.
- **Package version ownership:** package version and lockfile root metadata changes are deferred to the attended stable production fork sync. Do not pre-bump `package.json` or `package-lock.json` just to reduce dashboard conflicts.
- **Prerelease review:** run `node scripts/sync-upstream.mjs --include-prerelease --check` only when intentionally reviewing a prerelease candidate. This is not the normal production update path.
- **Issue check:** as part of every sync, run `node scripts/track-upstream-issues.mjs search` and glance at [#1749](https://github.com/liliMozi/openhanako/issues/1749) plus the pending draft list. If upstream accepted equivalent fixes, the divergence shrinks.

## Diverging files

### LAN connect/auth fixes

| File | Commit | Risk if upstream touches | Resolution policy |
|------|--------|--------------------------|-------------------|
| `core/server-auth.ts` | `80ea81ae` | **HIGH** — security-critical; upstream may ship CVE fixes | **HUMAN REVIEW ALWAYS.** Never auto-resolve. Our change is 1 line in `parseCredential` (allows query tokens for LAN). Upstream changes here may intersect semantically. |
| `desktop/src/react/services/server-connection.ts` | `ae7fd31c` | **HIGH** — connection logic evolves | **HUMAN REVIEW.** Our changes are additive (probe path in `connectDeviceServerConnection`, `canUseQueryToken` device_credential branch). Upstream likely adds new features; conflicts usually merge cleanly but verify. |
| `desktop/main.cjs` | `ae7fd31c` | **MEDIUM** — IPC handlers added occasionally | **Usually auto-mergeable.** Our change adds `net` to the electron import line + a new `wrapIpcHandler("connect:probe", ...)` block. Verify the `net` import survives any upstream rewrite of line 11. |
| `desktop/preload.cjs` | `ae7fd31c` | **MEDIUM** — new channels exposed occasionally | **Usually auto-mergeable.** Our change adds one line (`probeConnection`) inside the existing `contextBridge.exposeInMainWorld` block. |
| `tests/server-auth.test.ts` | `80ea81ae` | Medium | **Prefer ours**, but if upstream restructures the test file heavily, review. |
| `tests/server-connection.test.ts` | stable `v0.333.6` inherited test + fork B1 behavior | Medium | **Preserve both.** LAN device-credential WebSockets must keep token query fallback; non-LAN `custom_remote` device connections should keep upstream `wsTicket` behavior. |
| `desktop/src/react/__tests__/services/server-connection.test.ts` | `80ea81ae` + `ae7fd31c` | Low | **Prefer ours** (they test our fixes). |

### Remote upload/resource preview fixes

These files fix remote desktop attachment import and preview when the macOS desktop is connected to `http://100.125.173.118:14500`. Upstream may touch these areas independently; preserve the tests and the end-to-end invariant, not just exact code.

| File | Risk if upstream touches | Resolution policy |
|------|--------------------------|-------------------|
| `desktop/src/modules/connection-csp.js` | **HIGH** — renderer CSP controls whether persisted remote resources can render | **HUMAN REVIEW.** Active remote HTTP(S) origin must be present in `img-src` and `media-src`, while WS origins stay in `connect-src` only. Do not widen to bare `http:`/`https:`. |
| `desktop/src/react/services/resource-url.ts` | **HIGH** — resource URL resolution for remote session files | **HUMAN REVIEW.** Remote `sf_*` session files without explicit resource links must synthesize `/api/resources/res_<fileId>/content` with token query support. |
| `desktop/src/react/utils/user-attachment-media.ts` | Medium | Prefer resource URLs for remote attachments after inline bytes are gone; local `platform.getFileUrl` remains the fallback for local transport. |
| `desktop/src/react/MainContent.tsx` | Medium | Preserve path ownership rules: native paste/drop/select from macOS uploads client-owned blobs over `/api/upload-blob`; app/workspace drags of server-owned files must not re-upload. |
| `desktop/src/react/components/InputArea.tsx` | Medium | Preserve optimistic inline media bytes for the current chat render, but keep persisted `displayMessage.attachments` free of `base64Data`. |
| `desktop/src/react/stores/chat-slice.ts` | Medium | Preserve optimistic inline bytes when replacing a pending user message with the server echo. |
| `desktop/src/react/stores/selectors/file-refs.ts` | Medium | Duplicate session-registry/message attachments should merge instead of discarding inline preview/resource metadata. |
| `desktop/src/react/utils/uploaded-session-file.ts` | Low | Shared utility for registering uploaded session files; keep it small and store-focused. |
| `desktop/src/react/utils/preview-file-refresh.ts` | Medium | Preserve the single version-aware retry helper path. Duplicate `delay` / `fileVersionsEqual` / `readFileForPreviewTypeWithRetry` declarations are a failed merge, not an intentional fork behavior. |
| `desktop/src/react/utils/preview-document-refresh.ts` | Medium | Preserve multi-mount native-root lookup via `nativeRootForWorkbenchMount` while accepting upstream preview-refresh behavior. |
| `desktop/src/react/utils/remote-file-preview.ts` | Medium | Preserve version-aware `PreviewContentSnapshot`, `newestKnownFileVersion`, and `remoteContentRefWithVersion` behavior for remote workbench previews. |
| `server/routes/upload.ts` | Medium | `/api/upload-blob` must accept image/audio plus listed document attachment MIME types, enforce size limits, and register session-owned files. |
| Affected tests under `desktop/src/react/__tests__/...`, `tests/csp-sync.test.ts`, `tests/upload-route.test.ts` | Low | Prefer ours unless upstream has equivalent coverage for remote preview persistence and client-owned blob import. |
| `tests/plugin-sdk-examples.test.ts`, `tests/office-workflow-plugin.test.ts` | Low | Preserve both upstream SDK tarball assertions and fork office-workflow template coverage. |

### WebSocket session identity conflict planning

| File | Risk if upstream touches | Resolution policy |
|------|--------------------------|-------------------|
| `desktop/src/react/services/ws-message-handler.ts` | **HIGH** — session-scoped browser status, preview refresh, and optimistic attachment hydration can interact across production code and test fixtures | **HUMAN REVIEW.** If upstream changes `desktop/src/react/__tests__/services/ws-message-handler.test.ts`, inspect the production service file too. A test-only dashboard conflict reduction must not hide regressions in fork session identity routing or replayed optimistic attachment hydration. |

### Desktop packaging metadata

| File | Risk if upstream touches | Resolution policy |
|------|--------------------------|-------------------|
| `package.json` | Medium | **DEFER.** Stable production fork sync owns package version alignment. Dashboard-only conflict reduction must not pre-bump the version; preserve the fork baseline and `install:local` behavior until the attended sync resolves both together. |
| `package-lock.json` | Medium | **DEFER.** Do not regenerate or pre-bump lockfile root metadata for the dashboard. Regenerate only during the stable production fork sync after the package version decision. |

## The fixed commits / divergence clusters

1. **`80ea81ae`** — Bug B: allow query token auth for LAN WebSocket connections
   - `core/server-auth.ts`: `parseCredential` accepts query tokens for `local` + `lan` (was: `local` only)
   - `desktop/src/react/services/server-connection.ts`: `canUseQueryToken` includes `device_credential`
   - + tests in both suites
2. **`ae7fd31c`** — Bug A: main-process pre-validation for LAN connect (CSP bootstrapping)
   - `desktop/main.cjs`: `ipcMain.handle("connect:probe", ...)` using `net.fetch` with SSRF guard + sender validation
   - `desktop/preload.cjs`: exposes `probeConnection`
   - `desktop/src/react/services/server-connection.ts`: `connectDeviceServerConnection` probes via main, persists, reloads
   - + tests in `server-connection.test.ts`
3. **Remote attachment upload/resource preview fix** — Bug C: pasted/uploaded images and documents on a remote desktop connection
   - macOS client-owned paths are uploaded as blobs to the active remote server instead of sending `/Users/...` paths for the Linux server to import.
   - Remote session images use resource URLs after transient inline bytes disappear.
   - Active remote HTTP(S) origins are allowed by runtime CSP for `img-src` and `media-src`, fixing previews after switching chats.
   - + tests in `tests/csp-sync.test.ts`, `tests/upload-route.test.ts`, and the affected React media/resource/store suites.

Full context: [[projects/openhanako/work/2026-06-15-csp-ws-lan-connect-fix]], [[projects/openhanako/work/2026-06-15-csp-bootstrapping-permanent-fix]], and [[concepts/openhanako-remote-session-file-preview]] in the wiki.

## Sync workflow

Run: `node scripts/sync-upstream.mjs` (see `--help` for flags). By default it syncs only stable upstream releases; use `--include-prerelease` only for explicit prerelease candidate review.

For the permanent dashboard PR, use:

```bash
node scripts/sync-upstream.mjs --conflict-plan
node scripts/sync-upstream.mjs --conflict-plan --json --local-only
```

Dashboard rules:

- `origin/main := upstream/main` is allowed, including replacement with lease protection.
- `dev` is protected. The conflict planner never merges, rebases, resets, stages, or writes `dev`.
- Use `--local-only` for inspection that must not update PR #1 or replace `origin/main`.
- Unknown conflicts default to `take-main` in the dry-run plan.
- Fork exceptions live in `docs/fork-sync/rules.yml` and include explicit `plannedAction` text.
- Package version and lockfile conflicts are reported as deferred; dashboard-only cleanup must not change them.
- PR #1 body is updated only inside the generated dashboard block.

What the script does:

1. **Fetch** — `git fetch upstream --tags`
2. **Issue tracking** — run `node scripts/track-upstream-issues.mjs search`; update `docs/upstream-issues/README.md` and draft status if upstream issue state changed.
3. **Detect** — compare latest upstream tag vs the sync log (below). Exit with "up to date" if no new tag.
4. **Preflight report** — list which diverging files upstream touched since the last sync. Cat this doc's per-file policy tables.
5. **Rebase** — `git rebase <latest-tag>` on `dev`. If clean → proceed. If conflict → **STOP**, drop to shell, print the per-file policy for the conflicting files, wait for manual resolution, resume on your signal.
6. **Tier 0 — Fork-only file presence gate:** verify every `conflictRules.forkOnlyFiles` pattern in `docs/fork-sync/rules.yml` still matches at least one tracked file in the working tree. If any are missing, **STOP** — an upstream rebase likely dropped a fork feature. Recover with `git rebase --abort` or re-add the file from `ORIG_HEAD`. Do not proceed to Tier 1 with missing fork files.
7. **Tier 1 — Unit tests:** run the LAN auth/connect tests plus the remote attachment/resource suite. **STOP if any fail.** Do not deploy.
8. **Tier 2 — Bundle grep:** after rebuilding bundles, verify `grep -c "connect:probe" desktop/main.bundle.cjs` ≥ 1, `grep -c "probeConnection" desktop/preload.bundle.cjs` ≥ 1, and the packaged `connection-csp.js` still contains `media-src` plus remote resource-origin logic. **STOP if missing.**
9. **Tier 3A — Local desktop install/version gate (manual, print-only):** before any live smoke, rebuild and replace the installed macOS app:
   ```bash
   node -p "require('./package.json').version"
   SKIP_NOTARIZE=true npm run install:local
   codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
   defaults read /Applications/HanaAgent.app/Contents/Info CFBundleShortVersionString
   defaults read /Applications/HanaAgent.app/Contents/Info CFBundleVersion
   cat /Applications/HanaAgent.app/Contents/Resources/build-info.json
   ```
   Confirm `CFBundleShortVersionString`, `CFBundleVersion`, and `build-info.json.appVersion` all match the `package.json` version; `build-info.json.channel` is `local`; `updateEnabled` is `false`; and Settings → About shows the same `v{package_version}` plus local build identity. A smoke run against an old `/Applications/HanaAgent.app` is invalid.
10. **Tier 3B — Live smoke (manual):** print a checklist, refuse "complete" until you confirm:
   - Clear `localStorage` in the desktop app, then reconnect by either helper or UI:
     - Repeatable helper path, when the target LAN connection was already saved:
       ```bash
       node scripts/hana-desktop-smoke-helper.mjs --restart --verify --url http://100.125.173.118:14500
       ```
       The helper restarts HanaAgent with Chromium remote debugging, reads the saved LAN connection from the renderer or Electron local storage history, clears `localStorage`, restores only `hana-server-connections-v1`, reloads, then verifies token-auth identity fetch plus WebSocket open from the renderer. If no saved connection exists, prefer `HANA_DESKTOP_SMOKE_TOKEN=<device-key>` for the first helper run; `--token` is available for one-off local use but can leak through shell history or process listings. It must not print stored device tokens.
     - Manual fallback path: Settings → Access → Connect LAN Server → URL + key → Connect (should succeed with NO console hack)
   - DevTools Console: no `Refused to connect ... CSP` errors; WS establishes (no `[WS_DISCONNECTED]`)
   - Paste/upload an image, send it, switch to another chat, switch back, and confirm the chat thumbnail and Conversation Files preview still render
11. **Log** — append to the sync log below with: date, tag synced, conflicts encountered + resolution, test result.

## Verification contract (what "the fix still works" means)

After every sync, ALL of these must hold:

- **Unit tests pass:** LAN auth/connect tests and remote attachment/resource preview tests exit 0
- **Bundles contain the fix:** `connect:probe` in `main.bundle.cjs`, `probeConnection` in `preload.bundle.cjs`
- **Runtime CSP contains resource allowances:** active remote HTTP(S) origin is scoped into `img-src` and `media-src` without widening to bare `http:`/`https:`
- **Installed desktop app matches the sync target:** `/Applications/HanaAgent.app` has been rebuilt with `SKIP_NOTARIZE=true npm run install:local`; codesign verifies; `CFBundleShortVersionString`, `CFBundleVersion`, `build-info.json.appVersion`, and Settings → About all match the `package.json` version
- **Live connect works:** desktop connects to sg01 (`http://100.125.173.118:14500`) with no localStorage hack, no CSP violation, WS establishes
- **Live upload/preview works:** pasted or uploaded images preview immediately, survive chat switching, and old session attachments continue previewing

Useful focused command:

```bash
npx vitest run \
  tests/server-auth.test.ts \
  tests/csp-sync.test.ts \
  desktop/src/react/__tests__/services/server-connection.test.ts \
  desktop/src/react/__tests__/components/MainContent.drag.test.tsx \
  desktop/src/react/__tests__/components/InputArea.paste-and-slash.test.tsx \
  desktop/src/react/__tests__/components/InputArea.media-send.test.tsx \
  desktop/src/react/__tests__/services/resource-url.test.ts \
  desktop/src/react/__tests__/stores/chat-slice.test.ts \
  desktop/src/react/__tests__/stores/selectors/file-refs.test.ts \
  desktop/src/react/__tests__/utils/user-attachment-media.test.ts \
  desktop/src/react/__tests__/components/shared/MediaViewer/media-source.test.ts \
  desktop/src/react/__tests__/utils/open-media-viewer.test.ts \
  desktop/src/react/__tests__/components/RightWorkspacePanel.test.tsx \
  tests/upload-route.test.ts \
  --exclude "**/node_modules/**"
```

If any fails, the sync is **not complete** — either resolve upstream-side (the fix was removed and needs re-application) or do not deploy.

## Rollback

If a sync breaks something we cannot quickly resolve:

```bash
git reflog  # find the pre-rebase HEAD
git reset --hard <pre-rebase-sha>
```

The server on sg01 and the desktop app stay on the last-known-good bundles until we explicitly redeploy.

## Latest sync closeout

- 2026-06-24: `dev` was rebased cleanly from the `v0.333.6` baseline onto upstream stable `v0.341.19`; package metadata is aligned to `0.341.19`, and `package-lock.json` was accepted as upstream root-version alignment rather than a fork lockfile regeneration.
- `node scripts/sync-upstream.mjs` passed Tier 0 fork-only file presence, Tier 1 focused tests, and Tier 2 bundle greps for `connect:probe`, `probeConnection`, and scoped runtime CSP remote resource-origin logic.
- Resolution review preserved upstream preview refresh behavior (`refreshOpenPreviewDocumentsForResourceChange`, `markDeskTreeDirtyForResourceChange`) and fork optimistic attachment hydration (`appendInterludeItem` plus optimistic attachment merge helpers).
- The office-workflow example now documents the `ctx.dataDir` versus `ctx.resources` boundary, `SessionFile`, `writeExpectedVersion`, and future `sessionPermission` requirements; the upstream issue tracker now includes `office-workflow-resourceio-session-permission`.
- Tier 3A local desktop install/version verification passed: `/Applications/HanaAgent.app` was rebuilt with `SKIP_NOTARIZE=true npm run install:local`, codesign verified, `CFBundleShortVersionString`, `CFBundleVersion`, and `build-info.json.appVersion` all reported `0.341.19`; `build-info.json` reported `channel: local`, `sourceRepo: karlorz/openhanako`, `baseTag: v0.341.19`, `dirty: false`, `updateEnabled: false`, and `signatureKind: adhoc`.
- Tier 3B live sg01 smoke passed: the helper restart/verify path returned identity HTTP 200 and WebSocket open; CDP UI smoke uploaded and sent an image, switched chats and returned, then confirmed `Files 1`, the chat attachment image, and Conversation Files previews remained visible. Non-blocking console warnings were observed for session permission default 404 and resource-events watch parsing; no CSP refusal, WebSocket disconnect, or preview persistence failure was observed.
- PR #1 remains the permanent draft dashboard and was not merged, auto-merged, or closed.

## Sync log

| Date | Upstream tag | Conflicts | Resolution | Tests | Live smoke | Notes |
|------|--------------|-----------|------------|-------|------------|-------|
| 2026-06-15 | `v0.323.0` (baseline) | — | — | — | — | Fork established from upstream `v0.323.0`. `dev` at `434c3e30`. No later upstream sync performed yet. |
| 2026-06-22 | `v0.333.6` | LAN/remote preview behavior, package metadata, SDK tarball vs office-workflow tests, `custom_remote` wsTicket coverage vs LAN query-token WebSocket behavior, and duplicated preview-refresh helper block. | Preserved fork LAN/remote attachment preview behavior, accepted upstream `0.333.6` package metadata, skipped obsolete `0.323.0-karlorz.*` release bump commits, kept both SDK tarball and office-workflow coverage, retained upstream `custom_remote` wsTicket tests while preserving LAN query-token WS behavior, and removed the duplicate preview-refresh helper block. | Post-rebase Tier 1/Tier 2 passed via `node scripts/sync-upstream.mjs --post-rebase`; final focused helper/sync vitest passed with 28 tests; `npm run typecheck`, `git diff --check`, and conflict-plan local-only passed. | Tier 3A installed/codesigned local HanaAgent `0.333.6`; Tier 3B helper restart/verify returned identity 200 and WS open; image paste/upload, send, switch/return, returned thumbnail, and new plus historical Conversation Files previews rendered with no observed CSP/WS/fetch errors. | PR #1 remains the permanent draft dashboard; it was not merged, auto-merged, or closed. |
| 2026-06-24 | `v0.341.19` | No rebase conflicts; package metadata accepted as `0.341.19`, with `package-lock.json` root-version alignment only. | Preserved upstream preview-refresh/resource-change handlers and fork optimistic attachment hydration; refreshed office-workflow ResourceIO/sessionPermission docs/tests and added the matching upstream issue tracker row. | `node scripts/sync-upstream.mjs` passed Tier 0/1/2; post-rebase focused sync/helper/install tests passed with 95 tests; focused office-workflow/plugin-sdk/tracker tests passed with 34 tests; `npm run typecheck`, `git diff --check`, and `node scripts/track-upstream-issues.mjs status` passed. | Tier 3A installed/codesigned local HanaAgent `0.341.19`; Tier 3B helper verified identity 200 and WS open; CDP UI smoke uploaded/sent an image, switched away/back, and confirmed chat thumbnail plus Conversation Files preview persistence. | PR #1 remains the permanent draft dashboard and was untouched. Non-blocking session-permission/resource-events console warnings were observed, with no CSP or WebSocket failure. |
