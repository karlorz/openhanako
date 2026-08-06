# Read-only review: PR #4 — native multi-marketplace + Claude skills lane

**Verdict:** **Request changes; not merge-ready.**

This is a read-only review of [karlorz/openhanako PR #4](https://github.com/karlorz/openhanako/pull/4). No GitHub review, comment, merge, push, deployment, or `sg01` mutation was performed.

## Review freeze

| Field | Reviewed value |
|---|---|
| PR | `#4` — `fix: pure-auto cold install for marketplace skill packages` |
| State | OPEN, non-draft |
| Base | `dev` — `992e640e550741b9d46534b105f6a445ab6d8a7b` |
| Head | `feat/native-multi-marketplace-claude-skills` — `6d424bff7aa2ed2d2420449c59f09e29523b085f` |
| Fork | `karlorz/openhanako` |
| Upstream comparison ref | `liliMozi/openhanako/main` — `507520f37ebf6bbce824c9750ff68d61da5916c3` |
| PR range | 137 files, 32,681 additions, 726 deletions |
| Review mode | Detached, exact PR-head worktree; source and external state left unchanged |

`dev` is the fork PR target and remains the only valid base for this review. `upstream/main` is a compatibility reference, not the fork release target. The much larger `upstream/main..head` inventory is dominated by permanent fork divergence and must not be mistaken for PR #4's review range.

## Executive assessment

The PR adds a substantial multi-source marketplace control plane, source-qualified identity, retained native artifacts, a signed native Settings lifecycle, Claude-package-to-Hana-skill installation, Manage Plugins inventory, package gates, and extensive regression coverage. Most of the intended boundaries are present and the focused automated suite is green.

The PR nevertheless has multiple merge-blocking authority and state-integrity defects:

1. The Agent marketplace tool claims `ownerRequired` but hardcodes `isStudioOwner: true`; the host never enforces the owner flag. In Auto mode, the deterministic approval path can therefore execute owner-only skill-package mutations for a non-owner agent.
2. The network policy accepts hex-form IPv4-mapped IPv6 literals such as `::ffff:0a00:0001`, defeating the private-address filter. It also validates DNS addresses and then discards the validated addresses before `fetch`, leaving a DNS-rebinding window.
3. Native source switching is classified as ordinary `settings.write`, has no owner/typed-plan gate, always reports a healthy candidate, swallows PluginManager load failures, drops the marketplace active marker, and has boot-time journal recovery that is never called.

These are not claims that the PR fixes any unrelated fork or upstream issue. The native-plugin/Hana-skill boundary is correct in the ordinary install paths, but the source-switch and Agent-tool paths need to be brought back under the same authority and provenance contracts before approval.

## Severity-ranked findings

### 1. High — Agent marketplace tool bypasses the owner-only mutation contract

**Introduced:** PR #4.
**Evidence:**

- `lib/tools/plugin-marketplace-tool.ts:306-307,328-329,349-350,375-376,396-397,414-415,435-436` emits `sideEffect.ownerRequired: true`.
- The same tool passes `isStudioOwner: true` unconditionally at `lib/tools/plugin-marketplace-tool.ts:559-560,577-580,585-593,606-609,689-691,750-755,780-781,826-829`.
- The tool is registered for every Agent at `core/agent.ts:651-653` and included in the normal tool snapshot at `core/agent.ts:952`.
- `lib/approval-gateway.ts:65-71,96-118` never reads `ownerRequired`; its deterministic marketplace decision checks only the presence of a plan token or registry preconditions.

`ownerRequired` has no host-side consumers outside the tool/test metadata. The service owner checks are therefore defeated by the tool supplying the owner boolean itself. In Auto mode, a plan-validated install/package-toggle/uninstall can bypass the LLM reviewer. In Operate mode, the reviewable tool path is directly allowed by the session-permission mode. A non-owner Agent can consequently add/remove sources, toggle package gates, install or uninstall Hana skills, and—through the broader mutation surface—attempt full activation control-plane changes.

The registry revision/digest and plan equality checks are useful freshness checks, but they are not an owner attestation. This contradicts the handbook's owner-only contract and the HTTP routes' owner checks.

**Required disposition:** Inject a host-derived principal/owner decision into the tool or wrap owner-marked tool invocations with a host-side owner gate. Make the approval gateway require that host-owned decision rather than accepting tool-echoed `isStudioOwner`/precondition fields. Add a non-owner Auto and Operate regression test.

### 2. High — Hex-form IPv4-mapped IPv6 literals bypass the private-address filter

**Introduced:** PR #4; `lib/plugin-marketplace-network-policy.ts` is new.
**Evidence:**

- `lib/plugin-marketplace-network-policy.ts:95-107` handles an IPv4-mapped address only when the suffix is dotted decimal and `net.isIPv4(mapped)` succeeds.
- `lib/plugin-marketplace-network-policy.ts:129-137` does not normalize hexadecimal mapped-IPv4 forms.
- `lib/plugin-marketplace-network-policy.ts:140-170` accepts the result of `isDeniedIpAddress` and returns it as pinned.
- `server/routes/plugins.ts:1607-1618` fetches a catalog `readmeUrl` and returns the fetched body to a caller whose route is only `settings.read`.

A direct PR-head probe returns:

```text
::ffff:0a00:0001 false
::ffff:7f00:1 false
::ffff:a9fe:a9fe false
::ffff:10.0.0.1 true
```

`::ffff:0a00:0001` represents `10.0.0.1`; `::ffff:7f00:1` represents loopback. Node parses these as IPv6 literals, while the current filter neither recognizes the mapped IPv4 suffix nor rejects the resulting address.

A catalog from an owner-added third-party source can therefore supply a malicious `readmeUrl`; a remote settings reader can trigger the fetch and receive the internal response body. The same policy is also used for source/catalog and release acquisition. This defeats the PR's stated public-HTTPS/private-range boundary.

**Required disposition:** Normalize IPv6 addresses before classification and reject all IPv4-mapped forms, including compressed, expanded, and hexadecimal forms. Add tests for loopback, RFC1918, link-local, CGNAT, metadata, and NAT64/mapped variants. Consider returning remote README content only after applying the same explicit trust policy used for other remote reads.

### 3. High — DNS “pinning” is validation-only and remains vulnerable to rebinding

**Introduced:** PR #4.
**Evidence:**

- `lib/plugin-marketplace-network-policy.ts:140-170` resolves DNS and stores `pinnedAddresses` after checking them.
- `lib/plugin-marketplace-network-policy.ts:232-248` calls `fetchImpl(pinned.url.href, ...)`, which still contains the hostname; `pinnedAddresses` is never passed to the dispatcher, lookup function, or socket connection.

The code therefore validates one DNS answer and allows the HTTP client to perform a fresh resolution. A hostname that answers with a public address during validation and a private address when `fetch` connects can reach the private network. Redirects are revalidated, but each hop has the same TOCTOU weakness.

**Required disposition:** Bind the request to the validated address through a custom `lookup`/dispatcher while preserving TLS SNI and the HTTP `Host` header, or revalidate the actual connected peer address. Add a deterministic rebinding test with a fetch implementation that observes the chosen address. Do not describe the current behavior as DNS pinning until the connection itself is pinned.

### 4. High — Native source switching is below the owner boundary and does not perform a real health check

**Introduced:** PR #4.
**Evidence:**

- `server/http/route-security.ts:560-575` classifies `POST /api/plugins/:pluginId/source-switch` as `scoped("settings.write")`; it is not included in `isNativeMarketplaceLifecycleRoute`.
- `server/routes/plugins.ts:1511-1549` never calls `principalFlags(c)` or checks `isStudioOwner`.
- `desktop/src/react/settings/tabs/PluginMarketplaceTab.tsx:1206-1232` renders the switch button without an owner guard and sends no registry revision/digest or signed plan token.
- `server/routes/plugins.ts:1524-1534` swallows `installPlugin` and `enablePlugin` errors and implements `healthCheck() { return true; }`.

A principal with `settings.write` but not `studio.owner` can reach this route. The route disables the active projection, replaces `plugins/<pluginId>`, invokes PluginManager, and commits the new active pointer. A candidate can be marked active even when PluginManager returns a failed/incompatible/restricted entry or when activation fails, because the runtime hook suppresses errors and the coordinator receives `true` as its health result.

This violates the same owner-only, exact-identity, typed-plan contract that the native install/uninstall routes enforce. It also makes a failed source switch look successful and can leave the runtime and durable records disagreeing.

**Required disposition:** Classify the route as `studio_owner`; require exact `pluginId@marketplaceId`, current registry revision/digest, and a signed/typed switch plan. Pass and inspect the PluginManager result, propagate failures, and implement a real health check plus restore hook. Add route-principal and failed-activation tests.

### 5. Medium — Source switching drops the marketplace active marker and weakens digest-scoped trust

**Introduced:** PR #4.
**Evidence:**

- `lib/plugin-source-switch.ts:314-324` copies the retained artifact into the active projection and removes `.hana-artifact.json`, but never writes `.hana-marketplace.json`.
- `server/routes/plugins.ts:1528-1531` calls `installPlugin(input.artifactPath)` without passing a `marketplaceInstall` descriptor.
- `core/plugin-manager.ts:1395-1402` reads the marker and falls back to the global `allow_full_access` switch when the marker is absent.
- The normal native install path writes the marker and passes the marketplace install identity at `server/routes/plugins.ts:552-568`.

Retained artifacts do not automatically contain the active marker. After a source switch, the active projection can be scanned as an ordinary community plugin with no source-qualified artifact digest. The trust store's per-marketplace/per-digest grant is then no longer the controlling runtime fact; the PluginManager falls back to the global full-access ceiling.

**Required disposition:** Write the active marker during projection staging and pass the exact `marketplaceInstall` descriptor into PluginManager. Add a regression test that switches a full-access plugin and verifies marker persistence, trust grant enforcement, and uninstall revocation.

### 6. Medium — Switch-journal recovery exists only as an uncalled helper

**Introduced:** PR #4.
**Evidence:**

- Journals are written during the switch at `lib/plugin-source-switch.ts:160-230`.
- `recoverIncompleteTransactions()` is implemented at `lib/plugin-source-switch.ts:281-307`.
- The only non-test call-site is absent; the only repository reference outside the implementation is `tests/plugin-source-switch.test.ts:310-314`.

A process crash after `_stageActiveProjection()` removes the old active directory but before `retainAndActivate()` commits the new pointer leaves the live projection, install records, activation state, and transaction journal divergent. No server/engine startup path reads the journal, so the recovery code cannot restore the previous committed source.

**Required disposition:** Invoke recovery during startup before PluginManager loads community plugins, or add an equivalent boot reconciliation step. The recovery path must also preserve the marker/trust fix above. Add a process-boundary or boot-level integration test.

### 7. Medium — The full-list skill PUT preserves package-owned names in the wrong persistence field

**Introduced:** PR #4.
**Evidence:** `server/routes/skills.ts:544-568` filters incoming marketplace skills out of `ordinaryEnabled` but then re-appends any package-owned names already present in the old `skills.enabled` list through `packageNames`.

The new contract stores package-owned per-Agent preferences under source-qualified `marketplace_overrides`; package skills should not remain in the ordinary `skills.enabled` list. Current runtime code mostly ignores `enabledSet` for recognized marketplace skills, so this is primarily stale/dead configuration today, but it leaves old clients and fallback paths with an ambiguous source of truth and can make package migrations/reinstalls difficult to reason about.

**Required disposition:** Remove marketplace-owned names from `skills.enabled` on the full-list PUT and preserve only their source-qualified override state. Add a regression test for an old config containing a package skill in `skills.enabled`.

### 8. Medium — Marketplace UI introduces user-visible English strings outside localization

**Introduced:** PR #4.
**Evidence:** `desktop/src/react/settings/tabs/PluginMarketplaceTab.tsx:678-688,739-753,779-799,823-826,995-1005,1355,1389-1391,1431-1486` contains raw English confirmation, toast, status, heading, and error strings while the PR also modifies all five locale files.

Examples include `Install native Marketplace plugin ...?`, `Native Marketplace uninstall failed`, `Marketplace skills uninstall is partial`, `Warnings`, `Supported server`, and `Enable Agent Access`. Users in Japanese, Korean, Traditional Chinese, or Chinese locales will see English in the new Marketplace UI.

**Required disposition:** Add locale keys for all user-facing strings and use `t()` consistently. Add a locale coverage test that fails on newly introduced user-facing literals in this tab.

### 9. Medium — Legacy Claude install route ignores the registry preconditions sent by the UI

**Introduced:** PR #4.
**Evidence:**

- `desktop/src/react/settings/tabs/PluginMarketplaceTab.tsx:695-708` sends `expectedRevision` and `expectedDigest` to the legacy `POST /api/plugins/marketplace/:id/install` route.
- `server/routes/plugins.ts:1740-1758` calls `installClaudePluginSkills()` with only `userSkillsDir` and `isStudioOwner`; it does not forward the request preconditions or the planned source snapshot.
- `lib/plugin-marketplace-service.ts:343-375` therefore has no stale-plan facts to validate for this path.

The route is owner-gated, so this is not an unauthenticated mutation, but it violates the documented “current registry revision/digest and fresh plan” contract. A stale UI can install against newly changed catalog/source state without receiving the expected conflict.

**Required disposition:** Forward and validate `expectedRevision`, `expectedDigest`, and the selected source snapshot, or remove the legacy skills mutation path in favor of the plan/execute contract. Add a stale legacy-route regression test.

### 10. Medium — Marketplace code and UI cross the project’s maintainability size boundary

**Introduced:** PR #4.
**Evidence:**

| File | Base lines | PR-head lines |
|---|---:|---:|
| `desktop/src/react/settings/tabs/PluginMarketplaceTab.tsx` | 303 | 1,493 |
| `desktop/src/react/settings/tabs/PluginsTab.tsx` | 746 | 1,063 |
| `server/routes/plugins.ts` | approximately 1,240 | approximately 2,216 |
| `lib/plugin-marketplace-service.ts` | new | 1,446 |
| `lib/plugin-marketplace-sources.ts` | new | 1,330 |
| `lib/tools/plugin-marketplace-tool.ts` | new | 866 |

The strict code-review rule treats crossing 1,000 lines as a presumptive decomposition problem. `PluginMarketplaceTab` now combines fetching, source management, package installation, native plan/execute, compatibility panels, README rendering, agent access, and switch operations. The route and service similarly combine orchestration, persistence, inventory, and lifecycle concerns.

**Required disposition:** Split the UI into focused hooks/panels, split route registration from lifecycle handlers, and separate registry persistence, catalog/inventory projection, and install/uninstall orchestration. This is a structural merge blocker for the strict review bar even where behavior is currently covered.

### 11. Low — Stray cache/artifact directories can crash marketplace listing and source removal

**Introduced:** PR #4.
**Evidence:**

- `lib/plugin-marketplace-snapshots.ts:136-155` iterates directory names and passes them to strict marketplace-ID validation without isolating malformed entries.
- `lib/plugin-artifact-store.ts:129-157` has the analogous source/artifact listing path.

A stray or partially-created directory with a name outside the ID grammar can throw, turning catalog listing or `isSourceInUse` checks into a 500 until the directory is manually removed.

**Required disposition:** Skip and diagnose malformed filesystem entries consistently with the guarded install-record scanner in `lib/plugin-marketplace-claude-skills.ts:289-308`. Add a stray-directory robustness test.

### 12. Low — Skill uninstall has no provenance check before recursive deletion

**Introduced:** PR #4.
**Evidence:** `lib/plugin-marketplace-claude-skills.ts:314-325,440-466` validates only the recorded skill name and containment, then recursively removes `userSkillsDir/<name>`.

If a user or another package replaces a recorded directory after installation, the exact-name uninstall deletes the replacement. The UI does disclose this risk in its confirmation text, so this is not an undisclosed authority bypass, but the record does not retain a digest/source marker that would permit a safer ownership check.

**Required disposition:** Prefer provenance metadata plus a trash/restore path, or refuse deletion when the on-disk source does not match the install record. Keep the explicit warning if name-based cleanup remains the compatibility behavior.

### 13. Low — PR-head whitespace hygiene fails

**Introduced:** PR #4. `git diff --check 992e640e550741b9d46534b105f6a445ab6d8a7b 6d424bff7aa2ed2d2420449c59f09e29523b085f` exits 2 because of:

- trailing whitespace in `docs/plugins/2026-07-30-claude-marketplace-skills-lane-design.md:3-5,38-39,228-231`;
- trailing whitespace in `docs/superpowers/specs/2026-07-31-manage-plugin-skill-package-page-design.md:3`;
- a new blank line at EOF in `tests/plugin-marketplace-native-lifecycle.test.ts:125`.

**Required disposition:** Clean the three PR-head hygiene issues before merge. No source remediation was applied during this review.

## Non-blocking observations

- The registry `lastKnownGood` field is meaningful as “the effective state is a fallback after degradation,” but its name is easy to misread as “a known-good file exists.” Clarify the API contract or rename it; add healthy/degraded semantic tests.
- Stable serialization and plan-token helpers are duplicated across `plugin-marketplace-identity.ts`, `plugin-marketplace-tool.ts`, `plugin-marketplace-native-lifecycle.ts`, and `claude-compatibility.ts`. Consolidating them would reduce security-sensitive drift.
- Registry writes are precondition-protected when callers send revision/digest, but the HTTP source mutation routes still accept omitted preconditions. Prefer requiring them on every mutation or routing every writer through one engine-owned service instance.
- The pure-auto plan token is a deterministic hash of public facts rather than a server-secret MAC. It is a freshness token, not an authority credential. That can be acceptable only after the host owner gate is fixed and the documentation clearly distinguishes the two.

## Compatibility and invariant audit

### Native Hana plugins remain PluginManager-owned

The PR preserves `GET /api/plugins` as the native PluginManager inventory. Installed Claude/marketplace skill packages use the separate `GET /api/plugins/marketplace/installed-skill-packages` route. The native dropzone still reaches the existing PluginManager install path. Native marketplace install/uninstall uses the Studio-owner Settings plan/execute lifecycle, and the generic `DELETE /api/plugins/:id` path rejects marketplace-native entries instead of silently deleting them.

The source-switch route is the exception that needs correction: it directly drives the native runtime without the owner/typed-plan/health/provenance guarantees of the native lifecycle.

### Claude marketplace packages remain Hana skills

The PR correctly classifies Claude packages as the `hana-skills` destination, installs only supported `SKILL.md` content through the skill manager, rejects unsupported Claude components, prevents symlink entries, and never calls native `PluginManager.removePlugin()` from the skill uninstall path. Agent-driven native install remains explicitly blocked.

### Source-qualified state and one active runtime source

Catalog rows, activation keys, retained artifacts, install records, trust grants, and per-Agent package preferences use `pluginId@marketplaceId` or the equivalent qualified identity. The runtime intentionally keeps one bare `plugins/<pluginId>` active projection. The source-switch marker loss, missing owner gate, and missing boot recovery currently undermine that otherwise coherent model.

### Activation, persistence, trust, and uninstall contracts

The full activations PUT is owner-gated and uses revision/digest checks. The desktop clones the owner snapshot and refuses to toggle if the snapshot is missing. Package gates default to enabled when no record exists, remain separate from per-Agent preferences, and are enforced by SkillManager. Skill package uninstall uses `DELETE /api/plugins/marketplace/:id/skills`, cleans agent/bundle references, preserves partial records, and does not mutate native PluginManager inventory.

### Fork-only fixes and upstream behavior

No reviewed PR path intentionally replaces the fork's LAN CSP/WebSocket auth fix, local build identity/auto-update policy, fork-sync `dev`/`upstream/main` policy, server installer/reinit safety, packaged CLI CJS externalization, data-epoch timeout policy, or sg01/Caddy operational boundary. These remain fork-owned and must be preserved during any future upstream sync.

The review does not claim any upstream issue is fixed merely because PR #4 touches a neighboring route or boundary. The complete relation tables below record overlaps and follow-ups explicitly.

## Relation to every local issue/draft in `docs/upstream-issues`

`relationship` describes whether the PR touches a neighboring boundary; `PR relation` records whether PR #4 preserves, overlaps, or does not address the item. No row is silently marked fixed.

| Local item | Class | Tracker state | Relationship | PR relation | Disposition |
|---|---|---|---|---|---|
| `lan-csp-ws-auth` | upstream | existing/open | affected | preserves | Not fixed; preserve the fork LAN CSP, query-token, and WebSocket behavior. |
| `lan-query-token-network-hardening` | upstream | draft/pending-approval | follow-up | overlaps | Marketplace network policy is adjacent, but no LAN no-referrer or probe hardening is implemented. |
| `remote-attachment-preview-persistence` | upstream | draft/pending-approval | follow-up | does-not-address | No remote attachment/resource/CSP implementation or tests are in the PR. |
| `desktop-temp-upload-session-cache-materialization` | upstream | draft/pending-approval | follow-up | does-not-address | No temp-upload/session-cache paths are in scope. |
| `session-replay-marker-only-image-regenerate` | upstream | draft/pending-approval | follow-up | does-not-address | No replay/session-turn implementation is in scope. |
| `toolgroup-file-detail-link-context` | upstream | draft/pending-approval | follow-up | does-not-address | No ToolGroup/internal-link implementation is in scope. |
| `provider-model-removal-persistence` | upstream | draft/pending-approval | follow-up | does-not-address | No provider model route/registry implementation is in scope. |
| `vision-capability-settings-sot` | upstream | local-verified | follow-up | does-not-address | Existing provider/model settings fix remains separate. |
| `remote-skill-viewer-local-file-ipc` | upstream | draft/pending-approval | follow-up | overlaps | Skills routes/UI change, but no authenticated remote file-tree/content transport is added. |
| `remote-skill-install-client-local-path` | upstream | draft/pending-approval | follow-up | overlaps | Marketplace server-owned installation does not solve the general remote SkillsPanel path/upload rule. |
| `plugin-iframe-remote-credential-query-leak` | upstream | draft/pending-approval | follow-up | overlaps | Plugin route classification changes, but no remote iframe credential-query fix is added. |
| `local-build-identity-disable-auto-update` | fork-only | tracked/no-upstream-issue | affected | preserves | Generated boot/build receipts are touched; local channel policy remains fork-owned. |
| `fork-sync-issue-tracking-prerelease-policy` | fork-only | tracked/no-upstream-issue | affected | preserves | `FORK_SYNC.md` and `docs/fork-sync/rules.yml` remain authoritative; `dev` is not changed into an upstream target. |
| `fork-dev-loop-maintenance-runbooks` | fork-only | tracked/no-upstream-issue | affected | preserves | Marketplace verification references do not replace retired deploy/runbook policy. |
| `office-workflow-example-plugin` | fork-only | tracked/no-upstream-issue | unchanged | does-not-address | Outside the marketplace implementation. |
| `office-workflow-resourceio-session-permission` | fork-only | tracked/no-upstream-issue | unchanged | does-not-address | Outside the marketplace implementation. |
| `server-install-upgrade-release-safety` | fork-only | tracked/no-upstream-issue | unchanged | does-not-address | Installer/release safety is unchanged. |
| `server-reinit-data-failsafe` | fork-only | tracked/no-upstream-issue | unchanged | does-not-address | Reinit/restore safety is unchanged. |
| `server-reinit-restore-backup-verification` | fork-only | tracked/no-upstream-issue | unchanged | does-not-address | Restore-backup verification is unchanged. |
| `node-test-ci-file-mode-hygiene` | fork-only | tracked/no-upstream-issue | unchanged | does-not-address | Fork CI/file-mode policy is unchanged. |
| `legacy-raw-release-profile-evidence` | fork-only | tracked/no-upstream-issue | affected | preserves | Signed versus legacy-raw release policy remains fork-owned. |
| `packaged-cli-shared-cjs-externalize` | fork-only | local-verified | affected | preserves | CLI CJS externalization remains unrelated fork behavior. |
| `loopback-trusted-https-proxy-secure-cookies` | fork-only | local-verified | affected | preserves | Loopback forwarded-proto and secure-cookie behavior is not replaced. |
| `data-epoch-windows-fail-closed-timeout` | fork-only | local-verified | unchanged | does-not-address | Fork CI timeout policy is outside PR #4. |
| `sg01-public-https-caddy-ops-docs` | fork-only | tracked/no-upstream-issue | unchanged | does-not-address | sg01/Caddy operations are outside PR #4; no host mutation was performed. |

## Explicit upstream issue relations

Issue states were refreshed from GitHub on 2026-08-04/05. The freshness search route returned no usable source URLs; direct `gh issue view` data is authoritative for the listed state. Issue `#2252` was added because the tracker search surfaced it as a current vision-bridge issue related to the local vision draft.

| Issue | State | Relationship | PR relation | Disposition |
|---|---|---|---|---|
| [#803](https://github.com/liliMozi/openhanako/issues/803) | OPEN | follow-up | overlaps | Multi-source catalog/discovery infrastructure is relevant, but featured/recommended ranking and a curated community index are not implemented. |
| [#996](https://github.com/liliMozi/openhanako/issues/996) | OPEN | follow-up | preserves | HyperFrames npx quoting, manifest compatibility, and loading diagnostics are not changed. |
| [#1493](https://github.com/liliMozi/openhanako/issues/1493) | OPEN / REOPENED | follow-up | overlaps | Host route classification changes do not add the iframe credential fix. |
| [#1546](https://github.com/liliMozi/openhanako/issues/1546) | CLOSED / COMPLETED | affected | preserves | Historical iframe fix remains a behavior to preserve. |
| [#1749](https://github.com/liliMozi/openhanako/issues/1749) | OPEN | follow-up | preserves | LAN CSP and WebSocket query-token auth are unchanged; preserve the fork fix. |
| [#1811](https://github.com/liliMozi/openhanako/issues/1811) | CLOSED / COMPLETED | affected | preserves | Closed LAN auth/CSP behavior is not claimed as a PR fix. |
| [#1904](https://github.com/liliMozi/openhanako/issues/1904) | OPEN | follow-up | does-not-address | Provider model metadata persistence is outside PR #4. |
| [#2065](https://github.com/liliMozi/openhanako/issues/2065) | OPEN | follow-up | overlaps | No WebView bridge or authenticated postMessage tunnel is added. |
| [#2188](https://github.com/liliMozi/openhanako/issues/2188) | OPEN | follow-up | does-not-address | SessionFile hydration race is outside PR #4. |
| [#538](https://github.com/liliMozi/openhanako/issues/538) | OPEN | follow-up | does-not-address | Dynamic provider model capability discovery is outside PR #4. |
| [#594](https://github.com/liliMozi/openhanako/issues/594) | OPEN | follow-up | does-not-address | Automatic multimodal model discovery is outside PR #4. |
| [#1854](https://github.com/liliMozi/openhanako/issues/1854) | CLOSED / COMPLETED | unchanged | preserves | Historical vision auxiliary behavior is not changed. |
| [#1919](https://github.com/liliMozi/openhanako/issues/1919) | CLOSED / COMPLETED | unchanged | preserves | Historical custom-provider vision-save behavior is not changed. |
| [#2252](https://github.com/liliMozi/openhanako/issues/2252) | OPEN | follow-up | does-not-address | Gemini `google-generative-ai` buffered-adapter failure is outside the marketplace implementation. |

## Verification evidence

All commands below were run against the exact detached PR head unless stated otherwise.

| Check | Result |
|---|---|
| Manage Plugins compatibility Vitest suite | **PASS** — 22 files, 349 tests |
| Broader marketplace approval/runtime/UI Vitest suite | **PASS** — 34 files, 579 tests |
| `npm run typecheck` | **PASS** — all three TypeScript passes |
| `npm run build:client` | **PASS** — main, preload, renderer, splash, theme builds |
| `npm run lint` | **PASS** exit 0; warnings remain, including existing `any`/empty-block warnings |
| `git diff --check base..head` | **FAIL** exit 2; three hygiene locations listed in finding 13 |
| Mapped IPv6 policy probe | **FAIL as security assertion** — hex mapped private/loopback values return `false` |
| Route authorization probe | **FAIL as contract assertion** — `settings.write` alone authorizes source-switch classification |
| Real-entry smoke run 1 | **Unavailable for isolated smoke** — `npm run server` found an existing kernel in the launcher-selected dev data directory and never published the requested isolated `server-info.json` |
| Real-entry smoke run 2 | **Unavailable for isolated smoke** — the server log reached `ready`, but the launcher overwrote the requested `HANA_HOME` with `~/.hanako-dev`; the harness therefore found no isolated run-directory `server-info.json` and did not claim endpoint or lifecycle success |

The narrower Manage Plugins compatibility suite was run with:

```bash
npx vitest run tests/plugin-marketplace-*.test.ts \
  tests/http-route-security.test.ts \
  tests/skill-manager.test.ts \
  tests/skills-route.test.ts \
  desktop/src/react/__tests__/settings/PluginMarketplaceTab.test.tsx \
  desktop/src/react/__tests__/settings/PluginsTab.test.tsx
```

The broader marketplace approval/runtime/UI suite was run with:

```bash
npx vitest run tests/plugin-marketplace-*.test.ts \
  tests/approval-gateway.test.ts \
  tests/http-route-security.test.ts \
  tests/plugin-routes.test.ts \
  tests/plugin-manager.test.ts \
  tests/skill-manager.test.ts \
  tests/skills-route.test.ts \
  tests/plugin-source-switch.test.ts \
  tests/plugin-trust-store.test.ts \
  tests/marketplace-skill-preferences.test.ts \
  tests/engine-marketplace-skill-preferences.test.ts \
  tests/hana-agent-marketplace-smoke.test.mjs \
  desktop/src/react/__tests__/settings/AddMarketplaceSourceDialog.test.tsx \
  desktop/src/react/__tests__/settings/MarketplaceSourcesPanel.test.tsx \
  desktop/src/react/__tests__/settings/PluginMarketplaceTab.test.tsx \
  desktop/src/react/__tests__/settings/PluginsTab.test.tsx \
  desktop/src/react/settings/tabs/__tests__/SkillsTab.test.tsx \
  desktop/src/react/settings/tabs/skills/__tests__/marketplace-package.test.ts
```

Both commands were re-run against the exact PR head on 2026-08-05; the broader rerun supersedes an earlier ephemeral scratch summary that reported a non-reproducible 17-file/374-test count.

The launcher behavior is pre-existing (`scripts/dev-env.js:8-13` unconditionally assigns the dev home), not a PR #4 source finding. The exact sanitized server and runner logs, focused suites, typecheck, build, lint, and diff-check outputs are retained in the private review scratch area. No tokens or server credentials were copied into this report.

Because both runs failed the isolated readiness contract, this review does **not** claim that the real marketplace lifecycle smoke passed. The static/unit fallback is the focused suite plus the directed security probes above. Manual desktop smoke remains a separate pending item in the existing SkillWiki work record.

## Required merge disposition

Do not approve or merge PR #4 until at least the following are addressed and retested:

1. Host-enforce owner authority for Agent marketplace mutations.
2. Close both public-HTTPS SSRF gaps: normalize all IPv6 forms and actually bind requests to validated DNS addresses.
3. Move source switching under the native Studio-owner plan/execute boundary; validate PluginManager health/results, preserve the marketplace marker/trust identity, and wire journal recovery at boot.
4. Re-run the focused suite, typecheck, build/lint, diff check, and two genuinely isolated real-entry smoke runs.
5. Decompose the over-1,000-line UI/route/service modules or obtain an explicit maintainability waiver.
6. Localize the new UI strings and enforce the legacy route's stale registry preconditions.

No upstream issue was submitted, no PR state was changed, and no production host was touched.
