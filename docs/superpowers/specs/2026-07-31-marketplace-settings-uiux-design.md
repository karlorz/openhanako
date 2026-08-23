# Marketplace Settings UI/UX Refresh

Date: 2026-07-31
Status: Approved design; ready for implementation planning

## Summary

Refresh the Plugins and Plugin Marketplace settings pages so that they feel like
one coherent Hana desktop experience while preserving the existing marketplace
and plugin behavior. The design stays compact like the current settings
screens, separates installed-state management from discovery, and makes the
global skill-package gate understandable without hiding useful actions.

The primary new interaction is Add Source: a centered desktop-style dialog with
one source text field. Hana detects whether the entry is an HTTPS catalog, a
Git repository, or a server-local path, shows a small inferred preview, and
leaves final validation and ownership decisions to the server.

This document describes the approved product behavior and visual direction. It
does not implement product code.

## Context and problem

The current Manage Plugins page combines native plugins, marketplace sources,
skill packages, permissions, and diagnostics in a visually flat stream. That
makes several different kinds of state look interchangeable:

- A native runtime plugin is not the same thing as a marketplace source.
- A Hana skill package is not a native PluginManager plugin.
- A package’s global availability is not the same as an individual Agent’s
  skill preference.
- A source can be disabled while its installed package records and per-Agent
  preferences remain preserved.

The current UI also exposes too much infrastructure detail too early, uses
whole-row dimming for disabled packages, and makes source entry feel like a
form rather than a short command. The existing Plugin Marketplace browse and
detail experience contains useful capabilities and must remain available, but
it should share the same state language and visual hierarchy as Manage Plugins.

## Goals

1. Make the Plugins page immediately explain what is installed, what is
   available, and what is disabled.
2. Keep the page compact and familiar to the current Hana desktop settings
   surface.
3. Provide a fast, low-friction Add Source workflow with one editable field.
4. Keep marketplace source management visible without turning the page into a
   server dashboard.
5. Preserve the existing Plugin Marketplace browse/detail flow and integrate
   its source, package, and access states with the redesigned presentation.
6. Make global package gating, per-Agent preferences, and effective
   availability explicit and non-destructive.
7. Preserve current server-authoritative validation, ownership, revision, and
   digest behavior.
8. Improve keyboard access, focus visibility, contrast, responsive behavior,
   and translation readiness.

## Non-goals

- Changing marketplace source API contracts or server ownership rules unless a
  small compatibility adapter is required for the single source input.
- Moving Claude marketplace packages into the native PluginManager namespace.
- Replacing the existing Plugin Marketplace catalog, package detail, install,
  or access-review capabilities.
- Changing the semantics of full-access permissions, native plugin lifecycle,
  or Agent skill preferences.
- Adding a second settings system or a new dashboard-style overview.
- Automatically deleting installed packages or their Agent preferences when a
  source or package is disabled.

## Approved information architecture

The settings navigation label remains Plugins. Within the page, content is
ordered by the user’s most likely management tasks:

1. Marketplace sources
2. Manage Plugins and install dropzone
3. Native plugins
4. Hana skill packages
5. Permissions
6. Diagnostics, collapsed by default

The page remains a compact settings page rather than a card-heavy dashboard.
Sections use short headings, compact rows, and restrained badges. A section may
use a bordered group when it contains multiple rows, but the page should not
introduce large summary tiles or a permanent multi-column control panel.

### Marketplace sources

Marketplace sources are displayed as inline rows near the top of Plugins. Each
row shows:

- Display name and source kind.
- Health and enabled state.
- Package count when known.
- A shortened URL, repository, or local path with wrapping at narrow widths.
- Compact actions: Refresh, Enable or Disable, and Remove.

Add source is a compact button aligned with the section heading. It opens the
Add Marketplace Source dialog; there is no always-visible inline source form.
Refresh all remains an icon action only when its tooltip and accessible label
make the action clear.

### Marketplace source section-card correction

The Plugin Marketplace page uses the same source-management component as the
Plugins page, but embeds it below the Marketplace summary. Its source list must
remain a coherent compact section rather than appearing as a floating heading,
edge-aligned actions, and a table-like first row.

For both settings pages, the approved presentation is:

- A single compact header row: the section label on the left, with Add source
  and Refresh all grouped on the right and aligned to the source list.
- One subtle bordered, rounded source-list surface directly below that header.
  The surface contains only source rows and uses one-pixel dividers between
  them; the first official source receives no special gray-band treatment.
- Each row keeps the existing compact hierarchy: source name plus authority,
  health, enabled state, and package count; identifier and source kind; then a
  shortened location/ref/index-path line with its full value available through
  the existing tooltip.
- Mutable custom-source actions remain right-aligned within their row.
  Official and server-owned sources remain action-free.

This is a visual hierarchy correction only. It does not alter source APIs,
loading, add/refresh/enable/remove behavior, access checks, or marketplace
catalog state. At narrow widths, the header controls may wrap without clipping
the location or row actions.

Source rows support these user-facing states:

- Healthy / Enabled
- Healthy / Disabled
- Stale / Enabled
- Error
- Removed or unavailable

The row should explain the consequence of a disabled or stale source in one
short line. Technical revision, digest, and server details belong in a
technical disclosure or detail surface, not in the primary row.

### Manage Plugins, native plugins, and skill packages

The existing install dropzone remains in Manage Plugins. It continues to
accept a plugin folder or ZIP and must not change the behavior of native
HyperFrames or the existing dropzone.

Native plugins and Hana skill packages are rendered as separate groups:

- Native plugins retain their current lifecycle vocabulary: Loaded, Failed,
  Disabled, or Restricted.
- Hana skill packages carry a Hana skills badge and source-qualified identity.
  They are managed through marketplace skill-package actions rather than the
  native PluginManager uninstall endpoint.

The skill package row has a clear package identity, package version, source,
skill count, and compact summary. The complete skill-name list is not rendered
as an undifferentiated paragraph in the primary row. A Manage in Skills action
opens the existing skill settings view, and technical/package details can be
revealed without making the row taller by default.

### Permissions and diagnostics

Permissions remain below installed items. Their current meaning and controls
do not change.

Diagnostics are collapsed by default. A user who needs revisions, identifiers,
or raw server status can expand the section. Diagnostics must not compete
visually with source health, package availability, or the primary actions.

### Marketplace browse and detail

Plugin Marketplace remains a separate discovery and review surface. Its
relationship to Plugins is explicit:

- Plugins answers: what is installed, what source is configured, and what is
  currently enabled?
- Plugin Marketplace answers: what can be discovered, inspected, and
  installed?

The Marketplace page keeps its existing catalog and selected-package detail
capabilities, but adopts the same compact Hana styling, status badges, source
language, and access-state labels. It should use progressive disclosure:
high-value package identity, compatibility, install state, and primary action
come first; permissions, README content, contribution types, and technical
metadata remain available below or in a disclosure.

## Approved Add Marketplace Source flow

Clicking Add source opens a centered Hana desktop modal. The dialog is
intentionally small and contains one editable entry field.

### Dialog content

Title:

    Add Marketplace Source

Field label:

    Source

Help text:

    Paste a marketplace URL, Git repository, or server-local path. Hana detects
    the source type automatically.

Examples:

    https://example.com/marketplace.json
    https://github.com/org/catalog.git
    /path/to/marketplace

The examples are instructional content, not additional fields. The dialog
does not normally ask for source ID, display name, Git ref, catalog path, or
index path. Those values are inferred or validated by the server. An Advanced
disclosure may be added later only if real source types require an override;
it is not part of the initial implementation.

Actions:

- Cancel
- Add source

The source field receives focus when the dialog opens. Enter submits when the
value is non-empty and not currently submitting. Escape cancels and closes the
dialog. Clicking outside follows the existing Hana modal convention and must
not silently discard an in-progress submission.

### Detection preview

After the user enters a value, the dialog shows a compact inferred preview
when the entry can be classified:

- Detected type: HTTPS catalog, Git repository, or local path.
- Inferred source name or ID when available.
- Git ref and catalog/index path when the server or client can safely infer
  them.
- Package count only after a successful server-side inspection.

The preview is advisory. The server remains authoritative for parsing,
authentication policy, path containment, ownership, revision, digest, and
whether the source can be added.

### Validation and submission

The client submits the single source string through the existing validated
server path. It must not create a second client-only source model that can
disagree with the server.

Inline errors state:

1. What was rejected.
2. Why it was rejected in user language.
3. What the user can try next.

Examples of actionable outcomes include:

- Invalid or unsupported URL/repository/path: ask for a public HTTPS catalog,
  public HTTPS Git repository, or permitted server-local path.
- Unauthorized local path: explain that the path must be accessible to the
  server and within its allowed root.
- Duplicate source: offer the existing source row rather than creating a
  duplicate.
- Owner or permission denial: explain that the current Agent or owner cannot
  perform the action.
- Server unavailable or degraded: keep the entry in the dialog, identify that
  the server could not validate it, and allow retry or cancel.
- Stale revision or digest conflict: refresh source state and explain that the
  catalog changed before the action completed.

On success, the dialog closes and the source list, package counts, catalog
state, and relevant revision information refresh. On failure, the dialog stays
open with the entry preserved.

## Approved package and source state semantics

The UI must distinguish three layers of skill state:

1. Global package gate: whether the installed marketplace skill package is
   enabled for the product.
2. Per-Agent preference: whether the selected Agent has requested an individual
   skill.
3. Effective availability: whether the skill can currently be used after
   applying package, source, Agent, and runtime state.

### Disabled package presentation

Disabling a marketplace skill package disables the package as a unit. It does
not remove the installed package, delete skills, or erase Agent preferences.
The row must not be rendered as a disabled-looking dead block.

The package row should communicate state in this order:

    skillwiki  v0.10.22  Hana skills
    skillwiki@llm-wiki  ·  19 skills
    Disabled globally
    Agent preferences preserved
    Unavailable until package is enabled

Manage in Skills and Remove remain usable while the package is globally
disabled. Only the package enable/disable control is off. The status badge and
explanatory copy are muted but retain readable contrast.

When the package is enabled, the package row says that skills are available,
and the effective skill state is determined by the selected Agent’s
preference. If the source is disabled or unavailable, the package remains
installed and preferences remain preserved, but the effective state says that
the source is unavailable until it is restored.

The Skills settings view uses the same language. For a skill whose package is
globally disabled, it shows:

    Package: Disabled globally
    Hanako preference: On, preserved
    Effective: Unavailable

For a usable skill, it shows the Agent preference and effective availability
without implying that the package gate is an individual skill toggle.

### Source disablement

Disabling a marketplace source stops browsing, refresh, and update operations
for that source. Existing marketplace skill packages from that source become
unavailable at runtime while their package records and per-Agent preferences
are preserved. Re-enabling a healthy source restores availability.

This behavior is represented as a source-blocked or unavailable effective
state, not as package deletion. The UI must not suggest that the user needs to
reinstall a package merely because its source is temporarily disabled.

### Native plugin semantics

Native plugin state remains independent from marketplace source and skill
package state. Native controls continue to use the existing lifecycle APIs and
state labels. No native plugin is shown as a Hana skill package, and no skill
package is removed through the native PluginManager endpoint.

## Visual direction and interaction details

The visual direction is compact desktop Hana:

- Quiet beige settings surface from the current screenshots.
- Existing settings column width and navigation remain.
- Compact section headings and bordered row groups.
- Blue for primary actions and active controls.
- Green for healthy or loaded state.
- Amber for stale, partial, or attention-needed state.
- Red reserved for errors and destructive actions.

Buttons should use a consistent compact height and spacing. Text labels are
preferred for destructive actions: Remove source, Remove package, and
uninstall should remain explicit. Icon-only actions are appropriate for
non-destructive utilities such as refresh when they have an accessible name
and tooltip.

Disabled package rows must not use whole-row opacity. Use a muted status badge,
secondary explanatory copy, and a visibly off package toggle while leaving
Manage in Skills and removal actions readable and operable.

## Marketplace integration

The existing browse Marketplace card and page are retained. The redesign
integrates them through shared presentation rules:

- Source names and source-qualified package IDs use the same formatting in
  Plugins and Marketplace.
- Installed, enabled, disabled, source-blocked, and unavailable states use the
  same status vocabulary.
- A package detail view shows whether the package is installed, globally
  enabled, source-available, and enabled for the selected Agent.
- The primary action changes by state: install, enable package, restore source,
  manage in Skills, or inspect-only when the current owner lacks permission.
- Permission and full-access review remains visible, but is secondary to
  package identity, compatibility, and the primary action.
- README, contribution types, and technical metadata remain available through
  progressive disclosure rather than occupying the top of the detail view.

Marketplace source counts and package counts are shown only when current.
Stale or unavailable counts must be labeled so they are not mistaken for
verified live inventory.

## Component and data-flow boundaries

The implementation should preserve the existing server model and use these
presentation boundaries:

- PluginsTab: installed-page layout, section ordering, and refresh
  coordination.
- MarketplaceSourcesPanel: source rows, health states, source actions, and
  refresh behavior.
- AddMarketplaceSourceDialog: one input, help examples, type detection
  preview, focus/keyboard behavior, validation, and submission.
- PluginMarketplaceTab: catalog, package detail, discovery actions, and
  access-review presentation.
- Shared presentation primitives: status badge, compact action group, package
  type badge, source health badge, and technical-details disclosure.

The expected flow is:

1. Load server-owned marketplace sources.
2. Load installed marketplace skill-package inventory.
3. Load catalog/package/access state needed by the Marketplace page.
4. Let Add Marketplace Source accept one source string.
5. Show client-side advisory detection only where it is safe.
6. Submit to the server for final validation and ownership checks.
7. Refresh source rows, package counts, catalog state, and revision/digest
   information after success.
8. Preserve the existing full activations snapshot/PUT behavior. A toggle
   must clone the current owner snapshot and refuse to mutate when the snapshot
   is missing.
9. Keep native plugin lifecycle APIs and marketplace skill-package lifecycle
   APIs separate.

If the existing client endpoint needs a broader input shape to support the
single source string, add a narrow normalized input adapter while preserving
the server’s validated contract and response semantics.

## Accessibility, responsive behavior, and localization

The implementation must include:

- Accessible names and pressed state for all toggles.
- A clear disabled reason for a globally disabled package.
- Modal focus trap, initial focus, Enter submission, Escape cancellation, and
  an accessible validation error announcement.
- A keyboard-accessible install dropzone using Enter and Space, with its
  accepted file types stated in accessible text.
- Visible focus rings for buttons, toggles, links, rows, and dialog controls.
- Contrast that remains readable for muted status and explanatory text.
- No hover-only way to discover a required action.
- Wrapped URLs, repository names, and local paths at narrow widths.
- Source-row action wrapping without clipping or horizontal overflow.
- A modal that remains usable when the settings column is narrow.
- Marketplace detail content that stacks progressively instead of forcing a
  dense fixed-width two-column layout.
- Translation-backed strings for all new visible text, including status,
  examples, error messages, tooltips, accessible labels, and help text.

## Error and recovery model

The UI should provide a stable next action for each failure class:

| Failure | User-facing meaning | Next action |
| --- | --- | --- |
| Invalid source | The entry cannot be recognized or is unsupported | Edit source |
| Unauthorized path or repository | The server cannot access or is not allowed to use it | Choose an allowed source |
| Duplicate source | The source is already configured | Open existing source row |
| Owner/permission denial | The current user or Agent cannot perform the action | Review access or switch owner |
| Server unavailable/degraded | Validation could not complete | Retry without losing entry |
| Stale revision/digest | Source changed during the action | Refresh and retry |
| Refresh failure | Existing source could not be refreshed | Retry or inspect source details |
| Source disabled/removed | Installed package source is unavailable | Enable/restore source |
| Partial or stale package state | Inventory and catalog disagree temporarily | Refresh; do not silently delete |

Errors must not silently reset toggles, delete package records, or clear
per-Agent preferences.

## Verification and acceptance criteria

### Plugins page

- Sections appear in the approved order.
- Native plugins and Hana skill packages are visually and semantically
  distinct.
- The install dropzone still accepts the same plugin folder/ZIP flows.
- Package rows remain readable when globally disabled.
- Manage in Skills and package removal remain available while the package gate
  is off.
- Source rows render all approved health/enabled states with correct actions.
- Technical identifiers are available without dominating the compact row.

### Add Source dialog

- Add source opens a centered Hana desktop dialog.
- There is exactly one editable source entry in the normal flow.
- The source field auto-focuses.
- HTTPS catalog, Git, and local-path examples are visible.
- Enter submits, Escape cancels, and focus returns sensibly after close.
- Detection preview is advisory and never bypasses server validation.
- Invalid, duplicate, unauthorized, denied, degraded, and stale outcomes
  preserve the user’s entry and provide a next action.
- Successful submission closes the dialog and refreshes affected data.

### Marketplace page

- Existing browse and detail capabilities remain available.
- Installed, disabled, source-blocked, unavailable, and inspect-only states
  use shared vocabulary with Plugins.
- The primary package action is obvious for each state.
- README, permissions, contribution types, and technical details remain
  discoverable through progressive disclosure.
- Counts and revision-dependent details identify stale or unavailable data.

### Accessibility and regression

- Keyboard-only operation covers source management, package controls, the
  dialog, dropzone, and Marketplace actions.
- Screen-reader labels explain toggle purpose and disabled reasons.
- Focus is visible and modal focus does not escape.
- Narrow settings widths do not clip actions or paths.
- New strings are translation-backed.
- Existing native HyperFrames and dropzone behavior is unchanged.

### Automated and manual checks

The focused marketplace and settings test suites should cover source rows,
package gating, Marketplace rendering, dialog submission, keyboard behavior,
and error states. Run the repository’s required marketplace verification,
typecheck, and diff checks, followed by local app installation and manual
smoke:

1. Add a source.
2. Browse a native plugin and a Hana skill package.
3. Disable and re-enable the package.
4. Confirm the Skills view preserves Agent preferences and reports effective
   availability.
5. Disable and re-enable the source.
6. Uninstall the package through the marketplace package path.
7. Confirm native HyperFrames and the existing dropzone are unchanged.

## Scope and rollout

The first implementation pass covers the Plugins page grouping and state
language, inline marketplace source rows, the one-field Add Source dialog,
shared compact presentation primitives, and the retained Marketplace browse
and detail integration.

The first pass does not add Advanced source overrides, a new server source
model, or a new diagnostics dashboard. If implementation discovers that an
existing endpoint cannot express the single source input while preserving
server authority, the smallest compatible adapter should be proposed in the
implementation plan before code changes are made.

The implementation plan should map each acceptance criterion to the relevant
component and test, identify any API adapter precisely, and preserve unrelated
working-tree changes.
