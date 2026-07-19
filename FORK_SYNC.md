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
| LAN query-token network hardening | `draft/pending-approval` | No exact issue found; related [#1749](https://github.com/liliMozi/openhanako/issues/1749) and [#1811](https://github.com/liliMozi/openhanako/issues/1811) | Review `docs/upstream-issues/drafts/lan-query-token-network-hardening.md`; normally fold into the LAN auth issue unless reviewed separately. |
| Remote plugin iframe credential query leak | `draft/pending-approval` | No exact issue found; related [#1493](https://github.com/liliMozi/openhanako/issues/1493), [#1546](https://github.com/liliMozi/openhanako/issues/1546) | Review `docs/upstream-issues/drafts/plugin-iframe-remote-credential-query-leak.md`; submit only after owner approval. |
| Remote attachment preview persistence | `draft/pending-approval` | No exact issue found | Review `docs/upstream-issues/drafts/remote-attachment-preview-persistence.md`; submit only after owner approval. |
| Desktop temp upload session-cache materialization | `draft/pending-approval` | No exact issue found | Review `docs/upstream-issues/drafts/desktop-temp-upload-session-cache-materialization.md`; submit only after owner approval. |
| Marker-only image replay regenerate 400 | `draft/pending-approval` | No exact issue found | Review `docs/upstream-issues/drafts/session-replay-marker-only-image-regenerate.md`; submit only after owner approval. |
| ToolGroup file-detail link context | `draft/pending-approval` | No exact issue found | Review `docs/upstream-issues/drafts/toolgroup-file-detail-link-context.md`; submit only after owner approval. |
| Provider model-removal persistence | `draft/pending-approval` | No exact issue found | Review `docs/upstream-issues/drafts/provider-model-removal-persistence.md`; submit only after owner approval. |
| Remote skill viewer local-file IPC | `draft/pending-approval` | No exact issue found | Review `docs/upstream-issues/drafts/remote-skill-viewer-local-file-ipc.md`; submit only after owner approval. |
| Remote skill install client-local path | `draft/pending-approval` | No exact issue found | Review `docs/upstream-issues/drafts/remote-skill-install-client-local-path.md`; submit only after owner approval. |
| Legacy raw release profile and evidence | `tracked/no-upstream-issue` | Fork-only release policy | Keep the explicit signed/auto/legacy-raw resolver, raw asset exclusions, and runtime-only standalone server bundle evidence under local review. |
| Fork-only maintenance | `tracked/no-upstream-issue` | Local build identity, fork-sync/dev-loop runbooks, office-workflow examples, server installer/reinit safety, and CI file-mode hygiene | Keep local. The complete generated inventory is `docs/upstream-issues/README.md`; do not create upstream issue noise for fork-only work. |

## Sync cadence

- **Stable release-tag sync, manual.** Pull when upstream cuts a new non-prerelease release tag. Do NOT track `main` HEAD and do NOT treat prereleases as production sync targets.
- **Tag namespace.** Plain `vX.Y.Z` tags belong to upstream release sync targets. Do not create, retarget, or push a plain upstream tag in the fork. Fork-published release tags use `vX.Y.Z-karlorz.N` so upstream tag fetches remain clobber-free.
- **Permanent PR dashboard.** PR [#1](https://github.com/karlorz/openhanako/pull/1) is a permanent draft dashboard from `dev` to `main`. It is for human review and agent drilldown only; never merge it.
- **Dashboard base.** `origin/main` is a disposable mirror of `liliMozi/openhanako/main`. The conflict dashboard helper may replace `origin/main` from `upstream/main`, but it must never mutate `dev`, the index, or the working tree.
- **Machine-readable rules:** `docs/fork-sync/rules.yml` is the source of truth for release-target policy, diverging-file rules, fork-only-file rules, issue-tracking states, and verification commands. This runbook explains the same policy for humans.
- **Detection:** run `node scripts/sync-upstream.mjs --check` anytime. It compares the latest stable upstream release tag against the sync log (below), reports diverging files upstream touched, and verifies all `forkOnlyFiles` patterns still match tracked files in the working tree.
- **Fork-only file protection:** `docs/fork-sync/rules.yml` `conflictRules.forkOnlyFiles` lists fork-only new files (scripts, tests, docs, examples, config) that do not exist upstream. After every rebase, the sync helper runs a Tier 0 gate that verifies each pattern still matches at least one tracked file. If any go missing, the sync fails before Tier 1 tests — an upstream rebase that silently drops a fork feature is caught here, not by indirect test breakage.
- **Dashboard refresh:** run `node scripts/sync-upstream.mjs --conflict-plan` anytime. It refreshes `origin/main` from `upstream/main`, computes a dry-run merge-tree plan against `origin/dev`, updates the generated block in PR #1, and leaves `dev` untouched.
- **Package version ownership:** package version and lockfile root metadata changes are deferred to the attended stable production fork sync. Do not pre-bump `package.json` or `package-lock.json` just to reduce dashboard conflicts.
- **Prerelease review:** run `node scripts/sync-upstream.mjs --include-prerelease --check` only when intentionally reviewing a prerelease candidate. This is not the normal production update path.
- **Issue check:** as part of every sync, run `node scripts/track-upstream-issues.mjs search` and glance at [#1749](https://github.com/liliMozi/openhanako/issues/1749) plus the pending draft list. If upstream accepted equivalent fixes, the divergence shrinks.

## Release profile policy

- **Tag fallback is automatic:** an ordinary `v*` tag push requests `auto`, which resolves to `signed` only with validated Ed25519 material and otherwise selects the marked `legacy-raw` fallback when both signing inputs are blank. Malformed, unreadable, or incompatible nonblank material is an error.
- **Attended commands share the resolver:** manual workflow dispatch and local `npm run dist:auto`, `npm run pack:auto`, and `npm run install:local:auto` resolve once through the same policy before packaging.
- **Concrete downstream contract:** only `signed` or `legacy-raw` may reach package metadata, builders, asset verification, train publication, or mirroring. `auto` is a selector, not a release profile.
- **Release assets are profile-immutable:** the release job writes a profile marker before other uploads, accepts only same-profile reruns, and rejects opposite-profile or unmarked nonempty asset sets before mutation.
- **Raw evidence boundary:** legacy-raw installers are visibly marked and ship the bundled renderer plus runtime-only server tree. They publish installers, standalone server bundles, compatibility metadata, checksums, and the committed digest, but never shell updater metadata, hot-update archives, train pointers, or AtomGit mirror assets.
- **Server installation remains separate:** runtime-only standalone bundles stay installable through `scripts/install-server.mjs`; selecting a profile does not deploy, upgrade, tag, or publish anything.

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
| `desktop/src/react/services/resource-url.ts` | **CRITICAL** — resource URL resolution for remote session files and LAN device-credential connections | **HUMAN REVIEW.** Remote `sf_*` session files without explicit resource links must synthesize `/api/resources/res_<fileId>/content` with token query support. Preserve the fork transport invariant: `isLocalTransport` is `!connection || connection.kind === 'local'`, not `isLocalOwnerConnection(connection)`, because LAN device-credential connections still need token-query resource URLs. |
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

### Remote boundary credential UI

| File | Risk if upstream touches | Resolution policy |
|------|--------------------------|-------------------|
| `desktop/src/react/settings/widgets/KeyInput.tsx` | **HIGH** — the fork uses external-value detection to clear a transient revealed remote credential, while upstream now uses wrapper-level blur handling for Bridge credential drafts | **PRESERVE BOTH.** Start from upstream's stable version and keep its wrapper blur/accessibility behavior, then restore the fork `previousValueRef` / `internalChangeRef` reset-and-rehide behavior. Verify remote recovery, Access settings, provider credentials, and Bridge credentials together. |

### Desktop packaging metadata

| File | Risk if upstream touches | Resolution policy |
|------|--------------------------|-------------------|
| `package.json` | Medium | **DEFER.** Stable production fork sync owns package version alignment. Dashboard-only conflict reduction must not pre-bump the version; preserve the fork baseline and `install:local` behavior until the attended sync resolves both together. |
| `package-lock.json` | Medium | **DEFER.** Do not regenerate or pre-bump lockfile root metadata for the dashboard. Regenerate only during the stable production fork sync after the package version decision. |
| `release-digest.v1.json` | Medium | **TAKE UPSTREAM STABLE, THEN FORK-ALIGN AFTER VERIFICATION.** Do not copy a prerelease digest into `dev`. During the attended stable rebase, accept the upstream stable digest; only after Tier 0-3 succeeds should the fork release closeout align `tag` and `version` to `vX.Y.Z-karlorz.N`. |

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
4. **`4c82293b` + 2026-06-30 review follow-up** — marker-only image replay regenerate 400
   - Persisted `[attached_image: ...]` marker-only user turns replay as marker/path-backed inputs, not synthesized direct provider image payloads.
   - Trusted optimistic/display-message image attachments can still rebuild direct image payloads before a source entry is persisted.
   - Confirmed local sends that keep `client-user-*` UI ids still prefer a valid persisted `sourceEntryId`, branch before the original user turn, and emit `session_branch_reset`.
   - Oversized aggregate `session-meta.json` compacts prompt/memory snapshots into contained `session-meta-payloads/` sidecars.
   - + tests in `tests/session-turn-actions.test.ts`, `tests/session-meta-write-serialization.test.ts`, `tests/sessions-route.test.ts`, and `desktop/src/react/__tests__/hooks/use-hana-fetch.test.ts`.
5. **`b9d8a730`** — ToolGroup file-detail links preserve session context
   - `AssistantMessage` passes `{ origin: 'session', sessionPath, messageId, blockIdx }` into `ToolGroupBlock`.
   - Tool detail click and context-menu handlers pass that context to `openInternalLink`.
   - + tests in `desktop/src/react/__tests__/components/ToolGroupBlock.test.tsx`.

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
- `KeyInput.tsx` is an explicit `preserve-both` exception; `release-digest.v1.json` takes the eventual upstream stable digest and is fork-aligned only after full verification.
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
12. **Detailed changelog note** — after verification, create a raw changelog
    note under the SkillWiki vault:
    `raw/transcripts/YYYY-MM-DD-changelog-sync-stable-vX-Y-Z.md`.
    Use `kind: note`, `project: "[[openhanako]]"`, and
    `closes_work_item: projects/openhanako/work/YYYY-MM-DD-sync-stable-vX-Y-Z/spec.md`
    so the changelog remains searchable project evidence without becoming
    claimable dev-loop work. Include the sync summary and SHAs, upstream commit
    themes, fork behavior preserved, conflict-risk resolution table, Tier 0-3
    verification evidence, release/tag outcome when a fork release is produced,
    and any workflow lessons.

## Fork release tags

After a stable sync is complete and verified, publish this fork from `dev` with a fork-scoped tag:

```bash
git tag vX.Y.Z-karlorz.N dev
git push origin refs/tags/vX.Y.Z-karlorz.N
```

Do not push `vX.Y.Z` to `origin` for fork releases. The local plain tag should continue to resolve to the upstream release commit so `git fetch upstream --tags` and `node scripts/sync-upstream.mjs` remain safe.

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

## Stable sync activation and closeout boundary

- 2026-07-18: upstream stable `v0.407.15` was activated as the attended sync target and `dev` was rebased onto upstream commit `ab8d508e3ca4`. Package and lockfile metadata now report `0.407.15`; the upstream release digest remains `v0.407.15` / `0.407.15`.
- The pre-rebase state is preserved by `codex/backup-dev-before-v0.407.15-sync-20260718` at `28125675b667a`. The completed local sync head before this documentation closeout is `b51f150a2c1a`.
- The rebase required multiple conflict batches and semantic adaptations across session-scoped stores, attachment hydration, updater/announcement identity, compaction, provider credentials, `KeyInput`, installer activation, server protocol diagnostics, resource transport, and the signed train/renderer pipeline. Resolutions preserved compatible upstream and fork behavior rather than choosing one side wholesale.
- The obsolete fork replay that would have restored the old `v0.357.17-karlorz.1` release digest was skipped. Do not align `release-digest.v1.json` to a new fork tag until a separately attended fork-release publication phase.
- Upstream's artifact-core activation is now present. The fork retains its current-symlink server activation, checksum blocking, and rollback behavior; installer characterization was updated to assert that combined contract.
- Local build metadata initially selected the co-located `train-12` tag instead of stable `v0.407.15`. Commit `b51f150a` restricts build-info tag discovery to stable `v[0-9]*` tags and adds regression coverage.
- Tier 0-3 verification is complete, including post-rebase fork-presence/focused/bundle gates, broad migration and conflict suites, typecheck, local-only conflict planning, an installed/codesigned `0.407.15` desktop app, helper identity/WebSocket verification, and live remote image upload plus chat-switch/Conversation Files preview persistence.
- The live smoke observed non-blocking `/api/input-drafts` 404 responses because sg01 still runs an older server, plus one unrelated stale historical resource returning 410. The newly uploaded resource loaded successfully, with no CSP refusal or WebSocket disconnect.
- Closeout boundary: no sg01 deployment, push, fork tag, fork release, PR #1 merge/close/auto-merge, or release-digest fork alignment occurred. The detailed SkillWiki changelog note is deferred because the shared vault contains unrelated dirty and review-required work; do not absorb or auto-stage it.

## Latest sync closeout

- 2026-07-18: `dev` was rebased from the prior stable baseline `v0.357.17` onto upstream stable `v0.407.15` (`ab8d508e3ca4`). Package metadata and the retained upstream digest report `0.407.15`; `dev` reached `b51f150a2c1a` after characterization and local-build tag-selection follow-ups.
- Conflict resolution preserved upstream session-ID ownership, train announcements, signed artifact-core/renderer behavior, provider widgets, compaction, and protocol diagnostics while retaining fork LAN auth/probing, scoped remote-resource CSP, optimistic attachment bytes, resource previews, disabled updater identity, current-symlink installer safety, and remote-boundary assertions.
- The old fork release-digest replay was intentionally skipped. The stable digest remains upstream-owned; no `v0.407.15-karlorz.N` tag or release has been created.
- `node scripts/sync-upstream.mjs --post-rebase` passed Tier 0 fork-only file presence, Tier 1 focused LAN/auth/CSP/remote-preview tests, Tier 2 main/preload builds and marker greps, and scoped remote resource-origin checks.
- Additional fresh and accumulated gates passed: broad conflict/migration/provider/resource suites, installer migration safety, WebSocket/cache characterization, `tests/sync-upstream.test.mjs`, `tests/local-build-info.test.mjs`, `tests/auto-updater.test.ts`, `tests/install-server-upgrade.test.mjs`, `tests/csp-sync.test.ts`, `npm run typecheck`, `git diff --check`, and local-only conflict planning.
- Tier 3A rebuilt `/Applications/HanaAgent.app` as local `0.407.15`. The upstream signed seed requirement was validated with a one-time temporary Ed25519 key/keyset that was deleted immediately afterward; no production signing material was used. Codesign passed, and installed build info reports local channel, upstream base tag `v0.407.15`, updates disabled, and ad-hoc app signing.
- Tier 3B helper verification returned identity HTTP 200, valid token-auth identity, and WebSocket open. The UI smoke uploaded `Hanako.jpg`, sent it, switched chats and returned, confirmed its transcript thumbnail and Conversation Files entry, and opened a complete `1024x1024` MediaViewer image. No CSP refusal or WebSocket disconnect occurred; old-server input-draft 404s and one stale historical-resource 410 were non-blocking.
- PR #1 remains the permanent draft dashboard and was not merged, auto-merged, closed, or remotely refreshed during closeout. No push, sg01 deployment, fork tag, or fork release occurred. The SkillWiki changelog note remains deferred pending safe isolation of the dirty shared vault.

## Attended fork-release closeout (v0.407.15 line)

The post-sync development line now includes the Phase 1-3 remote-server
assessment and feature-contract work, the unified server installer/build
identity and compatibility-manifest flow, and provider-neutral BYOK release
digest generation. These are fork-maintained surfaces and are protected by the
expanded `forkOnlyFiles` and explicit divergence policies in
`docs/fork-sync/rules.yml`.

Before a fork release is created, the attended gate is:

1. Run the upstream stable/issue checks and record the result. On this line,
   upstream stable is still `v0.407.15`; issue search confirms #1749 remains
   open, #1811 remains closed, and no exact matches were found for the pending
   local drafts. The tracker is search/status-only and never submits issues.
2. Run the sync rule, focused remote-assessment/release suites, typecheck,
   diff check, desktop/server builds, and compatibility-manifest validation.
3. Generate a temporary digest through the configured generic
   `model`/`base_url`/`api_key`/`api_backend` environment, validate it, inspect
   its commit range and secret scan, and only then align the committed digest
   to the exact final fork release commit and tag.
4. Publish the fork-scoped tag `v0.407.15-karlorz.N` and verify the release has
   the linux-arm64 server archive, checksum, compatibility manifest, digest,
   and history assets before marking it stable/latest.
5. On sg01, run `install-server status`, a pinned stable upgrade dry-run,
   backup, and only then the attended execute step. Verify the current symlink,
   service health, build identity, compatibility contracts, `/mobile/`, and
   localized mobile strings.
6. Reinstall/codesign the local desktop if required and complete the live
   smoke: identity, WebSocket, image paste/upload/send, chat switch/return,
   transcript thumbnail, and Conversation Files preview.

No release, tag, push, or sg01 deployment is implied by this checklist until
each corresponding command and artifact has fresh evidence. PR #1 remains a
permanent draft dashboard and is never a merge vehicle.

## Latest fork patch closeout

- 2026-06-30: patch target `v0.346.18-karlorz.5` remains on upstream package version `0.346.18` and carries the replay/link-context fixes reviewed from `4c82293b` and `b9d8a730`.
- Code-review follow-up fixed replay source selection for confirmed `client-user-*` messages with a persisted `sourceEntryId`, switched `hanaFetch` HTTP error detail parsing to read body text once, and added sidecar traversal regression coverage.
- Upstream issue tracker now includes local drafts for marker-only image replay regenerate 400 and ToolGroup file-detail link context; GitHub issue search on 2026-06-30 found no exact upstream matches.
- sg01 deployment for this patch line uses the attended install-server flow: release asset check, `install-server upgrade --version v0.346.18-karlorz.5 --channel prerelease --dry-run`, then `--execute`.
- 2026-07-01: patch target `v0.346.18-karlorz.6` remains on upstream package version `0.346.18` and carries the provider model-removal persistence fix.
- Model removal now uses the dedicated provider-model DELETE route from Settings, decodes slash-bearing route model ids before registry mutation, and treats explicit local provider `models` saves as replacement lists so deleted plugin models do not merge back in.
- Upstream issue tracker now includes a local draft for provider model removal persistence; GitHub issue searches on 2026-07-01 found no exact upstream matches.
- sg01 live validation created a temp remote provider/model with a slash-bearing id, deleted it through the encoded provider model DELETE route, confirmed it stayed absent, and cleaned up the temp provider. Memory pressure during the attended hotfix was traced to stale tmpfs `/tmp/openhanako-*` and `/tmp/hanaagent-*` staging directories; future host-side hotfix builds should stage under `/opt/hanaagent/build`.

## Sync log

| Date | Upstream tag | Conflicts | Resolution | Tests | Live smoke | Notes |
|------|--------------|-----------|------------|-------|------------|-------|
| 2026-06-15 | `v0.323.0` (baseline) | — | — | — | — | Fork established from upstream `v0.323.0`. `dev` at `434c3e30`. No later upstream sync performed yet. |
| 2026-06-22 | `v0.333.6` | LAN/remote preview behavior, package metadata, SDK tarball vs office-workflow tests, `custom_remote` wsTicket coverage vs LAN query-token WebSocket behavior, and duplicated preview-refresh helper block. | Preserved fork LAN/remote attachment preview behavior, accepted upstream `0.333.6` package metadata, skipped obsolete `0.323.0-karlorz.*` release bump commits, kept both SDK tarball and office-workflow coverage, retained upstream `custom_remote` wsTicket tests while preserving LAN query-token WS behavior, and removed the duplicate preview-refresh helper block. | Post-rebase Tier 1/Tier 2 passed via `node scripts/sync-upstream.mjs --post-rebase`; final focused helper/sync vitest passed with 28 tests; `npm run typecheck`, `git diff --check`, and conflict-plan local-only passed. | Tier 3A installed/codesigned local HanaAgent `0.333.6`; Tier 3B helper restart/verify returned identity 200 and WS open; image paste/upload, send, switch/return, returned thumbnail, and new plus historical Conversation Files previews rendered with no observed CSP/WS/fetch errors. | PR #1 remains the permanent draft dashboard; it was not merged, auto-merged, or closed. |
| 2026-06-24 | `v0.341.19` | No rebase conflicts; package metadata accepted as `0.341.19`, with `package-lock.json` root-version alignment only. | Preserved upstream preview-refresh/resource-change handlers and fork optimistic attachment hydration; refreshed office-workflow ResourceIO/sessionPermission docs/tests and added the matching upstream issue tracker row. | `node scripts/sync-upstream.mjs` passed Tier 0/1/2; post-rebase focused sync/helper/install tests passed with 95 tests; focused office-workflow/plugin-sdk/tracker tests passed with 34 tests; `npm run typecheck`, `git diff --check`, and `node scripts/track-upstream-issues.mjs status` passed. | Tier 3A installed/codesigned local HanaAgent `0.341.19`; Tier 3B helper verified identity 200 and WS open; CDP UI smoke uploaded/sent an image, switched away/back, and confirmed chat thumbnail plus Conversation Files preview persistence. | PR #1 remains the permanent draft dashboard and was untouched. Non-blocking session-permission/resource-events console warnings were observed, with no CSP or WebSocket failure. |
| 2026-06-25 | `v0.345.3` | No manual rebase conflicts; precheck flagged likely overlap in `preview-document-refresh.ts`, package metadata, lockfile root metadata, and plugin SDK example tests. | Accepted upstream `0.345.3` package metadata and clean upstream changes while preserving the fork Tier 0 file-presence gate, LAN auth, scoped runtime CSP, remote resource preview, and office-workflow/plugin SDK coverage. | `node scripts/sync-upstream.mjs` and `--post-rebase` passed Tier 0/1/2; `tests/sync-upstream.test.mjs` passed 18 tests; conflict-plan local-only passed; `npm run typecheck` and `git diff --check` passed. | Tier 3A installed/codesigned local HanaAgent `0.345.3`; Tier 3B helper verified identity 200 and WS open; CDP UI smoke pasted/uploaded/sent `Pasted image.png`, switched away/back, and confirmed chat image plus Conversation Files preview rendered from remote resource URLs with no observed CSP or WebSocket failure. | PR #1 remains the permanent draft dashboard and was untouched. |
| 2026-06-27 | `v0.346.18` | No textual rebase conflicts; semantic review caught upstream's `resource-url.ts` owner-only local transport check. | Accepted upstream resource-access extraction, preview-document-refresh expansion, resource-io base64 support, GPU markers, and package metadata; restored fork `connection.kind === 'local'` transport invariant for LAN device-credential resource URLs and preserved synthetic `sf_*` resource fallback. | `node scripts/sync-upstream.mjs` and `--post-rebase` passed Tier 0/1/2; `tests/sync-upstream.test.mjs` passed 19 tests; focused preview/resource tests passed 45 tests; `npm run typecheck` and `git diff --check` passed. | Tier 3A installed/codesigned local HanaAgent `0.346.18`; Tier 3B helper verified identity 200 and WS open; CDP UI smoke uploaded/sent `openhanako-sync-smoke-v0.346.18.png`, switched away/back, confirmed transcript image and Conversation Files row, then opened the Conversation Files preview from remote `/api/resources/res_sf_.../content` with no CSP or WebSocket failure. | PR #1 remains the permanent draft dashboard and was untouched. Fork release tag: `v0.346.18-karlorz.1`. |
| 2026-07-02 | `v0.349.5` | Rebase conflicts in session metadata compaction tests/code and provider model deletion UI/store tests/code. | Preserved upstream aggregate compaction and provider metadata behavior while keeping fork forced legacy sidecar compaction, memory-reflection sidecar hydration, replacement-list model deletion, and encoded DELETE model removal. | `node scripts/sync-upstream.mjs --post-rebase` passed Tier 0/1/2; conflict-focused Vitest passed 167 tests; `npm run typecheck`, `git diff --check`, and conflict-plan local-only passed. | Tier 3A installed/codesigned local HanaAgent `0.349.5`; Tier 3B helper verified identity 200 and WS open; CDP UI smoke pasted/sent a generated image, switched away/back, confirmed transcript image plus Conversation Files row, then opened MediaViewer from remote `/api/resources/res_sf_.../content` with no CSP or WebSocket failure. | PR #1 remains the permanent draft dashboard and was untouched. Fork release tag: `v0.349.5-karlorz.1`. |
| 2026-07-04 | `v0.350.2` | No manual rebase conflicts; precheck flagged likely overlap in `desktop/main.cjs`, `InputArea` and `ws-message-handler` tests/code, plus package metadata files. | Accepted upstream `0.350.2` package metadata and clean upstream fixes while preserving the fork Tier 0 file-presence gate, LAN auth probe path, scoped runtime CSP, remote attachment preview, and Conversation Files MediaViewer behavior. | `node scripts/sync-upstream.mjs` and `--post-rebase` passed Tier 0/1/2; `tests/sync-upstream.test.mjs` passed 19 tests; `npm run typecheck`, `git diff --check`, and conflict-plan local-only passed. | Tier 3A installed/codesigned local HanaAgent `0.350.2`; Tier 3B helper verified identity 200 and WS open; CDP UI smoke uploaded/sent `openhanako-sync-smoke-v0.350.2.jpg`, switched to `Recent Changelogs Guide`, returned to `Image Preview Smoke Test`, confirmed the new smoke turn plus Conversation Files row, then opened MediaViewer from remote `/api/resources/res_sf_2a746d039596aeca/content?...` at `1024x1024` with no CSP or WebSocket failure. | PR #1 remains the permanent draft dashboard and was untouched. Fork release tag: `v0.350.2-karlorz.1`. |
| 2026-07-07 | `v0.357.17` | Conflict batch in `desktop/auto-updater.cjs`, auto-update locale keys, and `tests/auto-updater.test.ts` while replaying local build identity / disabled auto-update. | Preserved upstream AtomGit/GitHub fallback and release digest behavior, retained fork local-build `updateEnabled: false` guard, kept both digest and local-build locale keys, and kept upstream plus fork auto-updater tests. | `node scripts/sync-upstream.mjs --post-rebase` passed Tier 0/1/2; `tests/auto-updater.test.ts` passed 20 tests; `tests/sync-upstream.test.mjs` passed 19 tests; `npm run typecheck`, `git diff --check`, conflict-plan local-only, release digest validation, and `tests/release-mirror-workflow.test.ts` passed. | Tier 3A installed/codesigned local HanaAgent `0.357.17`; Tier 3B helper verified identity 200 and WS open; CDP UI smoke sent `Pasted image.png`, switched away/back, confirmed transcript attachment plus Conversation Files row, then opened MediaViewer from remote `/api/resources/res_sf_60152d5c1617a6bc/content?...` at `64x64` with no CSP or WebSocket failure. | PR #1 remains the permanent draft dashboard and was untouched. Fork release `v0.357.17-karlorz.1` published from `c9a88215`; workflow `28843292226` green; release has 21 assets including linux-arm64 server tarball and checksum. |
| 2026-07-18 | `v0.407.15` | Multiple textual and semantic batches across session stores/IDs, attachment hydration, updater/announcements, compaction, providers, `KeyInput`, installer/artifact-core activation, protocol diagnostics, signed build pipelines, tests, and the release digest. | Preserved compatible upstream and fork behavior; retained stable session IDs and signed artifact-core while keeping LAN/scoped-resource/preview/current-symlink safety. Skipped the obsolete `v0.357.17-karlorz.1` digest replay, adapted characterization to stable behavior, and fixed stable-tag selection when `train-12` shared the release commit. | `--post-rebase` passed Tier 0/1/2; broad conflict/migration/provider/resource/installer suites passed; sync/build-info/updater/server-upgrade/CSP tests passed; `npm run typecheck`, `git diff --check`, and local-only conflict planning passed. | Tier 3A installed/codesigned local HanaAgent `0.407.15` using a deleted one-time validation key for the required signed seed. Tier 3B verified identity 200 and WS open; upload/send/switch/return preserved the `Hanako.jpg` thumbnail and Conversation Files preview, and MediaViewer loaded it at `1024x1024` with no CSP or WS failure. | Backup branch `codex/backup-dev-before-v0.407.15-sync-20260718` preserves the pre-rebase head. No push, deployment, fork tag/release, digest fork alignment, or PR #1 mutation occurred. Old-server input-draft 404s and one stale 410 were non-blocking. SkillWiki changelog deferred because the shared vault is dirty. |
