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

## Key Paths

- Desktop renderer: `desktop/src/react/`
- Electron main/preload: `desktop/main.cjs`, `desktop/preload.cjs`
- Server routes: `server/routes/`
- Shared auth/resource logic: `core/`, `lib/`
- Fork sync rules/helper: `docs/fork-sync/rules.yml`, `scripts/sync-upstream.mjs`

## Deploy

The old sg01 SSH deploy helper has been retired. Use the unified Linux
server flow in `scripts/install-server.mjs` / `docs/server-install.md`
for server install, upgrade, and status planning. Do not add a dev-loop
`deploy_script` unless a future attended release explicitly wants automatic
host deployment.

For local macOS desktop verification, use:

```bash
SKIP_NOTARIZE=true npm run install:local
codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
```

## Verification

For LAN and remote attachment work, run the focused suite documented in `CONTEXT.md`, plus `npm run typecheck` and `git diff --check`. Live smoke against sg01 must include image paste/upload, send, switch chats, return, and confirm both chat thumbnails and Conversation Files previews still render.

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
