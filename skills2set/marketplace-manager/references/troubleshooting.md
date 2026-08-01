# Marketplace troubleshooting

Diagnose from the latest `plugin_marketplace` inspection. Do not repair state
through raw registry edits, shell copies, or undocumented HTTP calls.

## Common recovery paths

- **Destination or adapter missing:** stop. Refresh the source/catalog and
  inspect again. Never infer the installer from package contents.
- **Stale revision, digest, or plan token:** discard the old plan, reload the
  current state, and create a fresh plan.
- **Autoreview denial:** report the proposed mutation and denial. Keep the
  current permission mode; do not retry by switching to full access.
- **Full-access failure:** diagnose the returned owner, validation, source,
  plan, or tool error. Full access does not guarantee a valid operation.
- **Unsupported contributions:** report each unsupported or blocked component.
  Do not silently install only the safe-looking files.
- **Partial installation or uninstall:** list what succeeded, failed, or
  remains. Re-inspect inventory before suggesting the next action.
- **Toggle mismatch:** identify whether the user means the Marketplace source,
  global package gate, one Agent Skill Toggle, or native PluginManager runtime.
- **Uninstall mismatch:** confirm owner, destination, adapter, and exact
  `pluginId@marketplaceId` identity before removing anything.
- **Desired but not installed:** install the exact supported Hana skill package
  first; activation records do not create an artifact.
- **Client/server path confusion:** use a server-authorized local path or a
  supported URL/Git source. A desktop-local path is not automatically visible
  to the connected server.

After recovery, verify the source status, installed inventory, package gate,
and relevant Agent skill state. Claim success only for state confirmed by the
server.
