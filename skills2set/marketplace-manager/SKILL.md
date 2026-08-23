---
name: marketplace-manager
description: Manage Hana Marketplace sources and Claude-compatible skill packages, including installation, package enable or disable, per-Agent skill routing, uninstall, and troubleshooting. Use for Marketplace source or package operations and when distinguishing Hana skill packages from native PluginManager plugins; route native plugin authoring to hana-plugin-creator.
---

# Marketplace Manager

Manage existing Marketplace sources and packages through Hana's supported
Marketplace contract. Route native plugin creation, SDK work, and publication
to `hana-plugin-creator`.

## Keep the package models separate

- A **native Hana application plugin** has destination `native-plugin`, is
  owned by `PluginManager`, and may contribute tools, routes, providers,
  lifecycle code, UI, or plugin-owned skills.
- A **Claude-compatible Hana skill package** has destination `hana-skills`, is
  installed by `skill-manager`, and remains a Hana skill package even when it
  appears under Manage Plugins with a Hana skills badge.
- A **skill bundled inside a native plugin** uses the same `SKILL.md` format but
  remains plugin-owned and follows the native plugin lifecycle.

Do not choose an installer from a name, README, repository, archive layout, or
the presence of `SKILL.md`.

## Inspect before mutation

1. Classify the request: source management, package inspection, install,
   package enable/disable, per-Agent skill preference, uninstall,
   troubleshooting, or authoring.
2. Use `plugin_marketplace` to inspect the connected server, source-qualified
   identity, current revision/digest, package destination, adapter,
   installability, warnings, and installed state.
3. Route only from the inspected destination and adapter:

| Inspection result | Route |
|---|---|
| `hana-skills` + `skill-manager` | Use the Claude skill-package lifecycle. |
| `native-plugin` + `plugin-manager` | Use the Studio-owner Settings signed plan/execute lifecycle; Agent-driven native install remains unsupported (preview-only/deferred). |
| Unsupported or non-installable | Inspect only and report the blocker. |
| Authoring or development | Hand off to `hana-plugin-creator`. |
| Destination or adapter missing/ambiguous | Stop and inspect again. |

4. For a mutation, use the current source-qualified identity
   `pluginId@marketplaceId` and the latest revision, digest, and plan token
   required by the tool.
5. Re-inspect after mutation and report the verified state. Describe partial
   results as partial; never claim full success when cleanup or installation is
   incomplete.

## Select the correct control layer

- **Marketplace package gate**: global availability of one installed Hana
  skill package across all Agents. A whole-package request such as "disable
  every SkillWiki skill" uses `set_package_enabled`.
- **Agent Skill Toggle**: one skill preference for one Agent. A request such as
  "disable wiki-query only for Hanako" uses the Agent's skill settings.
- **Native plugin toggle**: PluginManager runtime enable/disable for a native
  application plugin.
- **Marketplace source toggle**: catalog/source availability. It does not
  enable or disable an installed package or an Agent skill.

An installed Hana skill package defaults enabled when no explicit global
package-gate record exists. Per-Agent opt-outs are separate and remain stored
when the package is disabled, uninstalled, or reinstalled under the same
source-qualified identity.

## Preserve permission boundaries

- In `auto` / autoreview mode, submit reviewable mutations to the reviewer and
  fail closed if review rejects or is unavailable.
- In `operate` / full-access mode, execute the same supported mutation directly.
- Never switch permission mode merely because review failed.
- Owner checks, stale-state protection, source containment, unsupported
  contribution blocks, and the native-install block apply in both modes.

## Hard safety rules

- Never convert a Claude skill package into a native plugin.
- Never use PluginManager uninstall for a Hana skill package.
- Never use skill-manager installation for a native plugin.
- Never use legacy release metadata to bypass the Studio-owner Settings
  signed plan/execute lifecycle for a native Marketplace package.
- Never bypass `plugin_marketplace` with shell commands, raw HTTP calls, or
  direct registry/activation edits.
- Never author a full activation-object replacement for an ordinary package
  toggle.
- Never silently discard unsupported executable contributions and install a
  partial subset.

## Load detail only when needed

- For source lifecycle, Claude package install, package gates, Agent routing,
  and uninstall, read
  [references/claude-skill-packages.md](references/claude-skill-packages.md).
- For native plugin inspection, local folder/ZIP management, current native
  Marketplace limits, or authoring handoff, read
  [references/native-hana-plugins.md](references/native-hana-plugins.md).
- For stale plans, permission denial, ambiguous destination, partial outcomes,
  or recovery, read
  [references/troubleshooting.md](references/troubleshooting.md).
