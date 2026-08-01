# Claude-compatible Hana skill packages

Use this workflow only after inspection reports destination `hana-skills` and
adapter `skill-manager`.

## Source and package lifecycle

1. Call `plugin_marketplace` to inspect server capabilities and list the
   server-owned Marketplace sources.
2. For source changes, use the supported actions: `list_sources`, `add_source`,
   `refresh_source`, `set_source_enabled`, and `remove_source`.
3. Browse and inspect packages with `list_catalog` and `inspect_package`.
   Preserve the exact identity `pluginId@marketplaceId`.
4. Review destination, adapter, installability, contribution inventory,
   warnings, current registry revision/digest, and installed state.
5. Prepare installation with `plan_install`. Execute `install` only with the
   current deterministic plan token and required confirmation.
6. Re-inspect the package and installed inventory after installation.

Do not install if the package is incomplete, outside the source root, contains
unsupported executable behavior, or no longer matches the inspected revision.
Generate a fresh plan when state changes.

## Package enable and Agent routing

Installed packages appear in Settings → Plugins → Manage Plugins with a Hana
skills badge, but SkillManager still owns them.

- `list_installed_packages` returns installed source-qualified packages and
  their package activation state.
- `set_package_enabled` controls the global package gate. A missing activation
  record means enabled by default.
- Disabling the package makes its skills inactive for every Agent without
  erasing per-Agent preferences.
- Agent Skill Toggles control one skill for one Agent. Use those settings for a
  single-skill or single-Agent request, not the global package gate.

For example, "disable all skills in skillwiki@llm-wiki" is a package-gate
operation. "Disable wiki-query for Hanako" is a per-Agent skill preference.

## Uninstall

1. Inspect installed inventory and confirm the exact source-qualified identity.
2. Prepare removal with `plan_uninstall`.
3. Execute `uninstall` only with the fresh plan token, registry revision, and
   digest required by the tool.
4. Verify that recorded skill directories were removed, skills reloaded, and
   installed inventory updated.
5. Report partial cleanup explicitly, including retained or failed paths.

Package removal uses the Marketplace Hana-skill lifecycle corresponding to
`DELETE /api/plugins/marketplace/:id/skills`. It never calls
`PluginManager.removePlugin()`.

## Permission behavior

In autoreview, let the automatic reviewer decide reviewable mutations and
report denial without changing modes. In full access, execute the same tool
actions directly. Neither mode bypasses owner checks, stale tokens, source
containment, or unsupported-component restrictions.
