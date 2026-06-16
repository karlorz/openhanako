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

## Deploy

Server deploy automation is intentionally pending. Do not use or commit
`scripts/deploy-sg01-server.sh`; the next deployment work should replace it
with the unified Linux server install/upgrade flow.

For local macOS desktop verification, use:

```bash
SKIP_NOTARIZE=true npm run install:local
codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app
```

## Verification

For LAN and remote attachment work, run the focused suite documented in `CONTEXT.md`, plus `npm run typecheck` and `git diff --check`. Live smoke against sg01 must include image paste/upload, send, switch chats, return, and confirm both chat thumbnails and Conversation Files previews still render.
