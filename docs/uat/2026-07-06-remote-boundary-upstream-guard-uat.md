# Remote Boundary Upstream Guard UAT Checklist

Date: 2026-07-06
Branch: `codex/remote-boundary-upstream-guard`
Scope: follow-up fixes from the Claude review report in `/Users/karlchow/wiki/raw/transcripts/2026-07-06-note-codex-remote-boundary-upstream-guard-review.md`.

## Code Review Fixes Covered

- Settings Access tab now hydrates matching `remoteConnectionRecovery` state from the main renderer recovery mirror.
- Retry/connect flows now validate `validateRemoteBoundaryContract` before persisting or reloading a Remote Server selection.
- The main app body gates `ChatSidebar` and `AppPages` while active remote recovery is present, so the recovery banner is the only interactive surface inside the app body.
- Remote credential inputs return to password mode when a parent replaces the secret value.
- Revoked or rejected web-auth credentials are shown as `auth_failed` instead of generic invalid identity.
- Malformed local-ish connections no longer synthesize `sf_*` remote resource URLs.
- The onboarding remote-key row is full width again.
- Access tab "Connect another Remote Server" now clears the URL/key form instead of duplicating Retry.

## Automated Verification Already Run

```sh
npx vitest run desktop/src/react/__tests__/services/server-connection.test.ts desktop/src/react/__tests__/services/resource-url.test.ts desktop/src/react/__tests__/services/remote-connection-recovery.test.ts desktop/src/react/__tests__/components/RemoteConnectionRecovery.test.tsx desktop/src/react/__tests__/settings/SettingsContent.test.tsx desktop/src/react/__tests__/components/App.remote-recovery.test.tsx --exclude "**/node_modules/**"
```

Result: 59 tests passed.

```sh
npx vitest run desktop/src/react/__tests__/app-init.test.ts desktop/src/react/__tests__/settings/AccessTab.test.tsx desktop/src/react/onboarding/__tests__/OnboardingApp.test.tsx tests/csp-sync.test.ts desktop/src/react/__tests__/components/MainContent.drag.test.tsx desktop/src/react/__tests__/components/InputArea.paste-and-slash.test.tsx desktop/src/react/__tests__/components/InputArea.media-send.test.tsx desktop/src/react/__tests__/services/ws-message-handler.test.ts desktop/src/react/__tests__/services/resource-url.test.ts desktop/src/react/__tests__/stores/chat-slice.test.ts desktop/src/react/__tests__/stores/selectors/file-refs.test.ts desktop/src/react/__tests__/components/shared/MediaViewer/media-source.test.ts desktop/src/react/__tests__/utils/open-media-viewer.test.ts desktop/src/react/__tests__/utils/user-attachment-media.test.ts desktop/src/react/__tests__/components/RightWorkspacePanel.test.tsx tests/upload-route.test.ts --exclude "**/node_modules/**"
```

Result: 260 tests passed.

```sh
npm run typecheck
git diff --check
```

Result: both passed.

### 2026-07-07 Follow-up Verification

Follow-up scope: recovery i18n readiness and a Settings shortcut back to onboarding.

```sh
npx vitest run desktop/src/react/__tests__/app-init.test.ts desktop/src/react/__tests__/components/RemoteConnectionRecovery.test.tsx desktop/src/react/__tests__/settings/AccessTab.test.tsx --exclude "**/node_modules/**"
```

Result: 28 tests passed. The startup regression now verifies that a saved Remote Server recovery path loads locale data before `platform.appReady()`, so the recovery panel can render real copy instead of raw translation keys.

```sh
npm run typecheck
git diff --check
```

Result: both passed.

Packaged app follow-up UAT:

```sh
SKIP_NOTARIZE=true npm run install:local
codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
node scripts/hana-desktop-smoke-helper.mjs --restart --verify --url http://100.125.173.118:14500 --timeout-ms 20000
```

Result: local install completed, codesign verification passed, and the smoke helper verified sg01 identity HTTP `200`, identity OK, and WebSocket OK without printing the saved token.

Renderer CDP locale coverage:

- `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/13-locale-coverage.json`

Result: English, Simplified Chinese, Traditional Chinese, Japanese, and Korean recovery screens all rendered localized title/status/form/action copy with no visible `app.remoteRecovery.*`, `settings.access.remoteReason.*`, or `settings.access.remoteWarning.*` keys. The same locale pass verified Settings -> Access onboarding shortcut copy and button visibility in local-owner mode with no raw `settings.access.*` shortcut keys. English invalid retry remained inline as `connect probe failed: login HTTP 403` on the same `index.html` renderer URL, and the English onboarding shortcut opened `onboarding.html` with the success toast visible.

### 2026-07-07 Simplify Pass

Follow-up scope: `dev-loop:simplify-worker` reuse/simplification/efficiency/altitude pass on the working-tree diff for the three in-progress remote work items (`remote-compatibility-surface`, `remote-control-plane-contract`, `remote-resource-ownership-sweep`). The pass is quality-only — no behavior change.

Changes applied (uncommitted):

- Extracted shared `assertRemoteBoundaryContract(connection, identity)` in `desktop/src/react/services/remote-boundary-contract.ts`; `desktop/src/react/services/server-connection.ts` now imports it instead of duplicating the throw path.
- `desktop/src/react/app-init.ts` `loadRecoveryI18n` now reuses the existing `fetchConfig()` (5s in-memory cache) instead of a duplicate `/api/config` fetch, then calls `applyLocale`. Dropped now-unused imports.
- Added shared `remoteRecoveryForActiveConnection(recovery, activeConnectionId)` in `desktop/src/react/services/remote-connection-recovery.ts`; `App.tsx`, `RemoteConnectionRecovery.tsx`, and `SettingsContent.tsx` now call it instead of re-deriving the "recovery matches active connection" comparison.

```sh
npm run typecheck
```

Result: passed.

```sh
npx vitest run desktop/src/react/__tests__/app-init.test.ts desktop/src/react/__tests__/components/RemoteConnectionRecovery.test.tsx desktop/src/react/__tests__/services/remote-connection-recovery.test.ts desktop/src/react/__tests__/services/resource-url.test.ts desktop/src/react/__tests__/services/server-connection.test.ts desktop/src/react/__tests__/settings/AccessTab.test.tsx desktop/src/react/__tests__/settings/SettingsContent.test.tsx desktop/src/react/onboarding/__tests__/OnboardingApp.test.tsx desktop/src/react/__tests__/components/App.remote-recovery.test.tsx
```

Result: 9 files, 86 tests, all passed.

## Desktop UAT Setup

- Install local app build:

```sh
SKIP_NOTARIZE=true npm run install:local
codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
```

- Open `/Applications/HanaAgent.app`.
- Use remote server: `http://100.125.173.118:14500`.
- If this profile already has a saved LAN connection, use:

```sh
node scripts/hana-desktop-smoke-helper.mjs --restart --verify --url http://100.125.173.118:14500
```

## Automation Capability Check

Run timestamp: 2026-07-06 22:21-22:31 JST

- `~/.codex/config.toml` `node_repl` startup path was repaired from the removed Codex resource paths to:
  - command: `/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl`
  - `NODE_REPL_NODE_PATH`: `/Applications/Codex.app/Contents/Resources/cua_node/bin/node`
- `node_repl` MCP smoke passed in this thread with `{ "ok": true }`.
- Computer Use plugin is enabled and its MCP client process is running, but this already-running Codex thread did not expose a callable `mcp__computer_use...` namespace after enablement. A fresh Codex thread or app/plugin reload should be used before relying on direct Computer Use actions.
- Fallback automation path is usable now:
  - Electron CDP via `scripts/hana-desktop-smoke-helper.mjs`.
  - Full-screen screenshot via `/usr/sbin/screencapture`.
  - Short video via `/usr/sbin/screencapture -v`.
  - Pointer automation via `cliclick` is installed, but Accessibility permission was not enabled, so click/type automation needs a human permission grant first.

## Automated UAT Evidence Captured

Artifacts are under:

`docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/`

- `probe-screen.png`: screenshot capture probe, 1920x1080.
- `probe-recording.mov`: video capture probe, 2.716667 seconds. Initial command returned a final-location warning, but `ffprobe` validated the movie.
- `01-hanaagent-remote-connected.png`: live HanaAgent branch build with normal chat shell loaded against sg01, 1920x1080.
- `01-hanaagent-remote-connected.mov`: live HanaAgent branch build recording, 4.85 seconds.

Build and app verification:

```sh
SKIP_NOTARIZE=true npm run install:local
codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
```

Result: local install completed, app signed, and codesign verification passed. Build info:

```json
{
  "appVersion": "0.350.2",
  "channel": "local",
  "sourceRepo": "karlorz/openhanako",
  "gitSha": "1b9e37ee5f72",
  "baseTag": "v0.350.2-karlorz.1",
  "dirty": true,
  "updateEnabled": false,
  "signatureKind": "adhoc"
}
```

Remote connection helper:

```sh
node scripts/hana-desktop-smoke-helper.mjs --restart --verify --url http://100.125.173.118:14500 --timeout-ms 20000
```

Result: passed. The helper restored the saved sg01 LAN connection without printing the token, then verified:

- identity fetch status: `200`
- identity OK: `true`
- WebSocket OK: `true`
- active base URL: `http://100.125.173.118:14500`
- active WebSocket URL: `ws://100.125.173.118:14500`

Renderer CDP state check:

- page title: `HanaAgent`
- active connection kind: `lan`
- active connection auth state: `paired`
- active connection trust state: `lan`
- active connection has token: `true`
- active connection capabilities include `chat`
- active connection has `executionBoundary`
- mirrored recovery localStorage state: `null`
- recovery text visible in DOM: `false`

## UAT Checklist

### 2026-07-07 Follow-up Human Checklist

- [x] Install the updated local app and reproduce Remote Server recovery with a missing required boundary capability.
  Expected: the recovery panel still gates the app body, but visible labels are localized user copy, for example `Remote Server needs attention`, `Compatibility check failed`, `Server URL`, `Access key`, `Retry remote`, and `Switch to local`. No visible `app.remoteRecovery.*`, `settings.access.remoteReason.*`, or `settings.access.remoteWarning.*` keys should appear.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/09-recovery-localized.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/13-locale-coverage.json`
  CDP notes: missing-chat identity interception produced `compatibility_failed`, reason `missing_core_capability`, warning `missing_optional_capability`, and `appBodyGated: true`. The English recovery screenshot shows localized user copy and no raw recovery/settings reason keys.
  Existing issue evidence to compare against:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/02-recovery-gated-shell.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/03-inline-boundary-error.png`
  Note: those two screenshots are pre-fix assets; they intentionally show raw key text and are now superseded by the 2026-07-07 follow-up screenshots.

- [x] From the localized recovery panel, retry with an invalid/rejected access key.
  Expected: the retry failure remains inline, the app does not reload-loop, and the surrounding labels/buttons remain localized user copy.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/10-inline-retry-localized.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/13-locale-coverage.json`
  CDP notes: retry with `hana_dev_invalid_uat_key` surfaced inline `connect probe failed: login HTTP 403`; the page stayed on packaged `index.html`, the recovery labels/buttons remained localized English copy, and raw recovery/settings reason keys were absent.

- [x] Open Settings -> Access while using the local server.
  Expected: a localized Onboarding section appears with an `Open Onboarding` action. The action should be visible only in the local-owner Access tab, alongside LAN/mobile/desktop access controls.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/11-settings-access-open-onboarding.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/13-locale-coverage.json`
  CDP notes: local-owner mode had `activeServerConnectionId: null`; Settings -> Access showed the localized Onboarding section and button. The screenshot is from the Korean language pass and shows the shortcut in the local-owner Access tab alongside the LAN/mobile/computer access controls.

- [x] Click Settings -> Access -> Open Onboarding.
  Expected: the onboarding window opens directly through the existing Electron onboarding flow, and Settings shows the existing success toast. If the preload API is unavailable, Settings should show a localized failure toast instead of silently doing nothing.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/12-open-onboarding-window.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/13-locale-coverage.json`
  CDP notes: before clicking, stale onboarding windows were closed. The English shortcut opened `file:///Applications/HanaAgent.app/Contents/Resources/app.asar/desktop/dist-renderer/onboarding.html`, and Settings showed the localized success toast `Onboarding window opened`.

- [x] Switch the app language and repeat the recovery-screen and Settings-shortcut checks.
  Expected: recovery copy and the onboarding shortcut both use locale JSON strings; no raw keys appear in English, Simplified Chinese, Traditional Chinese, Japanese, or Korean.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260707-followup/13-locale-coverage.json`
  CDP notes: the locale pass covered `en`, `zh-CN`, `zh-TW`, `ja`, and `ko`. For each locale, recovery title/status/server URL/access key/retry/switch-local strings were present, Settings -> Access onboarding title/hint/button strings were present in local-owner mode, and the raw-key match list was empty.

- [x] Start HanaAgent with a saved Remote Server whose identity/boundary is valid.
  Expected: app loads normally, no recovery panel appears, Settings -> Access shows Remote Server metadata and "Ready" or warning-only compatibility status.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/01-valid-remote-access-tab.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/01-valid-remote-access-tab.mov`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/01-hanaagent-remote-connected.png`
  CDP notes: Settings -> Access showed Remote Server metadata, compatibility `Ready`, URL `http://100.125.173.118:14500`, server version `0.346.18`, auth state `Paired`, trust state `LAN trusted`, and Chat/Files/Resources/Settings/Bridge/Providers capabilities.

- [x] Start HanaAgent with a saved Remote Server that fails boundary validation, for example missing `chat` capability or execution-boundary metadata.
  Expected: recovery panel appears. Chat sidebar and app pages are not mounted or clickable under the panel. Settings -> Access shows the same reason codes.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/02-recovery-gated-shell.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/02-recovery-gated-shell.mov`
  CDP notes: reload interception returned identity metadata missing the required `chat` capability. Recovery localStorage status was `compatibility_failed`, reason codes were `["missing_core_capability"]`, and warning codes were `["missing_optional_capability"]`.

- [x] From the recovery panel, retry with a Remote Server that still fails the boundary contract.
  Expected: failure stays inline in the recovery panel; the app does not persist/reload into the same failing loop.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/03-inline-boundary-error.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/03-inline-boundary-error.mov`
  CDP notes: retry with `hana_dev_invalid_uat_key` surfaced inline error `connect probe failed: login HTTP 403`. Recovery localStorage remained `compatibility_failed`, the active saved sg01 connection was unchanged, and the page stayed on the same `index.html` location without a reload loop.

- [x] From Settings -> Access on a remote connection, press "Connect another Remote Server".
  Expected: URL and key fields clear for a new server. Pressing Retry still uses the currently entered form values.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/04-connect-another-cleared-form.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/04-connect-another-cleared-form.mov`
  CDP notes: before pressing the control the URL field held `http://100.125.173.118:14500`; after pressing it, URL and key value lengths were both `0`, while the active saved connection remained unchanged.

- [x] Reveal a remote access key, then switch/retry to a connection that replaces the key value.
  Expected: the replacement key renders masked; it is not shown as plain text after the value change.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/05-key-remasked-after-value-change.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/05-key-remasked-after-value-change.mov`
  CDP notes: before reveal, key input type was `password` with value length `52`; after pressing Show, input type was `text`; after parent value replacement through "Connect another Remote Server", input type returned to `password`, value length was `0`, and the toggle returned to `Show`. Token contents were not printed.

- [x] Use a revoked or wrong device credential against the Remote Server.
  Expected: recovery/status reason says the remote access key was rejected, not only "Server identity could not be verified".
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/06-auth-failed-reason.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/06-auth-failed-reason.mov`
  CDP notes: reload interception returned HTTP 401 for `/api/web-auth/login`; recovery localStorage status was `identity_failed`, reason codes were `["auth_failed"]`, and warning codes were empty.

- [x] Run onboarding from a clean profile and expand "Connect to existing Remote Server".
  Expected: remote URL field and key field align; the key field toggle is inside the same full-width input row.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/07-onboarding-key-row.png`
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/run-20260706-222135/07-onboarding-key-row.mov`
  CDP notes: packaged onboarding page was opened directly, switched to English, and expanded to the Remote Server form. URL input and key input both measured width `360` at x `663`; the Show toggle was inside the key row at x `976`, y `887`. The normal sg01 app shell was restored afterward with the smoke helper.

- [x] Live remote attachment smoke against sg01: paste/upload an image, send it, switch chats, return.
  Expected: chat thumbnail and Conversation Files preview still render, including older sessions.
  Evidence:
  - `docs/uat/assets/2026-07-06-remote-boundary-upstream-guard/08-remote-image-preview.png`
  CDP notes: a generated non-sensitive PNG named `hanaagent-uat-2026-07-06.png` was attached through the packaged app file input, uploaded to sg01, sent in the existing `Image Preview Smoke Test` session, switched away to `Recent Changelogs Guide`, then returned. After return, the active session remained `Image Preview Smoke Test`; the generated PNG was visible in the chat thumbnail/attachment area and the Conversation Files list; existing older image entries such as `Pasted image.png`, `hana-smoke-visible_...jpg`, and prior `openhanako-sync-smoke...` files were still listed. The remote provider later surfaced `LLM returned invalid JSON (status=200)`, but that occurred after send acceptance and did not block attachment thumbnail or Conversation Files rendering.

## Notes For Reviewer

- All original 2026-07-06 checklist rows and all five 2026-07-07 follow-up rows now have captured evidence. Rows 1-7 from the original batch also have short screen recordings under `run-20260706-222135/`; the live upload row and follow-up rows use screenshots plus CDP/JSON evidence.
- `02-recovery-gated-shell.png` and `03-inline-boundary-error.png` remain before-fix evidence for the raw-key regression. Use `run-20260707-followup/09-recovery-localized.png` and `run-20260707-followup/10-inline-retry-localized.png` as the fixed successor screenshots.
- Direct Computer Use is enabled but was not callable in this already-running thread after enablement. Use a fresh Codex thread/app reload for direct Computer Use, or continue with the proven CDP plus `screencapture` path.
- Grant Accessibility permission to the Codex/Terminal host before expecting `cliclick` or AppleScript UI click/type automation to operate hands-free.
- Keep PR #1 untouched. This branch is `codex/remote-boundary-upstream-guard`; do not merge or auto-merge the permanent dashboard PR.
