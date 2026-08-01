# Hana Agent Marketplace Lifecycle Design

Date: 2026-08-01

Status: Approved design; implementation pending

## Summary

Complete the Agent-facing lifecycle for Claude-compatible Marketplace sources
and Hana skill packages through the existing `plugin_marketplace` tool. The
Agent must be able to inspect and manage mutable Marketplace sources, install
supported Claude Marketplace packages as Hana skills, enable or disable an
installed package without erasing per-skill preferences, and uninstall the
exact source-qualified package.

The Agent and Settings UI must remain adapters over the same server-owned
Marketplace service and persistence model. Agent mutations use high-level,
transaction-safe actions; the language model never constructs arbitrary HTTP
requests or replaces the complete activation object merely to toggle one
package.

Native Marketplace plugin installation remains intentionally deferred. The
Agent may inspect native packages, but installation continues to fail with
`PLUGIN_MARKETPLACE_NATIVE_INSTALL_NOT_AGENT_ENABLED` until the upstream or
fork PluginManager contract audit provides an approved implementation.

## Goals

- Expose the complete mutable-source lifecycle to Hana Agent chat.
- Expose installed Hana-skill package inventory to Hana Agent chat.
- Add safe, explicit package enable and disable operations.
- Add stale-protected planning and execution for exact package uninstall.
- Preserve source-qualified identity, owner authorization, registry
  preconditions, and existing skill-manager semantics.
- Verify the real Agent tool path in both Hana `auto` (autoreview) and
  `operate` (full session access) permission modes.
- Run live tests against disposable Claude Marketplace fixtures and leave the
  user's pre-existing Marketplace, SkillWiki, Agent preference, and native
  PluginManager state unchanged.

## Non-goals

- Agent installation of native PluginManager packages.
- Agent enable, disable, configure, or removal of native PluginManager
  packages through `plugin_marketplace`.
- Private Git credentials, SSH Marketplace URLs, credential-bearing URLs, or
  arbitrary desktop-local paths.
- A generic Agent HTTP proxy for Marketplace endpoints.
- A second Marketplace registry or Agent-only persistence format.
- Replacing the existing Settings UI or HTTP API.

## Current State

The existing Agent tool supports Marketplace inspection, install planning,
supported Claude package installation, low-level activation replacement, and
Claude compatibility binding operations. It does not expose ordinary source
mutation, installed-package inventory, high-level package toggles, or package
uninstall.

The desktop UI and HTTP routes already implement those lifecycle operations.
Their contracts include source-qualified identities, owner checks,
revision/digest preconditions, complete activation snapshot replacement,
skill-package uninstall, Agent-reference cleanup, and native-plugin isolation.

The implementation must reuse these contracts rather than reproduce them in
model-authored payloads.

## Agent Action Contract

The existing `plugin_marketplace` tool remains the single Agent-facing
Marketplace boundary.

### Read and planning actions

- `list_sources`
- `list_catalog`
- `inspect_package`
- `diagnose_config`
- `list_installed_packages`
- `list_compat_bindings`
- `plan_install`
- `plan_uninstall`
- `plan_compat_mutation`

### Mutable source actions

- `add_source`
- `refresh_source`
- `set_source_enabled`
- `remove_source`

### Hana skill-package actions

- `install`
- `set_package_enabled`
- `uninstall`

### Existing compatibility actions

- `set_activations`
- `execute_compat_mutation`
- `validate_compat_bridge`

`set_activations` remains for compatibility and advanced control-plane use,
but normal package enable and disable prompts must use
`set_package_enabled`.

## Architecture

The Agent tool and HTTP routes are adapters over `PluginMarketplaceService`.
The tool must not directly edit files, registry JSON, Agent YAML, skill
directories, or PluginManager state.

When lifecycle logic currently exists only inside an HTTP route, expose or
move the domain operation into the Marketplace service or a focused shared
domain helper. Both adapters then invoke the same operation and receive the
same result and stable error codes.

```text
Settings or Marketplace UI
  -> HTTP route
     -> shared Marketplace domain operation
        -> registry / skill manager / installation record

Hana Agent chat
  -> plugin_marketplace tool
     -> shared Marketplace domain operation
        -> registry / skill manager / installation record
```

No new persistence file is introduced.

## Identity Rules

Package mutations require both `pluginId` and `marketplaceId`. The effective
identity is always `pluginId@marketplaceId`.

Read-only resolution may report that an unqualified ID is unique or ambiguous,
but install, package toggle, uninstall planning, and uninstall execution must
use an exact source-qualified identity.

Source mutations require the exact `marketplaceId` after source creation.
Compiled official, legacy, or immutable sources remain non-mutable.

## Source Actions

### Add source

Input:

```ts
{
  action: "add_source";
  source: string;
  marketplaceId?: string;
  gitRef?: string;
  indexPath?: string;
  expectedRevision: number;
  expectedDigest: string;
}
```

The operation uses the same source parser and authorization rules as the
Settings Add Source dialog. Accepted forms remain public HTTPS catalog, public
HTTPS Git, and authorized server-local paths. Private credentials, SSH URLs,
credential-bearing URLs, and paths outside the configured server-local root
fail closed.

### Refresh source

Input includes `marketplaceId`, `expectedRevision`, and `expectedDigest`.
Refresh preserves source identity and updates only its resolved catalog
snapshot and diagnostics.

### Set source enabled

Input includes `marketplaceId`, `enabled`, `expectedRevision`, and
`expectedDigest`. The operation preserves installed artifacts and
source-qualified records. Compiled official and immutable sources cannot be
disabled.

### Remove source

Input includes `marketplaceId`, `expectedRevision`, and `expectedDigest`.
Removal fails while the source has installed packages or activation/access
references. It never cascades into package uninstall.

## Installed Package Inventory

`list_installed_packages` returns the same server projection consumed by
Manage Plugins. Each row includes:

- `pluginId`
- `marketplaceId`
- composite identity
- installed, partial, or stale state
- recorded skill names
- effective package activation state
- source status
- mutation availability
- registry revision and digest

Owners receive the information required for safe mutations. Non-owner callers
may read inventory but cannot receive mutation authority merely from the tool
result.

## Package Enable and Disable

`set_package_enabled` accepts only the intended field change:

```ts
{
  action: "set_package_enabled";
  pluginId: string;
  marketplaceId: string;
  enabled: boolean;
  expectedRevision: number;
  expectedDigest: string;
}
```

The domain operation reads and clones the authoritative current activation
object, changes only
`marketplaceSkillPackages[pluginId@marketplaceId]`, and writes the complete
object with optimistic preconditions.

It preserves all unrelated records, including:

- other `marketplaceSkillPackages` entries
- `marketplaceSkills`
- `runtimePlugins`
- `agentSkillOverrides`
- `agentPluginAccess`

Turning a package off makes its skills runtime-inactive for every Agent but
does not erase per-Agent preferences. Turning it back on restores runtime
availability according to those preserved preferences.

## Install Planning and Execution

`plan_install` remains mandatory. Its token is derived from the exact package
facts, including identity, version, source revision, trust, contributions,
distribution/install descriptor, destination, adapter, warnings, and install
plan.

`install` requires that token. A changed fact produces
`PLUGIN_MARKETPLACE_PLAN_STALE` and no mutation.

Only supported Claude-compatible packages whose destination is `hana-skills`
and adapter is `skill-manager` may install. After a successful install, Hana
reloads skills on a best-effort basis and returns the exact installed skills
and resolved revision.

Native packages remain inspectable but non-installable through the Agent.

## Uninstall Planning and Execution

`plan_uninstall` resolves the exact installed package and returns:

- exact identity
- installed state
- recorded skills
- expected skill directories
- activation records expected to be cleaned
- Agent package references expected to be cleaned
- current source and registry revision/digest
- an uninstall plan token

The token is derived from those uninstall facts. `uninstall` requires the
token plus current revision and digest. Changed installation or registry facts
produce a stale-plan or stale-registry result without mutation.

Execution delegates to the existing exact Claude skill-package uninstall
operation. It never calls native `PluginManager.removePlugin()`.

Partial filesystem cleanup returns a typed partial result and preserves the
remaining installation record. The tool must not report full success when any
recorded skill remains unresolved.

## Permission Model

User terminology maps to Hana's canonical session modes:

```text
autoreview  -> auto
full access -> operate
```

Read and planning actions declare `plugin_marketplace.read` and run without a
mutation prompt.

Source changes and package enable/disable declare
`plugin_marketplace.configure`. Install declares
`plugin_marketplace.install`. Uninstall declares
`plugin_marketplace.uninstall`.

In `auto`, mutation invocations enter the automatic reviewer. If the reviewer
rejects or is unavailable, the operation fails closed and does not fall back
to unattended human approval.

In `operate`, reviewable mutations may execute directly. The mode does not
bypass server-owner checks, hard policy, source immutability, registry
preconditions, package classification, plan tokens, path containment, or
native-plugin restrictions.

## Stable Errors

The Agent result preserves existing codes and adds focused codes where
required:

- `PLUGIN_MARKETPLACE_OWNER_REQUIRED`
- `PLUGIN_MARKETPLACE_PLAN_TOKEN_REQUIRED`
- `PLUGIN_MARKETPLACE_PLAN_STALE`
- `PLUGIN_MARKETPLACE_REGISTRY_STALE`
- `PLUGIN_MARKETPLACE_SOURCE_IMMUTABLE`
- `PLUGIN_MARKETPLACE_SOURCE_IN_USE`
- `PLUGIN_MARKETPLACE_PACKAGE_NOT_INSTALLED`
- `PLUGIN_MARKETPLACE_PACKAGE_PARTIAL`
- `PLUGIN_MARKETPLACE_NATIVE_INSTALL_NOT_AGENT_ENABLED`
- `PLUGIN_MARKETPLACE_UNSUPPORTED`

Results include concise remediation without secrets or unrestricted
server-local paths.

## Automated Verification

Agent-tool tests cover every action, argument requirement, permission
declaration, source-qualified identity rule, optimistic precondition, plan
token, success path, partial result, immutable/native rejection, and
no-mutation failure path.

Service and route tests prove that Settings and Agent adapters use the same
domain operations. Package-toggle tests verify preservation of every sibling
activation map. Uninstall tests verify exact skill cleanup, Agent-reference
cleanup, partial-state preservation, and native directory isolation.

The required Marketplace suite from `AGENTS.md` remains mandatory and is
expanded to include the new Agent lifecycle and live-test harness tests.

The final automated gate includes:

```bash
npx vitest run tests/plugin-marketplace-*.test.ts \
  tests/http-route-security.test.ts \
  tests/skill-manager.test.ts \
  tests/skills-route.test.ts \
  desktop/src/react/__tests__/settings/PluginMarketplaceTab.test.tsx \
  desktop/src/react/__tests__/settings/PluginsTab.test.tsx
npm run typecheck
git diff --check
```

## Live Hana Acceptance

Live verification uses the authenticated Hana session API and chat WebSocket,
not Codex Computer Use or desktop UI automation.

### Disposable fixtures

Create two harmless Claude Marketplace skill packages with unique identities:

```text
codex-agent-smoke-auto@codex-agent-smoke-auto
codex-agent-smoke-operate@codex-agent-smoke-operate
```

Each package contains one uniquely named `SKILL.md` and no native code, hooks,
binaries, routes, MCP servers, applications, credentials, or network
requirements.

Before mutation, the harness records registry status, installed package
inventory, relevant Agent preferences, native PluginManager inventory,
SkillWiki state, and collision checks for the disposable identities.

### Auto/autoreview chat

Create a visible detached session with `permissionMode: "auto"`. Its prompt
requires the real `plugin_marketplace` tool and forbids shell or HTTP
workarounds. It performs:

```text
list_sources
add_source
refresh_source
list_catalog
inspect_package
plan_install
install
list_installed_packages
set_package_enabled(false)
set_package_enabled(true)
plan_uninstall
uninstall
remove_source
```

Every mutation must show an automatic-review decision. Rejection is a valid
safety observation but not a passing lifecycle result.

### Operate/full-access chat

Create a second visible detached session with `permissionMode: "operate"` and
repeat the lifecycle using the second disposable identity. Mutations must
execute without review prompts while all hard service checks remain active.

### Independent assertions

The harness verifies actual API, registry, filesystem, inventory, runtime
skill, native PluginManager, and transcript state. A model-authored success
message is not sufficient evidence.

The assertions include:

- source add and refresh succeeded
- package installed under the exact identity
- skill appeared in skill-manager inventory
- package gate off made the skill runtime-inactive
- package gate on restored runtime availability
- per-Agent preferences remained unchanged
- uninstall removed the package and disposable skill directory
- source removal succeeded
- no disposable activation or Agent reference remained
- native PluginManager inventory remained unchanged
- existing SkillWiki installation, package gate, and preferences remained
  unchanged
- both transcripts contain real `plugin_marketplace` invocations

## Cleanup and Recovery

The normal lifecycle removes its own disposable state. The harness also
provides idempotent recovery limited to the two exact disposable identities.

Recovery re-reads current revision/digest state and never restores a complete
registry backup over concurrent changes. It does not use broad globs or
recursive deletion outside validated disposable paths. If exact cleanup cannot
complete safely, it reports the remaining source, package, activation, Agent
reference, and skill paths and stops.

## Build Verification

After automated tests, install the current working-tree build:

```bash
SKIP_NOTARIZE=true npm run install:local
codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
cat /Applications/HanaAgent.app/Contents/Resources/build-info.json
```

The build marker must report `channel: local` and the intended build identity.
Both live chats run against this installed build rather than a stale app.

## Documentation Outcome

The Marketplace handbook and Agent-facing tool documentation will state:

- Hana Agent supports full lifecycle management for mutable Claude-compatible
  Marketplace sources and Hana skill packages.
- `auto` is autoreview and `operate` is full session access.
- Settings and Hana Agent use the same server-owned domain operations.
- Source-qualified identities, plan tokens, and registry preconditions are
  mandatory.
- Native Marketplace plugin installation remains intentionally deferred.

## Acceptance Criteria

The feature is complete when:

1. All approved Agent actions exist with declared permission boundaries.
2. Source and package mutations reuse shared domain operations.
3. Package toggling preserves all unrelated activations and Agent preferences.
4. Uninstall is exact, stale-protected, partial-state aware, and native-safe.
5. The focused Marketplace suite, typecheck, and diff checks pass.
6. A newly installed local HanaAgent build passes both live chat lifecycles in
   `auto` and `operate`.
7. Independent state checks prove complete cleanup and no change to existing
   SkillWiki or native PluginManager state.
8. Documentation clearly distinguishes supported Hana skill-package lifecycle
   from deferred native Marketplace plugin installation.
