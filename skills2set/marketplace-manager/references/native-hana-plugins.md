# Native Hana plugins

Use this reference when inspection reports destination `native-plugin` and
adapter `plugin-manager`, or when the user asks about a local native plugin.

## Native ownership

PluginManager owns native application plugins, including their runtime slot,
trust, enable/disable state, load/unload behavior, diagnostics, and uninstall.
Native plugins may contain tools, commands, routes, providers, lifecycle code,
UI, and plugin-owned `skills/<name>/SKILL.md` directories.

The `restricted` and `full-access` trust model belongs to this lane. A skill
package managed by SkillManager does not gain native trust or runtime behavior
because it appears on the Manage Plugins page.

## Local installation and management

Use Settings → Plugins for native folder/ZIP/dropzone installation. The local
Plugin Dev Loop uses `plugin.dev.install`, reload, enable, disable, reset,
uninstall, diagnostics, tool smoke tests, and surface inspection against the
remembered development slot under `${HANA_HOME}/plugins-dev/`.

Do not use the Claude Marketplace skill-package installer for these packages.

## Marketplace boundary

Under the current durable multi-source/Agent contract, native Marketplace
packages are inspectable but native installation is preview-only/deferred for
Agent-driven operations. Explain the destination, capabilities, trust, and
warnings, then stop. Do not invent a raw HTTP, shell, archive-copy, or
PluginManager mutation path.

A legacy single-catalog compatibility path may still describe native release
ZIP download, sha256 verification, retained artifacts, backups, and the bare
runtime `pluginId` slot. Treat that as compatibility behavior, not permission
to bypass the current multi-source/Agent native-install block.

## Authoring and publication

Hand off plugin creation, SDK design, scaffolding, local dev-loop operation,
validation, packaging, and OH-Plugins native publication to
`hana-plugin-creator`. Keep existing Marketplace source/package management in
`marketplace-manager`.
