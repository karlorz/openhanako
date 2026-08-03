# Marketplace Source Reload Loop Design

**Date:** 2026-08-03

## Problem

When the desktop marketplace page is connected to the remote Hana server, the **Marketplace sources** controls repeatedly enter and leave their loading state. The catalog detail pane can also refresh while the user is trying to install the HyperFrames native plugin.

The remote server is not the cause of this incident: `sg01` is running `v0.421.24-karlorz.5`, advertises `nativeMarketplaceSettingsLifecycle`, reports Studio-owner access, and reports HyperFrames as installable through the Settings lifecycle.

## Root Cause

`PluginMarketplaceTab` passes an inline `onSourcesChanged` callback to `MarketplaceSourcesPanel`:

```tsx
onSourcesChanged={() => {
  window.setTimeout(() => { void loadMarketplace({ silent: true }); }, 100);
}}
```

`MarketplaceSourcesPanel` includes that callback in the `loadSources` callback dependency list. It also invokes the callback from every successful `loadSources` call, including the initial load. The resulting cycle is:

1. The source panel loads `/api/plugins/marketplace/sources`.
2. The panel invokes `onSourcesChanged`.
3. The marketplace tab reloads its catalog and re-renders.
4. The inline callback gets a new identity.
5. The panel's `loadSources` callback and effect get new identities and load sources again.

This coupling is especially visible over a remote connection because the request latency makes each loading transition observable.

## Approved Design

Keep source-list ownership inside `MarketplaceSourcesPanel`, but separate **reading sources** from **notifying the parent that a source mutation changed the catalog**.

- `loadSources` performs only source-list state updates and returns the registry snapshot.
- The initial source load and the explicit “Reload source list” action do not notify the parent marketplace tab.
- After a successful add, remove, enable/disable, or source refresh, the panel reloads its source list and then invokes the existing `onSourcesChanged` callback once.
- The source-loading effect no longer depends on the parent callback. A parent re-render or callback identity change cannot restart the initial source fetch.
- Existing registry revision/digest preconditions, stale-retry behavior, owner gates, error mapping, and toast behavior remain unchanged.
- The public prop name remains `onSourcesChanged` to avoid an unnecessary API rename; its documented meaning becomes “called after a successful source mutation and subsequent list refresh.”

### Data flow after the change

```text
initial mount / manual reload
  -> loadSources()
  -> update panel only

successful source mutation
  -> mutation request with registry preconditions
  -> loadSources()
  -> onSourcesChanged(updatedSources)
  -> parent reloads catalog once
```

## Testing Strategy

Add regression coverage to `desktop/src/react/__tests__/settings/MarketplaceSourcesPanel.test.tsx`:

1. Rendering with a parent callback and then re-rendering with a new callback identity must not trigger another automatic source fetch.
2. A successful source mutation must still call the latest parent callback after the refreshed source list is loaded.

Keep the existing source-action tests for revision/digest propagation and stale retry. Run the focused marketplace UI suite and the repository-required marketplace/typecheck/diff checks after implementation.

## Non-goals

- No server route or authorization changes.
- No change to native HyperFrames plan/execute lifecycle.
- No change to catalog payloads, registry preconditions, or install confirmation behavior.
- No deployment, remote configuration change, push, or branch history rewrite.
