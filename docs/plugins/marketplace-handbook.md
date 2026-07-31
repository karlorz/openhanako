# Hana marketplace handbook

Hana marketplaces are owned by the connected Hana server. Settings, Hana Agent chat, and the HTTP API all read the same source registry and shared catalog. A desktop client does not silently create a second registry, reinterpret a desktop path as a server path, or bypass server ownership.

## Start with server capability and ownership

Open **Settings → Plugins → Plugin Marketplace**. A supported server reports the marketplace capability contract, registry revision and digest, source state, and catalog count. An old server is shown as unsupported with upgrade guidance; that state is different from a supported server whose registry or catalog is empty.

Catalog inspection and status questions are read-only. Adding, removing, enabling, disabling, or refreshing a source; changing activation/access records; installing a package; and changing a Claude compatibility binding require server owner access. Mutations must be confirmed immediately before execution and are rejected when their registry revision, digest, or plan token is stale.

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
| Native Hana plugin | A Hana-native package interpreted by the existing PluginManager contract. | Native marketplace installation is currently preview-only. Agent-driven native install is blocked. |
| Hana-compatible skills | Supported `SKILL.md` content imported through the existing skill manager. | Use **Settings → Skills** and **Agent Skill Toggles** for activation. Package enable is a separate global gate (below). |
| Unsupported / review required | Unsupported Claude source form or behavior, incomplete package, or package outside the current safety envelope. | Inspect warnings only; no normal install action is shown. |

The destination is a read-only fact for the resolved source revision. There is no “convert to native plugin” selector. Imported marketplace skills are never labeled as native plugins and do not enter PluginManager.

Catalog details show the install adapter, installability, confirmation level, capability inventory, warnings, and install-plan consequences. Dependency declarations, unsupported components, incomplete packages, binaries, and lifecycle scripts are warnings or blockers; Hana does not silently install or execute them.

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

Hana-compatible marketplace skills keep the existing Skills permission model. The Plugin Marketplace links to Skills; it does not duplicate Skill Installation Permissions or per-Agent skill toggles inside Native Plugins.

## Hana Agent chat

The `plugin_marketplace` Agent tool can inspect sources, catalog rows, packages, configuration diagnostics, and Claude bindings without confirmation. It can prepare install and compatibility plans without mutation.

Before a mutation, Hana shows a concise operation summary containing the exact qualified target, connected-server ownership requirement, warnings, revision/digest or plan token, and the operation that will occur. The explicit confirmation control is the final step before execution. Adding a source may be followed by an offer to browse its catalog, but Hana does not auto-install recommendations.

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
