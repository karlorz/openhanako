# OpenHanako Dev Notes

This checkout is the `karlorz/openhanako` fork. Work normally happens on branch `dev`; upstream is `liliMozi/openhanako`.

## Runtime Targets

- Remote server: `http://100.125.173.118:14500`
- Remote host alias: `sg01`
- Server service: `hanaagent`
- Local desktop app: `/Applications/HanaAgent.app`
- SkillWiki project: `projects/openhanako` under the vault returned by `skillwiki path`

## Dev-Loop

- Config: `.claude/dev-loop.config.md`
- Project context: `CONTEXT.md`
- Fork sync runbook: `FORK_SYNC.md`
- Dev-loop setup notes: `docs/agents/openhanako-dev-loop-setup.md`
- GitHub CLI default repo should resolve to `karlorz/openhanako`; run `gh repo set-default karlorz/openhanako` if `gh repo view` points at upstream.
- Working branch is `dev`. Do not treat `main` as the dev-loop release branch.
- PR #1 is a permanent draft dashboard from `dev` to `main`; never merge it, never enable auto-merge, and never close it as a completed merge vehicle.
- Safe dashboard refresh: `node scripts/sync-upstream.mjs --conflict-plan`. This may mirror `origin/main` from `upstream/main`, but must not merge, rebase, reset, stage, or write `dev`.
- Dashboard conflict cleanup must not pre-bump `package.json` or `package-lock.json`; package version alignment is deferred to the attended stable production fork sync.

## GitHub Authority

- Treat `liliMozi/openhanako` as permanently read-only. Claude may research and download public upstream material but may never create, edit, comment on, close, reopen, label, react to, transfer, delete, publish, push to, or otherwise mutate upstream state.
- Keep proposed issue reports and upstream communications as local Markdown under `docs/upstream-issues/`. Human approval of draft wording does not authorize Claude to post it; a human must submit manually outside the agent session.
- On `karlorz/openhanako`, issues, issue comments, PR comments/reviews, discussions, reactions, labels, and direct PR edits are human-only. The separately authorized generated PR #1 dashboard refresh is the only PR-edit exception.
- Fork pushes, releases, workflow dispatches, and dashboard refreshes still require a separate task-specific request and an explicit fork target. Ambiguous GitHub mutations fail closed.
- `.claude/settings.json` invokes the shared `scripts/guard-agent-github-mutation.mjs` `PreToolUse` guard. Never disable or bypass it, and verify it only with the offline synthetic test suite.

## Key Paths

- Desktop renderer: `desktop/src/react/`
- Electron main/preload: `desktop/main.cjs`, `desktop/preload.cjs`
- Server routes: `server/routes/`
- Shared auth/resource logic: `core/`, `lib/`
- Fork sync rules/helper: `docs/fork-sync/rules.yml`, `scripts/sync-upstream.mjs`
- Marketplace handbook: `docs/plugins/marketplace-handbook.md`
- Manage Plugins tab: `desktop/src/react/settings/tabs/PluginsTab.tsx`
- Plugin Marketplace tab: `desktop/src/react/settings/tabs/PluginMarketplaceTab.tsx`

## Marketplace / Manage Plugins (skill packages)

- Claude marketplace packages install as **Hana skills** (skill-manager), never as native PluginManager plugins under `~/.hanako/plugins`.
- Installed skill packages appear under **Settings → Plugins → Manage Plugins** (Hana skills badge) and in Plugin Marketplace detail when installed.
- Global package gate: `activations.marketplaceSkillPackages[pluginId@marketplaceId]`; installed-default is enabled when no record exists.
- Inventory API: `GET /api/plugins/marketplace/installed-skill-packages` — do **not** change `GET /api/plugins` array shape.
- Activations `PUT` replaces the **full** activations object; UI must clone the owner snapshot (refuse toggle if activations missing).
- Package uninstall: `DELETE /api/plugins/marketplace/:id/skills` (not `DELETE /api/plugins/:id`).
- SkillWiki work item: `projects/openhanako/work/2026-07-31-manage-plugins-marketplace-skill-packages/` under vault from `skillwiki path`.

## Deploy

The old sg01 SSH deploy helper has been retired. Use the unified Linux
server flow in `scripts/install-server.mjs` / `docs/server-install.md`
for server install, upgrade, and status planning. Do not add a dev-loop
`deploy_script` unless a future attended release explicitly wants automatic
host deployment.

For local macOS desktop verification (current branch **working tree**, not origin):

```bash
SKIP_NOTARIZE=true npm run install:local
codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
cat /Applications/HanaAgent.app/Contents/Resources/build-info.json
```

Confirm `channel: local` and `gitSha` match the intended commit. `install:local` packs `dist/mac-arm64` and replaces `/Applications/HanaAgent.app`. Local same-version/different-digest artifact refresh applies on first launch per `HANA_HOME` when channel is `local`.

## Verification

For LAN and remote attachment work, run the focused suite documented in `CONTEXT.md`, plus `npm run typecheck` and `git diff --check`. Live smoke against sg01 must include image paste/upload, send, switch chats, return, and confirm both chat thumbnails and Conversation Files previews still render.

For marketplace skill-package / Manage Plugins work, run:

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

Then `SKIP_NOTARIZE=true npm run install:local` and manual smoke: install skill package → Manage Plugins row → package toggle off/on → uninstall package; native HyperFrames and dropzone unchanged.

For fork-sync or dashboard work, run:

```bash
npx vitest run tests/sync-upstream.test.mjs
node scripts/sync-upstream.mjs --conflict-plan --json --local-only
npm run typecheck
git diff --check
```

For attended dev-loop dry-run inventory, use prep mode rather than a core cycle:

```text
/dev-loop prep --limit 5 --lane work,captures,hygiene
```

Prep mode inventories current work/captures/hygiene and does not implement, merge, push, or start a goal.
