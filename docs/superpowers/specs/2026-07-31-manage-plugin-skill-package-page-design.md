# Manage Plugin Skill-Package Page

Date: 2026-07-31  
Status: Approved design; ready for implementation planning

## Summary

Marketplace-installed Hana skill packages gain a dedicated, per-package skill
management page from **Settings → Plugins → Manage Plugins**. Clicking a Hana
skill-package row such as **skillwiki** opens a Settings subpage with a
breadcrumb back to Manage Plugins, concise package state, a selected-Agent
selector, and individual skill enable/disable controls. The existing package
switch remains the separate global package-availability gate.

This replaces neither the general **Settings → Skills** view nor Plugin
Marketplace discovery/detail. It is the package-scoped shortcut for deciding
which skills from one installed package are available to one Agent.

## Goals

- Keep Manage Plugins compact while making installed skill packages actionable.
- Let a user reach exactly one package's skills with one click.
- Expose individual per-Agent preferences, including Enable all and Disable all.
- Clearly distinguish package-global availability from per-Agent preferences.
- Preserve preferences when a package, source, or individual skill is inactive.
- Reuse existing skill preference and marketplace activation behavior; create no
  second activation store.

## Non-goals

- Changing the global `marketplaceSkillPackages` activation model.
- Changing source enablement, package installation, or package uninstallation.
- Replacing the complete Skills page, its bundles, or its all-skill inventory.
- Adding package marketing artwork, recommendations, or a marketplace catalog.
- Allowing one-at-a-time deletion of marketplace-managed skills.

## Information architecture and navigation

### Manage Plugins entry

Each marketplace Hana skill-package row remains compact: name, version, Hana
skills badge, package status, source-qualified identity, skill count, and a
selected-Agent summary when available, for example:

    19 skills · Hanako: 16 enabled, 3 disabled

The row has a primary **Open skills** action. Clicking its non-action content
opens the page. Existing global package-toggle and package-uninstall controls
remain in the row. For marketplace skill packages, Open skills replaces the
generic **Manage in Skills** action.

- Open skills is a normal focusable button with an accessible package name.
- Nested action buttons preserve their own behavior and never cause navigation.
- Back returns to Manage Plugins without losing its loaded inventory state.

### Package skill page

The compact Settings subpage hierarchy is:

1. Breadcrumb: `Manage Plugins › {package name}`.
2. Header: package name, description, source-qualified identity, and optional
   **Open marketplace** link.
3. Package availability strip: global Enabled/Disabled state, short
   explanation, and existing owner-authorized package switch.
4. Package summary: installed count and enabled/disabled totals for the selected
   Agent.
5. **Skills**: Agent selector, Enable all / Disable all, then a compact list
   with descriptions and individual toggles.

It uses existing Settings typography, row rhythm, toggles, badges, and colors.
It is a Settings subpage—not a modal or a dashboard grid.

## State model and data flow

There are two independent state layers:

| Layer | Scope | Existing representation | Page behavior |
|---|---|---|---|
| Package availability | Marketplace-global | `activations.marketplaceSkillPackages[pluginId@marketplaceId]` | Header switch reads/writes this existing gate; missing record means enabled by default. |
| Skill preference | Individual Agent | Existing per-agent skill preference API/state | Individual and batch switches write only that Agent's preferences for skills in this package. |

Switches display the current effective skill state. When package availability is
off, or a marketplace source blocks the package, individual switches are
read-only with a concise explanation. Stored preferences remain unchanged and
resume when availability returns.

The selected Agent defaults to the Settings-selected Agent. Switching Agents
reloads or derives package membership against that Agent's inventory and
recalculates counts. With no selected Agent, show a clear empty state instead
of controls.

## Component boundaries

### Package-page navigation

Small Settings-local navigation state owns the source-qualified package identity
and return destination. It only accepts identities present in the installed
skill-package inventory. On stale or missing inventory, it returns to Manage
Plugins with a toast rather than rendering a broken page.

### Package membership resolver

A focused selector accepts an installed package row and an Agent's skills. It
returns only skills whose `marketplacePackage` provenance matches the package
identity, in the recorded package order where possible. It computes installed,
enabled, and disabled counts. It must not infer membership from display names
or source text.

### Package skill controls

A presentational list shows name, description, effective state, inactive reason,
and a skill toggle. It delegates individual and batch updates to the existing
skill-preference mutation path. Only the explicit global package switch calls
the marketplace activation API.

Batch actions target membership only, skip currently disabled controls, and
report partial failure without claiming success for unchanged skills.

## Permissions and failures

- Readers can view metadata/effective state but follow existing authorization for
  global and per-Agent writes.
- A globally disabled, source-blocked, partial, or stale package is explained
  prominently; it is never presented as a changed user preference.
- If a package is uninstalled while open, refresh returns to Manage Plugins with
  a concise “package is no longer installed” message.
- Global activation writes clone the complete owner snapshot and include expected
  registry revision/digest. The page never PUTs a bare activations object.

## Accessibility and responsive behavior

- Semantic buttons, accessible names, and visible keyboard focus are required.
- Existing toast/status behavior announces successful changes.
- Text—not color alone—communicates partial and unavailable state.
- At narrow widths, header actions wrap below the summary while each skill keeps
  its description and reachable switch.

## Testing and verification

Automated coverage must prove:

1. Manage Plugins opens the matching package page.
2. The page filters by provenance only; unrelated local, workspace, native, and
   other-marketplace skills are excluded.
3. Changing Agents recalculates list state and counts.
4. Individual and batch actions use the existing preference mutation path and
   affect only configurable package skills.
5. Global-disable/source-blocked state locks controls and preserves preferences.
6. Global package activation preserves sibling activation maps, revision, and
   digest.
7. Missing/stale inventory returns safely to Manage Plugins.

Run:

```bash
npx vitest run tests/plugin-marketplace-*.test.ts \
  tests/http-route-security.test.ts \
  tests/skill-manager.test.ts \
  tests/skills-route.test.ts \
  desktop/src/react/__tests__/settings/PluginMarketplaceTab.test.tsx \
  desktop/src/react/__tests__/settings/PluginsTab.test.tsx \
  desktop/src/react/settings/tabs/__tests__/SkillsTab.test.tsx
npm run typecheck
git diff --check
SKIP_NOTARIZE=true npm run install:local
codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
cat /Applications/HanaAgent.app/Contents/Resources/build-info.json
```

Manual desktop smoke: install a skill package, open its page, change one skill
for one Agent, Enable all, Disable all, switch Agent, disable/re-enable global
availability and verify preference retention, then uninstall and verify safe
return.

## Acceptance criteria

- One installed marketplace skill package opens from Manage Plugins into a
  dedicated Settings page that manages exactly that package's skills.
- Package-global and per-Agent controls are visually distinct and independent.
- Batch actions never affect skills outside the package or non-configurable
  skills.
- Disabled package/source state cannot erase or overwrite individual preferences.
- Manage Plugins remains compact and the standalone Skills page continues to
  work unchanged.
