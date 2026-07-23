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

## Optional prerelease sync channel

Stable-only remains the **default** production path. An **optional**, attended
prerelease channel exists so a human can rebase `dev` onto a published GitHub
**prerelease** release when they explicitly mean to — not when agents or the
dashboard want fewer PR #1 conflicts.

| Rule | Detail |
|------|--------|
| Default | `node scripts/sync-upstream.mjs` and `--check` use non-prerelease releases only. |
| Review only | `node scripts/sync-upstream.mjs --include-prerelease --check` lists the latest eligible prerelease; **no** accept flag and **no** tag confirmation required. |
| Eligible targets | GitHub Releases with `isPrerelease=true` and not draft (via `gh release list` when available). **Not** `upstream/main` HEAD. |
| Mutate `dev` | Requires **double consent**: `--include-prerelease` **and** `--i-accept-prerelease-sync` **and** `CONFIRM=<exact-resolved-tag>` (or `SYNC_UPSTREAM_CONFIRM_TAG=<tag>`). Bare `--include-prerelease` without accept/confirm **refuses** and does not rebase. |
| Example | `CONFIRM=train-beta-15 node scripts/sync-upstream.mjs --include-prerelease --i-accept-prerelease-sync` (only after `--check` showed that exact tag). |
| After success | Record the prerelease tag as last synced; align package version to that release. Fork publish tags still use `vX.Y.Z-karlorz.N`. |
| Dashboard | Pick-from-main / PR #1 stay unchanged: no force-adopt for cosmetics. Prerelease content lands only via this attended rebase. |
| Feature freeze | Orthogonal. Prerelease channel does not redefine remote-feature freeze; freeze/unfreeze is a separate product decision keyed off stable policy when stated. |

Machine-readable fields: `docs/fork-sync/rules.yml` → `releaseTarget.prereleaseSync`.

## Release profile policy

- **Tag fallback is automatic:** an ordinary `v*` tag push requests `auto`, which resolves to `signed` only with validated Ed25519 material and otherwise selects the marked `legacy-raw` fallback when both signing inputs are blank. Malformed, unreadable, or incompatible nonblank material is an error.
- **The signing domains are independent:** `HANA_SIGN_KEY` (key-file path) and `HANA_SIGN_KEY_PEM` (inline PEM) are the two resolver inputs for Hana Ed25519 seed/train metadata and therefore `signed` versus `legacy-raw`; `CSC_LINK` and `CSC_KEY_PASSWORD` control Apple Developer ID signing. Neither domain can substitute for the other, and release-digest BYOK credentials are unrelated to both.
- **No-certificate macOS fallback:** when either `CSC_LINK` or `CSC_KEY_PASSWORD` is blank, Electron Builder uses ad-hoc identity `-`, hardened runtime is disabled, `SKIP_NOTARIZE=true`, and the complete `HanaAgent.app` bundle must pass `codesign --verify --deep --strict --verbose=2` before either signed-profile or legacy-raw artifacts can be uploaded. The complete app bundle is ad-hoc signed and resource-sealed; the DMG and ZIP containers themselves are unsigned and unnotarized.
- **Why the `.357` path installed:** `v0.357.17-karlorz.1` predated the required Hana signed seed/train path. Its local `npm run install:local` copied the app, recursively ad-hoc signed nested code through `scripts/sign-local.cjs`, and ran strict verification; its standalone server archive used a SHA-256 sidecar rather than either macOS or Ed25519 signing. The explicit legacy-raw profile preserves that installability while making its exclusions and evidence visible.
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
| `desktop/main.cjs` | `ae7fd31c` | **MEDIUM** — IPC handlers added occasionally | **Usually auto-mergeable.** Probe logic lives in `desktop/src/shared/connect-probe.cjs`; main only requires that module and registers `wrapIpcHandler("connect:probe", createConnectProbeHandler({ fetchImpl: net.fetch.bind(net) }))`. Verify the `net` import and one-line registration survive upstream rewrites. |
| `desktop/preload.cjs` | `ae7fd31c` | **MEDIUM** — new channels exposed occasionally | **Usually auto-mergeable.** Our change adds one line (`probeConnection`) inside the existing `contextBridge.exposeInMainWorld` block. |
| `tests/server-auth.test.ts` | `80ea81ae` | Medium | **Prefer ours**, but if upstream restructures the test file heavily, review. |
| `tests/server-connection.test.ts` | stable `v0.333.6` inherited test + fork B1 behavior | Medium | **Preserve both.** LAN device-credential WebSockets must keep token query fallback; non-LAN `custom_remote` device connections should keep upstream `wsTicket` behavior. |
| `desktop/src/react/__tests__/services/server-connection.test.ts` | `80ea81ae` + `ae7fd31c` | Low | **Prefer ours** (they test our fixes). |

### Remote upload/resource preview fixes

These files fix remote desktop attachment import and preview when the macOS desktop is connected to `http://100.125.173.118:14500`. Upstream may touch these areas independently; preserve the tests and the end-to-end invariant, not just exact code.

| File | Risk if upstream touches | Resolution policy |
|------|--------------------------|-------------------|
| `desktop/src/modules/connection-csp.js` | **HIGH** — renderer CSP controls whether persisted remote resources can render | **HUMAN REVIEW.** Active remote HTTP(S) origin must be present in `img-src` and `media-src`, while WS origins stay in `connect-src` only. Do not widen to bare `http:`/`https:`. |
| `desktop/src/react/services/resource-url.ts` | **CRITICAL** — resource URL resolution for remote session files and LAN device-credential connections | **HUMAN REVIEW.** Native `file://` only for true local-owner connections (`isLocalOwnerConnection` / loopback + `loopback_token` via `canUseNativeResourcePath`). LAN and custom_remote device credentials must use HTTP resource content URLs (token query allowed) and must synthesize `/api/resources/res_<sf_*>/content` when older session rows only carry `fileId`. Do not reintroduce a `kind === 'local'`-only transport predicate that would treat non-loopback `kind: 'local'` device credentials as native file owners. |
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
   - `desktop/main.cjs`: registers `connect:probe` via `createConnectProbeHandler` from `desktop/src/shared/connect-probe.cjs` (SSRF/sender/redirect policy lives in that module)
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



## Pick-from-main decisions (dashboard conflict reduction)

Machine-readable source: `docs/fork-sync/pick-from-main-decisions.yml` (loaded by
`scripts/sync-upstream.mjs` into every conflict plan as `pickFromMain` / per-file
`pickFromMain.decision`). Human table: `docs/fork-sync/pick-from-main-decisions.md`.

**Enforced:** force-adopt of `wait-stable` / `preserve-fork` paths from mirrored
main is forbidden for dashboard cosmetics (`assertNoForceAdoptFromMain`).
**Adopt-now set is empty** while stable remains `v0.407.15` and main tip is
unreleased `0.415.15` train content.

**Reclaim guards** (`checkForkReclaimGuards`): prevent duplicate re-application
of already-landed fork fixes — ticket-primary WS, isolated `connect-probe`,
resource-url owner-only native gate, packaged-artifact-boot planning. Focused
tests: `tests/pick-from-main-reclaim.test.mjs`.

PR #1 stays a permanent draft dashboard (never merge for a green scoreboard).

## Conflict-reduction implementation (2026-07-20)

Phases executed on `dev` without a stable rebase onto prerelease `main`:

1. **WebSocket ticket-primary (adapt):** `resolveConnectionWsAuth` now attempts
   `POST /api/ws-ticket` for non-loopback connections when assessment is absent
   or ticket-ready. Long-lived LAN query-token is only a gated fallback when the
   ticket surface fails or a complete assessment reports
   `websocket_ticket_contract_missing`. `websocket.ts` no longer short-circuits
   LAN first-connect to legacy query-token. Resource HTTP URLs may still use
   token query via `canUseQueryToken`.
2. **Packaged dual-profile boot planning (retain):** pure plan/result builders
   live in `desktop/src/shared/packaged-artifact-boot.cjs`; main applies state and
   still owns prepareArtifactBoot / splash / GC orchestration.
3. **CSP probe isolation (retain):** probe logic lives in
   `desktop/src/shared/connect-probe.cjs`; `desktop/main.cjs` only registers
   `wrapIpcHandler("connect:probe", createConnectProbeHandler(...))`. Preload
   still exposes `probeConnection`. SSRF/sender/`redirect: "manual"` policy is
   unit-tested via `tests/connect-probe.test.mjs`.
4. **Remote resource ownership (retain):** documented LAN transport invariant in
   `resource-url.ts`; LAN device-credential + synthetic `sf_*` resource content
   paths covered by focused resource-url tests.
5. **Packaging isolation:** no package/lockfile pre-bump. Dual-profile release
   and install-server remain fork-only. New fork-only entries:
   `desktop/src/shared/connect-probe.cjs`, `tests/connect-probe.test.mjs`,
   `desktop/src/shared/packaged-artifact-boot.cjs`, `tests/packaged-artifact-boot.test.mjs`.

Machine-readable dispositions: `docs/fork-sync/migration-contracts.yml`
(`implementationStatus` fields for websocket-ticket-auth, connection-csp-bootstrap,
remote-resource-ownership).

## Attended prerelease sync closeout (2026-07-23, `train-beta-15` / `v0.416.43`)

- The attended prerelease target resolved to GitHub prerelease **`train-beta-15`**, paired with release **`v0.416.43`**, both at upstream SHA `a02622da02cd2edc8397066c6cb6bc256f306b97`. The `dev` rebase replayed 216 fork commits. Backup ref `backup/dev-before-prerelease-v0.416.43-20260723` points to `61b3c8549d3e9332852eaa77e5ab01a0346b3d3c`.
- The obsolete `chore(release): prepare v0.416.26-karlorz.1` and `docs(release): close out v0.416.26-karlorz.2` commits were dropped. The CI profile-scoping fix was preserved and replayed as `3420026aefab1db7a45b95d0abb8747804b9758d`.
- Package metadata, `package-lock.json`, `release-digest.v1.json`, and `release-digest.v2.json` are aligned to `0.416.43` / `v0.416.43`. No fork-scoped tag or GitHub release was published.
- Packaging review restored the standalone Windows sequence (`build:server`, `verify:seed-kit`, `pack:server:standalone`, `verify:standalone:server`, then `electron-builder`) and kept CI contract tests compatible with the current profile-aware upload labels. The signed runtime resolver now requires the exact platform-qualified `seed/seed-train-{platform}-{arch}.json` and matching `.sig`; wrong-platform and missing-signature cases are covered.
- Tier 0 passed with all 79 fork-only patterns present. Tier 1 focused upstream/session/permission and packaging/release suites passed (8 files, 112 tests); the helper/runtime-policy/packaged-boot rerun passed 3 files, 50 tests. Tier 2 passed main/preload builds, connect/probe checks, and scoped remote CSP checks. `npm run typecheck` passed.
- Tier 3A rebuilt and installed `/Applications/HanaAgent.app` as local signed `0.416.43` using temporary Ed25519 validation material that was deleted afterward. Strict deep codesign passed. Bundle metadata reports channel `local`, updates disabled, source repo `karlorz/openhanako`, release profile `signed`, signature kind `adhoc`, and the expected `3420026a...` git SHA. Installed seed resources are platform-qualified for `darwin-arm64`.
- Tier 3B helper verification against `http://100.125.173.118:14500` returned identity HTTP 200 and an open WebSocket with `connectionKind: lan`; the independent environment assessment is `attention` because sg01 still reports server `0.412.7`, release `v0.412.7-karlorz.2`. Manual CDP smoke recovered the remote connection, uploaded `yuan-hanako-emblem.png`, sent it, and confirmed the file remained Available in Conversation Files with an enabled Preview action. Switching chats and returning preserved the existing persisted image attachment thumbnail and Conversation Files preview. The newly captioned smoke message was observed optimistically but was not claimed as persisted after reload.
- sg01 was not deployed or modified. PR #1 remains the permanent draft dashboard and was not merged, auto-merged, closed, or used as a release vehicle. No unexpected rebase/conflict state remains.

## Next stable pre-sync outlook (2026-07-23 post `train-beta-15` prerelease channel)

Attended **optional prerelease-channel** mutates completed: `dev` rebased onto
upstream GitHub prerelease tag **`train-beta-15`** with double consent
(`--include-prerelease --i-accept-prerelease-sync` + `CONFIRM=train-beta-15`).
Package metadata now follows the train tip (`0.416.43`). Stable default channel
is unchanged: bare `--check` still reports the latest **non-prerelease** release
(`v0.407.15`) separately from last-synced when the log records a train tag.

| Signal | Observed value |
|--------|----------------|
| Working branch / HEAD | `dev` (post-rebase; see sync log) |
| Package / lockfile version | `0.416.43` (aligned with train-beta-15 tip metadata) |
| Latest stable upstream | `v0.407.15` |
| Last synced tag (sync log) | `train-beta-15` (prerelease channel) |
| Prior stable last-synced | `v0.407.15` |
| Stable production sync available | **no** newer non-prerelease than `v0.407.15` |
| Prerelease channel | **used** for `train-beta-15` (not review-only anymore for this base) |
| Main tip (mirror) | may still lead train; not a production target without a tag/release |
| PR #1 | OPEN, draft, never-merge dashboard; still CONFLICTING by design |
| Backup | `backup/dev-before-prerelease-v0.416.43-20260723` @ `61b3c854` |
| Upstream issue search | #1749 OPEN, #1811 CLOSED; tracker remains status/search/draft only |

Planned conflict paths from `--conflict-plan --json --local-only`:

| Path | Strategy | Risk |
|------|----------|------|
| `.github/workflows/build.yml` | preserve-both | high |
| `build/cli-runtime-closure.json` | take-main | low |
| `build/installer.nsh` | take-main | low |
| `build/persistence-schema-fingerprint.json` | take-main | low |
| `build/persistence-store-inventory.json` | take-main | low |
| `core/engine.ts` | preserve-both | high |
| `core/session-turn-actions.ts` | take-main | low |
| `desktop/main.cjs` | human-review | high |
| `desktop/src/shared/launch-integrity.cjs` | take-main | low |
| `package.json` | defer-to-stable-production-sync | medium |
| `release-digest.v1.json` | take-main | medium |
| `release-digest.v2.json` | take-main | low |
| `scripts/build-server.mjs` | preserve-both | high |
| `scripts/fix-modules.cjs` | take-main | low |
| `server/index.ts` | preserve-both | high |
| `tests/build-server-artifact.test.ts` | take-main | low |

Historical dashboard note (pre-mutate): main tip advanced beyond the prior train
while stable stayed `v0.407.15`. That review-only ceiling is **superseded** for
`dev` by the attended `train-beta-15` rebase above.

Default channel remains stable-only. Further prerelease mutates still require
double consent. Wait for a non-prerelease GitHub release newer than `v0.407.15`
before claiming a **stable** production sync.

## Stable sync activation and closeout boundary

- 2026-07-18: upstream stable `v0.407.15` was activated as the attended sync target and `dev` was rebased onto upstream commit `ab8d508e3ca4`. Package and lockfile metadata now report `0.407.15`; the upstream release digest remains `v0.407.15` / `0.407.15`.
- The pre-rebase state is preserved by `codex/backup-dev-before-v0.407.15-sync-20260718` at `28125675b667a`. The completed local sync head before this documentation closeout is `b51f150a2c1a`.
- The rebase required multiple conflict batches and semantic adaptations across session-scoped stores, attachment hydration, updater/announcement identity, compaction, provider credentials, `KeyInput`, installer activation, server protocol diagnostics, resource transport, and the signed train/renderer pipeline. Resolutions preserved compatible upstream and fork behavior rather than choosing one side wholesale.
- The obsolete fork replay that would have restored the old `v0.357.17-karlorz.1` release digest was skipped. Do not align `release-digest.v1.json` to a new fork tag until a separately attended fork-release publication phase.
- Upstream's artifact-core activation is now present. The fork retains its current-symlink server activation, checksum blocking, and rollback behavior; installer characterization was updated to assert that combined contract.
- Local build metadata initially selected the co-located `train-12` tag instead of stable `v0.407.15`. Commit `b51f150a` restricts build-info tag discovery to stable `v[0-9]*` tags and adds regression coverage.
- Tier 0-3 verification is complete, including post-rebase fork-presence/focused/bundle gates, broad migration and conflict suites, typecheck, local-only conflict planning, an installed/codesigned `0.407.15` desktop app, helper identity/WebSocket verification, and live remote image upload plus chat-switch/Conversation Files preview persistence.
- The live smoke observed non-blocking `/api/input-drafts` 404 responses because sg01 still runs an older server, plus one unrelated stale historical resource returning 410. The newly uploaded resource loaded successfully, with no CSP refusal or WebSocket disconnect.
- At this stable-sync-only boundary, no sg01 deployment, push, fork tag, fork release, PR #1 merge/close/auto-merge, or release-digest fork alignment had occurred. The later attended `.6` release/deployment closeout is recorded below. The detailed SkillWiki changelog note remains deferred because the shared vault contains unrelated dirty and review-required work; do not absorb or auto-stage it.

## Stable sync-only closeout (historical)

- 2026-07-18: `dev` was rebased from the prior stable baseline `v0.357.17` onto upstream stable `v0.407.15` (`ab8d508e3ca4`). Package metadata and the retained upstream digest report `0.407.15`; `dev` reached `b51f150a2c1a` after characterization and local-build tag-selection follow-ups.
- Conflict resolution preserved upstream session-ID ownership, train announcements, signed artifact-core/renderer behavior, provider widgets, compaction, and protocol diagnostics while retaining fork LAN auth/probing, scoped remote-resource CSP, optimistic attachment bytes, resource previews, disabled updater identity, current-symlink installer safety, and remote-boundary assertions.
- The old fork release-digest replay was intentionally skipped. The stable digest remains upstream-owned; no `v0.407.15-karlorz.N` tag or release has been created.
- `node scripts/sync-upstream.mjs --post-rebase` passed Tier 0 fork-only file presence, Tier 1 focused LAN/auth/CSP/remote-preview tests, Tier 2 main/preload builds and marker greps, and scoped remote resource-origin checks.
- Additional fresh and accumulated gates passed: broad conflict/migration/provider/resource suites, installer migration safety, WebSocket/cache characterization, `tests/sync-upstream.test.mjs`, `tests/local-build-info.test.mjs`, `tests/auto-updater.test.ts`, `tests/install-server-upgrade.test.mjs`, `tests/csp-sync.test.ts`, `npm run typecheck`, `git diff --check`, and local-only conflict planning.
- Tier 3A rebuilt `/Applications/HanaAgent.app` as local `0.407.15`. The upstream signed seed requirement was validated with a one-time temporary Ed25519 key/keyset that was deleted immediately afterward; no production signing material was used. Codesign passed, and installed build info reports local channel, upstream base tag `v0.407.15`, updates disabled, and ad-hoc app signing.
- Tier 3B helper verification returned identity HTTP 200, valid token-auth identity, and WebSocket open. The UI smoke uploaded `Hanako.jpg`, sent it, switched chats and returned, confirmed its transcript thumbnail and Conversation Files entry, and opened a complete `1024x1024` MediaViewer image. No CSP refusal or WebSocket disconnect occurred; old-server input-draft 404s and one stale historical-resource 410 were non-blocking.
- PR #1 remained the permanent draft dashboard and was not merged, auto-merged, closed, or remotely refreshed during this sync-only closeout. At that point no push, sg01 deployment, fork tag, or fork release had occurred. The later attended `.6` actions below supersede only that no-action snapshot; the SkillWiki changelog note remains deferred pending safe isolation of the dirty shared vault.

## Latest fork-release and deployment closeout

- 2026-07-20: fork prerelease `v0.407.15-karlorz.7` was published from exact commit `73d46c38fe483de3d277eed133780038bf54c04c` on `origin/dev`. GitHub Actions run `29695065868` completed successfully. The release remains a prerelease, targets `dev`, and contains the expected 20-asset legacy-raw surface: seven desktop installers, five standalone server bundles, five SHA-256 sidecars, one compatibility manifest, one immutable profile marker, and `release-digest.v1.json`.
- Signed-only assets are intentionally absent: no `latest*.yml`, blockmaps, renderer/server hot-update archives, seed/train assets, AtomGit mirror output, or `release-digest.v2.json` release asset. The committed v1/v2 digests both validate for tag `.7`, but the binding legacy-raw upload policy publishes v1 only.
- The release profile is `legacy-raw`. With Apple Developer ID credentials absent, both macOS architectures were built with ad-hoc identity `-`, hardened runtime disabled, and notarization skipped. CI strictly verified each complete `HanaAgent.app` before upload; each app bundle is ad-hoc signed and resource-sealed, while the DMG and ZIP containers are unsigned and unnotarized.
- This tag includes the conditional install-server bootstrap: download `install-server.mjs` first, detect `../shared/(remote-server-|remote-feature-contracts)` imports, and only then stage the six same-ref shared modules before replacing the CLI. Historical single-file tags such as `v0.357.17-karlorz.1` remain bootstrappable.
- The arm64 DMG checksum matched GitHub (`a52dd4a1a744e5faf84cd302034e1dba631991e698e617bf804e9eb9d764cf27`). `/Applications/HanaAgent.app` now reports app version `0.407.15`, release tag `v0.407.15-karlorz.7`, git SHA `73d46c38...`, profile/signature kind `legacy-raw`, and updater/artifact updates disabled; `codesign --verify --deep --strict --verbose=2` passed.
- sg01 first refreshed the durable CLI from tag-pinned `install-server-bootstrap.sh --install-cli-only` (installed installer + status dependencies). Online status then recommended `.7` while still on `.6`. Upgrade used `install-server upgrade --version v0.407.15-karlorz.7 --channel prerelease` dry-run then execute; result was `ok: true`, `rolledBack: false`. Current symlink is `/opt/hanaagent/releases/v0.407.15-karlorz.7-linux-arm64` with server archive checksum `595a9d2c1df6be2c43bd56b541d22d80f956d6a2474f599de74a75c588272f6c`.
- Fresh post-deploy evidence shows `hanaagent` active and enabled, `/mobile/`, `/mobile/locales/zh.json`, and `/mobile/locales/en.json` HTTP 200, identity HTTP 200 (token-auth via desktop smoke helper), WebSocket open, exact release match, eligible deployability, valid compatibility manifest, no release-policy drift, and declared `chat.core@1`, `input.drafts@1`, and `websocket.ticket@1` contracts. Online status check reports `.7` as current.
- Live desktop smoke attached the 64×64 `smoke-image.png`, opened Conversation Files (row `smoke-image.png`), switched to `Image Preview Smoke Test`, returned to the new chat, and recorded zero CSP refusals and zero WebSocket disconnects in the CDP console sample.
- Upstream issue search was refreshed on 2026-07-20: #1749 remains open, #1811 remains closed, #1493 remains open, #1546 remains closed, and no exact matches were found for the pending local drafts. The tracker remains status/search/draft only; no issue was submitted.
- PR #1 remains open and draft and was not merged, closed, auto-merged, or used as a release vehicle. Immutable tags `.6` and `.7` were not moved. Ignored UAT media and unrelated dirty SkillWiki work were not absorbed.

### Prior closeout snapshot (`v0.407.15-karlorz.6`)

- 2026-07-19: fork prerelease `v0.407.15-karlorz.6` was published from `7365233a0d0a36c467e3a97d9243f4620e80562a` (workflow `29688911528`), 20-asset legacy-raw surface, sg01 upgraded from older line to `.6`, then post-release bootstrap repair staged for dependency-complete CLI while leaving the immutable `.6` tag unmoved.

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
4. Publish the fork-scoped tag `v0.407.15-karlorz.N` and verify the selected
   profile's exact asset surface. A legacy-raw release requires its profile
   marker, seven marked desktop installers, five standalone server bundles and
   sidecars, compatibility manifest, and `release-digest.v1.json`; it must not
   be rejected for omitting `release-digest.v2.json` or signed-only updater,
   train, renderer, blockmap, or mirror assets.
5. On sg01, first use the selected tag or commit's bootstrap to refresh the
   durable CLI and its same-ref status dependencies. Then run `install-server
   status --check-updates --json`, a pinned stable upgrade dry-run, backup, and
   only then the attended execute step. Verify the current symlink, service
   health, build identity, compatibility contracts, `/mobile/`, and localized
   mobile strings.
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
| 2026-07-19 | `v0.407.15` | Post-sync remote assessment, release-profile, digest, installer, bootstrap dependency, and macOS no-certificate fallback closeout. | Published immutable fork prerelease `v0.407.15-karlorz.6` from `7365233a`; selected legacy-raw when Hana signing material was absent; used complete ad-hoc macOS app-bundle signing plus strict pre-upload verification when Apple credentials were absent; preserved runtime-only server/checksum deployment; fixed the post-release bootstrap to install the durable CLI's same-ref dependency closure before the implementation. | Run `29688911528` succeeded; the reviewed release/code gates passed 22 Vitest files and 296 tests, typecheck, main build, both digest validators, YAML parsing, and diff checks. Bootstrap/sync regressions additionally passed 108 focused tests. | Installed the verified arm64 DMG; upgraded sg01 with the supported installer; refreshed the durable CLI, then confirmed exact/current update detection, build identity, HTTP 200, WS open, active/enabled service, localized mobile assets, and image send/switch/return plus complete `834x775` Conversation Files preview with zero console errors/warnings. | Release has the audited 20-asset legacy-raw surface. Issue search reconfirmed #1749 open and #1811 closed with no exact draft matches. PR #1 and the immutable `.6` tag remained untouched after publication; the bootstrap fix lands on `dev` for the next tag. Unrelated SkillWiki work and ignored UAT media were preserved. |
| 2026-07-20 | `v0.407.15` | Conditional bootstrap dependency fetch, fork-sync policy/docs closeout, and attended `.7` release/redeploy. | Published immutable fork prerelease `v0.407.15-karlorz.7` from `73d46c38`; bootstrap detects installer shared imports so legacy single-file tags remain installable while current refs stage the six-module status dependency closure first; recorded Apple no-certificate macOS fallback and CSC blank-gate in fork-sync rules. | Run `29695065868` succeeded with 20 legacy-raw assets; focused Vitest 134 tests, typecheck, YAML parse, bootstrap `sh -n`, and digest validators passed; PR #1 left open/draft. | Tag-pinned bootstrap CLI refresh; sg01 upgrade `ok: true`/`rolledBack: false` to `.7-linux-arm64`; service active/enabled; mobile/locales 200; smoke helper identity 200 + WS open; arm64 DMG install + strict codesign; image attach + Conversation Files `smoke-image.png` + chat switch/return with zero CSP/WS errors. | Issue search reconfirmed #1749 open, #1811 closed, no exact draft matches. Immutable `.6`/`.7` tags not moved. SkillWiki dirty work not absorbed. |
| 2026-07-21 | `train-13` | 218-commit rebase onto GitHub prerelease train tip; early conflicts on `package.json` (preserve verify:seed-kit + write-local-build-info), `core/engine.ts`/`server/index.ts` (feature contracts + media adapters), LAN/CSP/preview/packaging batches; some historical fork commits skipped as empty/redundant. | Double-consent mutate (`--include-prerelease --i-accept-prerelease-sync` + `CONFIRM=train-13`). Prefer ownership-aware HEAD for resource-url; restore InputArea/CSP/MainContent.drag test suites after heuristic conflict damage. Package aligned to train tip `0.412.7`. | `node scripts/sync-upstream.mjs --post-rebase` Tier 0/1/2 green after test restores; `tests/sync-upstream.test.mjs` + typecheck + diff-check. | Tier 3A/3B **not** run in this session (manual). No host deploy/tag/fork release. | Backup `backup/dev-before-prerelease-train-13-20260721` @ `611fd08d`. PR #1 untouched as permanent draft. Stable channel default unchanged; lastSynced records `train-13`. |
| 2026-07-21 | `v0.412.7-karlorz.1` | Fork prerelease publish from train-13 base; restored dual-profile legacy-raw CI path. | Tag `v0.412.7-karlorz.1` on package `0.412.7`; Build run success; 20 legacy-raw assets. | Pre-tag vitest/typecheck/digest validate green; CI Build success after dual-profile restore. | Local macOS installed from published arm64 DMG; codesign valid; build-info releaseTag `v0.412.7-karlorz.1`. sg01 `install-server upgrade --version v0.412.7-karlorz.1 --channel prerelease` ok/not rolled back; current `...-linux-arm64`; service active/enabled. | PR #1 remains permanent draft. |
| 2026-07-22 | `v0.412.7-karlorz.2` | Post-`.1` remote assessment, install-server probes, session/auth, dual-profile CI, digest align; first tag push failed digest validation (stale `.1` tag in digests). | Aligned digests + retag; Build run `29890312115` success; 20 legacy-raw assets; package remains `0.412.7`. | typecheck + install/sync focused vitest green; digest validators for `.2`. UAT found `status --json` rejected by parseArgs — fixed on `dev` (`a6349bd7`) and host CLI re-bootstrapped. | Local arm64 DMG install + strict codesign; build-info `releaseTag`/`gitSha` match `.2`/`c7120c11`. sg01 bootstrap CLI + upgrade `ok: true`/`rolledBack: false` to `.2-linux-arm64`; service active/enabled; mobile/locales 200; smoke helper functional+environment pass, freshness current exact match. | PR #1 remains permanent draft never-merge. Server runtime stays on immutable tag `.2`; CLI-only hotfixes may track `dev` commits. |
| 2026-07-23 | `train-beta-15` / `v0.416.43` | Upstream prerelease rebase replayed 216 fork commits; obsolete `v0.416.26` preparation/closeout commits dropped; packaging/profile-aware CI and platform-qualified seed runtime contract required review. | Rebased `dev` onto upstream `a02622da02cd2edc8397066c6cb6bc256f306b97`; preserved CI profile-scoping fix as `3420026a`; restored standalone Windows packaging sequence; resolver now selects `seed-train-{platform}-{arch}.json` plus `.sig`; package/lock/digest v1/v2 aligned to `0.416.43` / `v0.416.43`. | Tier 0/1/2 passed via `node scripts/sync-upstream.mjs --post-rebase`; focused reruns passed 8 files/112 tests and helper/runtime-policy/packaged-boot 3 files/50 tests; `npm run typecheck`, sync vitest, conflict-plan local-only, and `git diff --check` passed. | Tier 3A local signed `0.416.43` install and strict codesign passed. Tier 3B helper returned identity 200 + WS open (`lan`); CDP smoke uploaded/sent an image, preserved an existing chat thumbnail and Conversation Files preview after switch/return, and kept the new uploaded file Available with Preview. New captioned message persistence was not claimed after reload; sg01 remains on `v0.412.7-karlorz.2` and was not deployed. | Backup `backup/dev-before-prerelease-v0.416.43-20260723` @ `61b3c8549d3e9332852eaa77e5ab01a0346b3d3c`. No fork tag/release. PR #1 remains permanent draft never-merge. |
