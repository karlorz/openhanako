import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyHookEvent,
  classifyShellCommand,
  denyHookOutput,
  PERMANENT_DASHBOARD_PR,
} from "../scripts/guard-agent-github-mutation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "scripts", "guard-agent-github-mutation.mjs");

function expectPass(command, reasonCode) {
  const result = classifyShellCommand(command);
  expect(result, command).toMatchObject({ decision: "pass" });
  if (reasonCode) expect(result.reasonCode, command).toBe(reasonCode);
}

function expectDenied(command, reasonCode) {
  expect(classifyShellCommand(command), command).toMatchObject({
    decision: "deny",
    reasonCode,
  });
}

describe("agent GitHub mutation guard", () => {
  it("allows side-effect-free upstream research and local drafting", () => {
    for (const command of [
      "gh issue list --repo liliMozi/openhanako --state all",
      "gh issue view 1749 --repo liliMozi/openhanako",
      "gh pr diff 1749 --repo liliMozi/openhanako",
      "gh release download v0.446.6 --repo liliMozi/openhanako",
      "curl -fsS https://api.github.com/repos/liliMozi/openhanako/issues/1749",
      "git fetch upstream main",
      "node scripts/track-upstream-issues.mjs status",
      "node scripts/track-upstream-issues.mjs search",
      "node scripts/track-upstream-issues.mjs draft",
      "rg -n 'gh issue comment' docs/upstream-issues",
    ]) {
      expectPass(command);
    }
  });

  it("permanently denies upstream mutations across normal CLI surfaces", () => {
    for (const command of [
      "gh issue comment 1749 --repo liliMozi/openhanako --body-file draft.md",
      "gh issue edit 1749 --repo liliMozi/openhanako --add-label bug",
      "gh pr review 1749 --repo liliMozi/openhanako --approve",
      "gh release create v9.9.9 --repo liliMozi/openhanako",
      "gh workflow run build.yml --repo liliMozi/openhanako",
      "git push upstream main",
      "git push https://github.com/liliMozi/openhanako.git main",
      "git remote set-url origin https://github.com/liliMozi/openhanako.git",
      "curl -X PATCH https://api.github.com/repos/liliMozi/openhanako/issues/1749 -d '{}'",
      "gh api repos/liliMozi/openhanako/issues/1749 --method PATCH -f title=test",
      "node scripts/publish-train.mjs",
    ]) {
      expectDenied(command, "UPSTREAM_READONLY");
    }
    expectDenied(
      "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'",
      "AMBIGUOUS_GITHUB_MUTATION",
    );
  });

  it("keeps fork social publishing human-only", () => {
    for (const command of [
      "gh issue create --repo karlorz/openhanako --title bug --body-file draft.md",
      "gh issue comment 1 --repo karlorz/openhanako --body test",
      "gh pr edit 1 --repo karlorz/openhanako --title dashboard",
      "gh pr review 1 --repo karlorz/openhanako --comment --body test",
      "gh discussion create --repo karlorz/openhanako --title test --body test",
      "gh label create test --repo karlorz/openhanako",
      "curl -d '{}' https://api.github.com/repos/karlorz/openhanako/issues",
    ]) {
      expectDenied(command, "SOCIAL_HUMAN_ONLY");
    }
  });

  it("fails closed when a GitHub mutation target is implicit or raw", () => {
    for (const command of [
      "gh issue create --title bug --body-file draft.md",
      "gh issue comment 1749 --body test",
      "gh release create v9.9.9",
      "gh api repos/karlorz/openhanako/releases --method POST --input release.json",
      "gh api graphql -f query='{ viewer { login } }'",
      "gh unreviewed-extension-command",
      "git push",
    ]) {
      expectDenied(command, "AMBIGUOUS_GITHUB_MUTATION");
    }
  });

  it("leaves explicitly targeted fork engineering lanes to normal task authorization", () => {
    expectPass("git push origin dev", "FORK_ENGINEERING_AUTH_REQUIRED");
    expectPass(
      "git push https://github.com/karlorz/openhanako.git refs/tags/v0.421.24-karlorz.6",
      "FORK_ENGINEERING_AUTH_REQUIRED",
    );
    expectPass(
      "gh release create v0.421.24-karlorz.6 --repo karlorz/openhanako",
      "FORK_ENGINEERING_AUTH_REQUIRED",
    );
    expectPass(
      "gh workflow run build.yml --repo karlorz/openhanako",
      "FORK_ENGINEERING_AUTH_REQUIRED",
    );
    expectPass(
      "node scripts/sync-upstream.mjs --conflict-plan",
      "FORK_DASHBOARD_AUTH_REQUIRED",
    );
    expectPass(
      `node scripts/sync-upstream.mjs --conflict-plan --pr ${PERMANENT_DASHBOARD_PR}`,
      "FORK_DASHBOARD_AUTH_REQUIRED",
    );
    expectPass("node scripts/sync-upstream.mjs --conflict-plan --local-only", "FORK_DASHBOARD_AUTH_REQUIRED");
    expectDenied(
      "node scripts/sync-upstream.mjs --conflict-plan --pr 2",
      "SOCIAL_HUMAN_ONLY",
    );
    expectDenied(
      "node scripts/sync-upstream.mjs --conflict-plan --pr=2",
      "SOCIAL_HUMAN_ONLY",
    );
  });

  it("parses git global options before enforcing the push and remote boundary", () => {
    for (const command of [
      "git -C . push upstream main",
      "git --git-dir=.git push upstream main",
      "git -c remote.pushDefault=upstream push upstream main",
      "git -c remote.origin.pushurl=https://github.com/liliMozi/openhanako.git push origin main",
      "git -C . remote set-url origin https://github.com/liliMozi/openhanako.git",
    ]) {
      expectDenied(command, "UPSTREAM_READONLY");
    }
    expectPass("git -C . push origin dev", "FORK_ENGINEERING_AUTH_REQUIRED");
  });

  it("detects protected mutations inside common shell wrappers", () => {
    expectDenied(
      "sh -c 'gh issue comment 1749 --repo liliMozi/openhanako --body nope'",
      "UPSTREAM_READONLY",
    );
    expectDenied(
      "env GH_PAGER=cat gh issue create --repo karlorz/openhanako --title nope --body nope",
      "SOCIAL_HUMAN_ONLY",
    );
    expectDenied(
      "gh issue list --repo liliMozi/openhanako && gh issue comment 1749 --repo liliMozi/openhanako --body nope",
      "UPSTREAM_READONLY",
    );
    expectDenied(
      "echo \"$(gh issue comment 1749 --repo liliMozi/openhanako --body nope)\"",
      "UPSTREAM_READONLY",
    );
    expectDenied(
      "echo `gh issue comment 1749 --repo liliMozi/openhanako --body nope`",
      "UPSTREAM_READONLY",
    );
    expectDenied(
      "echo safe & gh issue comment 1749 --repo liliMozi/openhanako --body nope",
      "UPSTREAM_READONLY",
    );
    expectDenied(
      "bash -lc 'gh issue comment 1749 --repo liliMozi/openhanako --body nope'",
      "UPSTREAM_READONLY",
    );
    expectDenied(
      "timeout 10s gh issue comment 1749 --repo liliMozi/openhanako --body nope",
      "UPSTREAM_READONLY",
    );
    expectDenied(
      "xargs -I {} gh issue comment 1749 --repo liliMozi/openhanako --body {}",
      "UPSTREAM_READONLY",
    );
  });

  it("recognizes attached REST client mutation flags and protected URLs anywhere in the request", () => {
    for (const command of [
      "curl -XPATCH https://api.github.com/repos/liliMozi/openhanako/issues/1749",
      "curl -dfoo https://api.github.com/repos/liliMozi/openhanako/issues",
      "curl --json '{}' https://api.github.com/repos/liliMozi/openhanako/issues",
      "curl -d 'https://github.com/other/repo' https://api.github.com/repos/liliMozi/openhanako/issues",
      "gh api repos/liliMozi/openhanako/issues/1749 -XPATCH",
      "gh api repos/liliMozi/openhanako/issues/1749 --input=payload.json",
      "wget --method POST https://api.github.com/repos/liliMozi/openhanako/issues",
      "wget --method=POST https://api.github.com/repos/liliMozi/openhanako/issues",
    ]) {
      expectDenied(command, "UPSTREAM_READONLY");
    }
  });

  it("classifies GitHub MCP mutations while allowing reads", () => {
    expect(classifyHookEvent({
      tool_name: "mcp__github__get_issue",
      tool_input: { owner: "liliMozi", repo: "openhanako", issue_number: 1749 },
    })).toMatchObject({ decision: "pass" });

    expect(classifyHookEvent({
      tool_name: "mcp__github__add_issue_comment",
      tool_input: { owner: "liliMozi", repo: "openhanako", issue_number: 1749, body: "nope" },
    })).toMatchObject({ decision: "deny", reasonCode: "UPSTREAM_READONLY" });

    expect(classifyHookEvent({
      tool_name: "mcp__github__create_issue",
      tool_input: { owner: "karlorz", repo: "openhanako", title: "nope" },
    })).toMatchObject({ decision: "deny", reasonCode: "SOCIAL_HUMAN_ONLY" });

    expect(classifyHookEvent({
      tool_name: "mcp__github__create_release",
      tool_input: { tag: "v9.9.9" },
    })).toMatchObject({ decision: "deny", reasonCode: "AMBIGUOUS_GITHUB_MUTATION" });

    for (const toolName of [
      "mcp__github__createPullRequest",
      "mcp__github__approve_pull_request",
      "mcp__github__request_reviewers",
      "mcp__github__mark_as_ready",
    ]) {
      expect(classifyHookEvent({
        tool_name: toolName,
        tool_input: { owner: "liliMozi", repo: "openhanako" },
      }), toolName).toMatchObject({ decision: "deny", reasonCode: "UPSTREAM_READONLY" });
    }

    expect(classifyHookEvent({
      tool_name: "mcp__playwright__browser_click",
      tool_input: { url: "https://github.com/liliMozi/openhanako/issues/1749", ref: "comment-button" },
    })).toMatchObject({ decision: "deny", reasonCode: "UPSTREAM_READONLY" });
  });

  it("fails closed on malformed matched hook events", () => {
    expect(classifyHookEvent(null)).toMatchObject({
      decision: "deny",
      reasonCode: "INVALID_HOOK_INPUT",
    });
    expect(classifyHookEvent({ tool_name: "Bash", tool_input: {} })).toMatchObject({
      decision: "deny",
      reasonCode: "INVALID_HOOK_INPUT",
    });
  });

  it("emits the documented Codex and Claude PreToolUse denial shape", () => {
    const result = classifyShellCommand(
      "gh issue comment 1749 --repo liliMozi/openhanako --body nope",
    );
    expect(denyHookOutput(result)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("UPSTREAM_READONLY"),
      },
    });

    const child = spawnSync(process.execPath, [GUARD], {
      cwd: ROOT,
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "gh issue comment 1749 --repo liliMozi/openhanako --body nope",
        },
      }),
    });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(child.stderr).toBe("");
  });

  it("ships tracked project hook configurations for both agents", () => {
    const codex = JSON.parse(fs.readFileSync(path.join(ROOT, ".codex", "hooks.json"), "utf8"));
    const claude = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"));
    expect(codex.hooks.PreToolUse[0].matcher).toContain("Bash");
    expect(codex.hooks.PreToolUse[0].matcher).toContain("mcp__");
    expect(codex.hooks.PreToolUse[0].hooks[0].command).toContain("guard-agent-github-mutation.mjs");
    expect(claude.hooks.PreToolUse[0].matcher).toContain("Bash");
    expect(claude.hooks.PreToolUse[0].matcher).toContain("mcp__");
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toContain("guard-agent-github-mutation.mjs");
  });
});
