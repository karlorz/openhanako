# Coding-agent GitHub authority boundary

## Decision

Codex and Claude may research public upstream material and prepare local Markdown, but they may never mutate `liliMozi/openhanako`. On `karlorz/openhanako`, human-facing GitHub communication is also human-only; separately authorized engineering operations remain available only through explicit fork-scoped workflows.

This is a separation of duties, not an approval prompt:

| Activity | Codex / Claude authority | Required path |
|---|---|---|
| Search, list, view, public GET, reference, or download upstream material | Allowed | Read-only command or browser request |
| Prepare or revise an issue report | Allowed | Local Markdown under `docs/upstream-issues/` or the OpenHanako SkillWiki project |
| Approve draft wording | Human decision | Changes draft content state only; grants no posting authority |
| Create/edit/comment/close/reopen/label/react/transfer/delete upstream state | Never allowed | Human performs it manually outside the agent session |
| Create an issue, issue comment, PR comment/review, discussion, reaction, label, or direct PR edit on the fork | Never allowed | Human performs it manually outside the agent session |
| Refresh the generated block and labels of permanent dashboard PR #1 | Separately authorized exception | Exact `node scripts/sync-upstream.mjs --conflict-plan` workflow |
| Push fork refs, dispatch a fork workflow, or manage a fork release | Separately authorized engineering operation | Exact task-specific user request and explicit `karlorz/openhanako`/`origin` target |
| Mutation with an implicit target, raw API request, or unknown side effect | Denied | Resolve to a supported explicit workflow or leave it to a human |

## Why the old wording was insufficient

The earlier runbook said the tracker “never submits GitHub issues” and required approval before submission. That protected the tracker command itself, but it did not explicitly define comments, edits, labels, reactions, GraphQL calls, browser actions, or other GitHub writes as submissions. It also had no executable Codex or Claude pre-tool guard. The repository therefore could not reliably distinguish approval of draft wording from authority to publish it.

The referenced comment on upstream issue #1749 is not edited or deleted by this policy change. The repository has no durable record proving the exact payload was reviewed before it appeared upstream, so no causal or reproduction claim should be inferred from that comment without a fresh human review.

## Local enforcement

Both project hook configurations invoke the same deterministic, network-free classifier before matched tool execution:

- Codex: `.codex/hooks.json`
- Claude Code: `.claude/settings.json`
- Shared classifier: `scripts/guard-agent-github-mutation.mjs`
- Offline tests: `tests/agent-github-mutation-guard.test.mjs`

The guard blocks:

- every recognized upstream mutation, including git pushes, releases, workflows, issues, PRs, API writes, and GitHub MCP writes;
- fork issue/PR communication, discussions, reactions, labels, and direct PR edits;
- mutation commands whose repository or side effect is ambiguous;
- direct raw GitHub API writes to protected repositories.

The guard deliberately does not convert an allowed command into approval. An explicit fork push, release, workflow dispatch, or dashboard refresh still goes through the normal task authorization and permission process.

Tests use synthetic command and hook-event fixtures only. Do not verify this boundary by posting, editing, reacting, labeling, closing, or deleting a live GitHub object.

## Administrative enforcement

Repository hooks are defense in depth, not a complete security boundary. Project hooks require workspace trust; Codex hooks can be disabled, specialized/hosted tool paths may not dispatch them, and Claude can be started in modes that omit project hooks. Browser sessions can also carry credentials outside a CLI hook's visibility. The official documentation describes these limitations for [Codex hooks](https://developers.openai.com/codex/hooks), [Claude Code hooks](https://code.claude.com/docs/en/hooks), and [Claude Code settings](https://code.claude.com/docs/en/settings).

Use credential isolation as the stronger layer:

1. Do not expose a classic PAT, broad OAuth token, or a human browser session with upstream write authority to Codex or Claude.
2. Prefer a short-lived GitHub App installation token installed only on `karlorz/openhanako`, with only the permissions required for the attended engineering task. GitHub documents selected-repository installation at [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).
3. A fine-grained PAT selected only for `karlorz/openhanako` is the practical fallback; limit its lifetime and permissions. GitHub documents its repository and permission constraints at [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
4. Keep Issues, Discussions, and Pull requests write permissions out of the persistent agent credential. If the PR #1 dashboard refresh needs Pull requests write, inject a separate short-lived token only for that attended exact workflow.
5. Keep the agent browser logged out of GitHub, or use a separate profile without upstream write authority. A human uses a different session to submit reviewed content.

The repository cannot create or rotate those GitHub credentials by itself. Credential provisioning and project-hook trust remain explicit human setup steps.

## Known coverage limits

- A project hook cannot prevent a human or unrelated GitHub Action from mutating GitHub.
- A subprocess can hide network behavior from a command-text classifier. The guard recognizes the repository's known GitHub helpers, but credential isolation is what prevents an unknown subprocess from obtaining upstream authority.
- A browser click may omit the current URL or semantic action from its hook payload. Human-only credentials and the written boundary remain necessary.
- The existing `close-prs.yml` GitHub Action is outside this Codex/Claude boundary; changing that separately approved repository automation requires its own attended decision.
- An allowed fork engineering result means “not permanently prohibited by this classifier,” not “authorized now.”
