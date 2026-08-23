# OpenHanako coding-agent boundary

This checkout is the `karlorz/openhanako` fork on `dev`; upstream is `liliMozi/openhanako`. Read `CLAUDE.md`, `CONTEXT.md`, and `FORK_SYNC.md` for the shared development and release rules.

## GitHub authority

- Treat `liliMozi/openhanako` as permanently read-only. Codex and Claude may search, list, view, fetch, reference, and download public upstream material, but must never create, edit, comment on, close, reopen, label, react to, transfer, delete, publish, push to, or otherwise mutate upstream state.
- Keep issue reports and other proposed upstream communications as local Markdown under `docs/upstream-issues/`. Human approval of wording is not authorization for an agent to post it. Only a human acting manually outside an agent session may submit it.
- On `karlorz/openhanako`, issue creation, issue comments, PR comments/reviews, discussions, reactions, labels, and direct PR edits are also human-only. The only PR exception is the generated permanent-dashboard update performed by the separately authorized `scripts/sync-upstream.mjs --conflict-plan` workflow.
- Fork engineering writes such as an explicit `git push origin ...`, fork-scoped release operation, workflow dispatch, or permanent-dashboard refresh require a separate task-specific user request. Draft approval never grants this authority.
- Use explicit repository targets for any authorized fork engineering mutation. An implicit or ambiguous GitHub mutation must fail closed.
- Project hooks in `.codex/hooks.json` and `.claude/settings.json` call `scripts/guard-agent-github-mutation.mjs`. Do not bypass, disable, rewrite, or route around that guard. If it blocks a legitimate operation, stop and ask the human to perform or separately authorize the exact supported fork engineering workflow.
- Do not test the guard by attempting a live mutation. Use `tests/agent-github-mutation-guard.test.mjs`, which contains offline synthetic fixtures.
