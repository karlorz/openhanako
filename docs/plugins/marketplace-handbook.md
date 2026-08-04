# Hana marketplace handbook

Hana marketplaces are owned by the connected Hana server. Settings, Hana Agent chat, and the HTTP API all read the same source registry and shared catalog. A desktop client does not silently create a second registry, reinterpret a desktop path as a server path, or bypass server ownership.

## Start with server capability and ownership

Open **Settings → Plugins → Plugin Marketplace**. A supported server reports the marketplace capability contract, registry revision and digest, source state, and catalog count. An old server is shown as unsupported with upgrade guidance; that state is different from a supported server whose registry or catalog is empty.

Catalog inspection and status questions are read-only. Adding, removing, enabling, disabling, or refreshing a source; changing activation/access records; installing a package; and changing a Claude compatibility binding require server owner access. Mutations must be confirmed immediately before execution and are rejected when their registry revision, digest, or plan token is stale.

## Desktop Plugins controls

The compact controls under **Settings → Plugins** distinguish navigation,
source mutation, and package state without adding a second management model:

- The **Plugin Marketplace** teaser is a full-row link to the detailed
  Marketplace page; its browse glyph is only a visual affordance, so clicking
  the title or description opens the same destination.
- **＋ Add source** is the single compact outlined text action. Refresh,
  browse/open, configuration, and removal controls are bare utility icons;
  they use color-only hover/focus feedback rather than filled button surfaces.
- For a mutable custom source, the actions are ordered **refresh → remove × →
  enable/disable toggle**. The × opens the ordinary removal confirmation.
  The switch changes only source enablement; it retains the same owner,
  revision, digest, and confirmation protections as the former Enable/Disable
  action.
- Official, legacy, immutable, degraded, and non-owner source rows remain
  read-only. A visual control never bypasses the server ownership or stale
  configuration rules described below.

## Source forms

Hana accepts three server-owned source forms:

- Public HTTPS catalog: `https://plugins.example.org/marketplace.json`
- Public HTTPS Git: `https://github.com/example-org/hana-marketplace`
- Server-local path: a path inside the server's configured marketplace root

Git sources may declare a ref such as `refs/heads/stable`, a release tag, or another server-accepted ref. They may also declare an index subdirectory/path. Pinning a ref controls which repository revision Hana resolves; it does not make unsupported package behavior executable. Package subdirectories are interpreted by the catalog adapter and remain subject to path-containment and completeness checks.

Private Git credentials, SSH URLs, credential-bearing URLs, arbitrary desktop-local paths, and paths outside the server's allowed local root are not accepted. A remote desktop sees server-local paths as redacted. When Settings says `server-local`, it means local to the connected Hana server, not local to the Mac or browser displaying Settings.

Every package identity is source-qualified, for example `review-tools@team-market`. Duplicate package ids from different sources remain separate. Enable, disable, access, planning, and install operations must use the qualified identity.

## Immutable install destinations

Hana classifies every resolved catalog package before it offers an action:

| Destination | Meaning | Follow-up |
|---|---|---|
| Native Hana plugin | A Hana-native release package interpreted by the existing PluginManager contract. | A Studio owner may use the Settings plan/execute lifecycle when `nativeMarketplaceSettingsLifecycle` is advertised. Agent-driven native install remains blocked. |
| Hana-compatible skills | Supported `SKILL.md` content imported through the existing skill manager. | Use **Settings → Skills** and **Agent Skill Toggles** for activation. Package enable is a separate global gate (below). |
| Unsupported / review required | Unsupported Claude source form or behavior, incomplete package, or package outside the current safety envelope. | Inspect warnings only; no normal install action is shown. |

The destination is a read-only fact for the resolved source revision. There is no “convert to native plugin” selector. Imported marketplace skills are never labeled as native plugins and do not enter PluginManager.

Catalog details show the install adapter, installability, confirmation level, capability inventory, warnings, and install-plan consequences. Dependency declarations, unsupported components, incomplete packages, binaries, and lifecycle scripts are warnings or blockers; Hana does not silently install or execute them.

For native packages, catalog availability, verified download cache, retained
artifact, active installation, runtime state, and Agent Access are separate
facts. A retained ZIP or extracted artifact is not installed. Native install
and uninstall require Studio-owner authority, exact typed identity, current
registry revision/digest, and a fresh signed plan bound to version, package
SHA-256, catalog/source facts, and the current active pointer. Uninstall removes
the active projection and its artifact trust grant while preserving verified
downloads, retained artifacts, backups, and lifecycle history as non-installed
evidence.

## Manage Plugins inventory and package enable gate

Installed Hana-skill marketplace packages appear under **Settings → Plugins → Manage Plugins** alongside native community plugins. They are listed as Hana-skill packages (skill-manager destination), not as PluginManager runtime plugins.

- **Inventory:** Manage Plugins lists installed marketplace skill packages (`pluginId@marketplaceId`) with package state (installed / partial / stale) and package enable status. Catalog-only (`not-installed`) packages stay on Plugin Marketplace, not Manage Plugins.
- **API:** `GET /api/plugins/marketplace/installed-skill-packages` returns inventory rows plus registry revision/digest. Server owners also receive an activations snapshot so enable toggles can safely clone and `PUT /api/plugins/marketplace/config/activations` without wiping sibling activation maps (that route replaces the full activations object).
- **Package enable toggle:** Owner-only. Writes `activations.marketplaceSkillPackages[pluginId@marketplaceId] = { enabled }`. Missing record means **enabled** (installed-default). This is a **global skill-manager gate**: when disabled, skills from that package are gated off for every Agent, independent of per-Agent skill toggles (prefs are kept; runtime is inactive).
- **Not PluginManager:** Package enable does not load, unload, or reconfigure native plugins. Uninstall uses `DELETE /api/plugins/marketplace/:id/skills`. Install, Uninstall, and **Manage in Skills** remain the skill lifecycle and per-skill activation paths. The native dropzone under Manage Plugins still installs only PluginManager packages.
- **Plugin Marketplace detail:** When a Hana-skill package is installed (not `not-installed`), the catalog inspector shows the same package enable toggle bound to `packageActivation` / `marketplaceSkillPackages`, while keeping Install / Uninstall / Manage in Skills actions.

### Per-Agent skill defaults and opt-outs

An installed Hana-skill package is enabled for every Hana Agent by default when
its global package gate is enabled. This applies to Agents using any supported
model or provider; the package is not delegated to a Claude Code, Grok, or
other external runtime configuration.

The package gate and the individual Agent preference have different scopes:

- **Manage Plugins** controls the source-qualified global package gate at
  `activations.marketplaceSkillPackages[pluginId@marketplaceId]`.
- **Skills → Agent Skill Toggles** controls one Agent's individual skill
  preference. An absent entry means enabled by default; it does not mean
  disabled.
- A package-gated skill reports its preference (`enabled`) separately from
  runtime availability (`active`). Turning a package off makes the skill
  inactive for every Agent but does not erase individual preferences.

Hana persists an explicit per-Agent opt-out in that Agent's `config.yaml`:

```yaml
skills:
  enabled:
    - pdf
  marketplace_overrides:
    skillwiki@llm-wiki:
      disabled:
        - wiki-query
```

The package key is always `pluginId@marketplaceId`. Disabled names are scoped
to that package, so the same skill name from a different marketplace does not
inherit the preference. Preferences remain dormant across package disable,
complete uninstall, and reinstall of the same source-qualified identity. New
skills added to an installed package default on unless that Agent already has
the matching explicit disabled entry.

Marketplace skill package rows are not native PluginManager plugins. Their
individual toggles use the existing explicit-agent Skills API and do not write
to the package or to the global marketplace activations file.

## Server runtime and selected-Agent access

Native Plugins has two distinct scopes:

1. **Server runtime & sources** covers the shared source registry, installed runtime artifact state, full-access policy, and server-global contributions.
2. **Selected-Agent Plugin Access** controls the selected Agent's use of agent-facing tools, commands, chat cards, and agent-aware surfaces for an exact source-qualified native package.

Routes, providers, extensions, lifecycle/background behavior, and other server-global contributions remain owner-reviewed server state. Agent Plugin Access is not a promise that a global plugin is unloaded or sandboxed separately for each Agent.

Agent Plugin Access is offered only when the exact `pluginId@marketplaceId`
native identity is actively installed. It cannot install or load a package, and
the backend rejects attempts to enable access for an absent or retained-only
artifact. A full-access Marketplace plugin additionally requires an exact
artifact-digest trust grant and the global full-access ceiling. With the global
ceiling off, the package may remain installed with runtime state `restricted`.

Hana-compatible marketplace skills keep the existing Skills permission model. The Plugin Marketplace links to Skills; it does not duplicate Skill Installation Permissions or per-Agent skill toggles inside Native Plugins.

## Hana Agent chat

The `plugin_marketplace` Agent tool can inspect sources, catalog rows, installed
Hana skill packages, configuration diagnostics, and Claude bindings without
confirmation. It can prepare install, uninstall, and compatibility plans
without mutation.

For Claude-compatible sources and Hana skill packages, the high-level Agent
actions are:

- source lifecycle: `list_sources`, `add_source`, `refresh_source`,
  `set_source_enabled`, and `remove_source`;
- package inspection/install: `list_catalog`, `inspect_package`,
  `plan_install`, and `install`;
- installed package management: `list_installed_packages`,
  `set_package_enabled`, `plan_uninstall`, and `uninstall`.

Every package mutation requires exact `pluginId@marketplaceId` identity.
Source writes, package toggles, and uninstall execution require the current
registry revision and digest. Install and uninstall execution additionally
require the deterministic token from their matching plan action. Ordinary
package toggles accept only the exact package identity and requested boolean;
the Agent does not author or replace the full activations object.

Contained server-local Claude sources may install relative skill packages
through the skill manager when both the source root and package root remain
inside the configured local Marketplace root. Absolute package paths,
traversal, and symlink escape are rejected before any skill is copied. Git
source installation keeps the existing clone/ref/revision behavior.

Before a mutation, Hana shows a concise operation summary containing the exact qualified target, connected-server ownership requirement, warnings, revision/digest or plan token, and the operation that will occur. In `auto` (autoreview), reviewable mutations are sent to the automatic reviewer and fail closed if review rejects or is unavailable. In `operate` (full session access), the same reviewable mutations execute directly. Owner checks, stale-state checks, source containment, unsupported-component restrictions, and the Agent-driven native-install block remain enforced in both modes. Native Settings installation is a separate owner-only surface and is not callable through the Agent tool. Adding a source may be followed by an offer to browse its catalog, but Hana does not auto-install recommendations.

**Auto-mode operators:** automatic review needs working **utility** and
**utility_large** models on the Agent (credentials + provider reachable). Empty
or broken utility models typically surface as `TOOL_APPROVAL_DENIED` /
`TOOL_APPROVAL_UNAVAILABLE` / reviewer transport failures rather than a user
prompt. Do not “fix” auto UAT by patching marketplace mutation kinds from
`review` to `routine` on a live host bundle — that bypasses autoreview and is
not valid auto evidence. Prefer configuring utility models, or use `operate`
when operator full-session access is intentional.

**Plan-validated skill-package mutations under Auto:** for
`plugin_marketplace` install / package enable / uninstall, when the tool
invocation already carries a valid `planToken` (install/uninstall) or current
registry `expectedRevision` + `expectedDigest` (package enable/uninstall), the
approval gateway may **deterministically allow** the action without calling the
LLM reviewer (`ruleIds` includes
`marketplace-skill-package-plan-validated`). The tool still enforces owner
access, plan/token freshness, and registry preconditions. Cold install still
requires `plan_install` then `install` with the returned `planToken`. Git skill
installs pin materialization to the plan’s `resolvedRevision` so a branch move
between plan and install does not fail as a stale plan when the planned
revision is still fetchable.

Package uninstall uses the same shared lifecycle as
`DELETE /api/plugins/marketplace/:id/skills`: remove exact recorded skill
directories, clean handled Agent and bundle references, reload skills, emit
`skills-changed`, and report partial cleanup without claiming full success.
It never calls native `PluginManager.removePlugin()`.

Common outcomes are intentionally explicit:

- unsupported server: upgrade the connected server; the desktop will not emulate missing routes;
- owner denial: reconnect as a server owner or ask the owner to perform the change;
- missing install permission: grant the normal Hana install permission, then re-plan;
- stale plan/config: inspect current state and generate a fresh plan;
- desired-not-installed: activation/access was requested, but the exact artifact is absent;
- client-local path unavailable: use a server-local authorized path, mirror/snapshot input, or a future supported bridge;
- dependency/completeness warning: inspect the package; Hana will not silently fetch or execute missing dependencies;
- unsupported Claude behavior: inspect-only; hooks, MCP/LSP, commands/agents, binaries, lifecycle scripts, monitors, SessionStart behavior, environment/secrets, and Claude permission policy are excluded.

## JSON configuration-as-code

The server-owned `plugin-marketplaces.json` file is the advanced control plane. Settings shows its server-local/redacted path, validation status, current/last-valid revision, digest, and repair diagnostics behind progressive disclosure. The default UX is not a raw JSON editor.

API and Settings writes use atomic replacement plus revision/digest comparison. A stale writer receives a conflict instead of overwriting newer state. A valid direct edit changes desired configuration only; it does not fetch, install, promote, or activate content by itself.

If a direct edit is malformed, Hana keeps the last-known-good effective registry for inspection, marks the configuration degraded, and blocks acquisition and mutation. Repair the reported field/path, preserve source-qualified identities, increment from the last valid revision, save atomically, and reload diagnostics. Do not interpret `enabled` as `installed`: desired-not-installed is a supported diagnostic state.

## Claude compatibility bindings

Claude compatibility is a sanitized compatibility view, not a Claude Code runtime.

- `live` reads explicitly authorized server paths and refreshes at bounded safe boundaries;
- `mirror` persists a sanitized derived representation with provenance/digest;
- `snapshot` preserves an explicit sanitized point-in-time import.

Bindings show mode, enabled state, sanitized warnings, last-valid digest, pending Agent-snapshot boundary, input locality/redaction, and last-known-good diagnostics. Secret/environment data and unsupported executable or policy fields are excluded before persistence, logging, or bridge validation.

Discovered marketplaces appear as virtual compatibility sources. They are inspectable but cannot silently become native registry sources. Promotion requires a fresh owner-confirmed plan and normal registry mutation. Promotion still does not install a package or activate it.

### Desktop bridge availability

The server implements validation for `claude-compatibility-bridge.v1`: versioned, server/binding-bound, device/session-scoped, sanitized envelopes. The production desktop collection/transport is not available in this build. The desktop therefore does not read or transmit Claude files, secrets, or arbitrary content. Use server-local authorized paths, mirror, or snapshot mode until a separately reviewed desktop authorization and authenticated transport is implemented.

Bridge validation cannot promote a source, install a package, change activation/access, or bypass owner confirmation.

## HTTP API reference

Read endpoints include:

- `GET /api/plugins/marketplace/capabilities`
- `GET /api/plugins/marketplace/sources`
- `GET /api/plugins/marketplace/catalog?agentId=<agent-id>`
- `GET /api/plugins/marketplace/config`
- `GET /api/plugins/marketplace/compatibility/bindings`

Mutation endpoints include source lifecycle, stale-protected activation writes, package install, compatibility plan/execute, and bridge validation routes under `/api/plugins/marketplace/`. Use the exact payload returned by the current server contract; do not construct a generic raw-config mutation bypass. OpenHanako currently has no dedicated marketplace shell CLI, so operator automation should use the documented HTTP service contract or Hana Agent tool rather than assuming an unimplemented command.

Supported native Settings servers additionally expose owner-only plan and
execute routes under
`/api/plugins/marketplace/:id/native/{install,uninstall}/{plan,execute}`.
Older servers omit the capability and remain inspect-only. Native uninstall
never uses the Hana-skill `DELETE /api/plugins/marketplace/:id/skills` route.

For attended local verification without UI or Computer Use, run
`node scripts/hana-agent-marketplace-smoke.mjs` against the locally installed
Hana server. The harness creates two disposable contained Claude sources,
opens visible detached conversations in `auto` and `operate`, requires real
`plugin_marketplace` tool calls for the complete lifecycle, verifies
authoritative session branches and postconditions, and removes only its two
exact fixture identities.

## Troubleshooting and recovery

1. Confirm the connected server reports `plugin-marketplace-capabilities.v1`.
2. Distinguish unsupported server, owner denial, supported empty registry, disabled source, degraded configuration, and failed/stale source acquisition.
3. Check the exact source-qualified package identity and source status.
4. Re-open package inspection to see destination, adapter, confirmation level, capabilities, warnings, and current plan consequences.
5. For stale revision/digest/plan errors, reload and generate a new plan; never reuse the rejected token.
6. For invalid JSON, repair the reported path while preserving the last valid revision lineage; acquisition remains blocked until valid.
7. For desired-not-installed, install the exact supported artifact first, then use Skills or Agent Plugin Access according to its immutable destination.
8. For remote path confusion, remember that catalog/local/compatibility paths belong to the server and may be redacted on the client.

External repositories used in verification are fixtures only. They are not Hana product defaults, allowlist entries, dependencies, or required handbook examples.
