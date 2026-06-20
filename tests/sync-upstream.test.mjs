import { describe, expect, it } from "vitest";

import {
  buildConflictPlan,
  buildPrBodyWithDashboard,
  changedDivergingFiles,
  ISSUE_COMMANDS,
  loadRules,
  parseMergeTreeConflictingFiles,
  parseSyncArgs,
  releaseChannelLabel,
  renderPrDashboardBlock,
  selectLatestReleaseTag,
  verificationCommands,
} from "../scripts/sync-upstream.mjs";

describe("sync-upstream rule engine", () => {
  it("loads the fork-sync policy rules from YAML", () => {
    const rules = loadRules();

    expect(rules.releaseTarget.stableOnlyDefault).toBe(true);
    expect(rules.releaseTarget.prereleaseFlag).toBe("--include-prerelease");
    expect(rules.conflictRules.divergingFiles).toContain("core/server-auth.ts");
    expect(rules.criticalFileClasses).toContain("lan_connect_auth");
    expect(rules.issueTracking.states).toContain("tracked/no-upstream-issue");
  });

  it("selects stable upstream releases by default", () => {
    const releases = [
      { tagName: "v0.325.0-beta.1", isDraft: false, isPrerelease: true },
      { tagName: "v0.324.0", isDraft: false, isPrerelease: false },
      { tagName: "v0.326.0", isDraft: true, isPrerelease: false },
    ];

    expect(selectLatestReleaseTag(releases)).toBe("v0.324.0");
    expect(releaseChannelLabel(false)).toBe("stable only");
  });

  it("allows prerelease review only when explicitly requested", () => {
    const releases = [
      { tagName: "v0.325.0-beta.1", isDraft: false, isPrerelease: true },
      { tagName: "v0.324.0", isDraft: false, isPrerelease: false },
    ];

    expect(selectLatestReleaseTag(releases, { includePrerelease: true })).toBe("v0.325.0-beta.1");
    expect(releaseChannelLabel(true)).toBe("stable + prerelease");
  });

  it("reports only upstream changes that intersect configured diverging files", () => {
    const rules = loadRules();

    expect(
      changedDivergingFiles(
        ["README.md", "core/server-auth.ts", "desktop/src/react/services/resource-url.ts"],
        rules,
      ),
    ).toEqual(["core/server-auth.ts", "desktop/src/react/services/resource-url.ts"]);
  });

  it("loads verification commands from the rule file", () => {
    expect(verificationCommands(loadRules())).toContain("npm run build:preload");
  });

  it("supports local upstream issue review modes without a submit mode", () => {
    expect(ISSUE_COMMANDS).toEqual(["status", "search", "draft"]);
    expect(ISSUE_COMMANDS).not.toContain("submit");
  });

  it("keeps local-only conflict planning free of PR edits and origin/main sync", () => {
    const parsed = parseSyncArgs(["--conflict-plan", "--json", "--local-only"]);

    expect(parsed.args).toEqual(["--conflict-plan"]);
    expect(parsed.conflictOptions).toMatchObject({
      json: true,
      noPrUpdate: true,
      syncMain: false,
    });
  });

  it("allows skipping origin/main sync independently from PR updates", () => {
    const parsed = parseSyncArgs(["--conflict-plan", "--no-main-sync"]);

    expect(parsed.args).toEqual(["--conflict-plan"]);
    expect(parsed.conflictOptions).toMatchObject({
      noPrUpdate: false,
      syncMain: false,
    });
  });

  it("builds a dry-run conflict plan that defaults unknown conflicts to main", () => {
    const plan = buildConflictPlan(["README.md"], {
      conflictRules: {
        defaultResolution: "main",
        dryRunDefault: true,
        divergingFiles: [],
        policies: {},
      },
    });

    expect(plan).toMatchObject({
      kind: "openhanako-fork-conflict-plan",
      dryRun: true,
      defaultResolution: "main",
      conflicts: [{
        file: "README.md",
        strategy: "take-main",
        source: "default",
        plannedAction: "Would accept the origin/main version if a future resolver executes this plan.",
      }],
    });
  });

  it("keeps explicit fork conflict exceptions out of the default main rule", () => {
    const rules = loadRules();

    const plan = buildConflictPlan([
      "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      "package.json",
      "package-lock.json",
      "README.md",
    ], rules);

    expect(plan.defaultResolution).toBe("main");
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        file: "README.md",
        strategy: "take-main",
        source: "default",
      }),
      expect.objectContaining({
        file: "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
        strategy: "preserve-both",
        source: "policy",
      }),
      expect.objectContaining({
        file: "desktop/src/react/services/ws-message-handler.ts",
        strategy: "human-review",
        source: "linked-risk",
        triggeredBy: "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      }),
      expect.objectContaining({
        file: "package-lock.json",
        strategy: "defer-to-stable-production-sync",
        source: "policy",
      }),
      expect.objectContaining({
        file: "package.json",
        strategy: "defer-to-stable-production-sync",
        source: "policy",
      }),
    ]);
  });

  it("links ws-message-handler test conflicts to the production session identity risk", () => {
    const rules = loadRules();

    const plan = buildConflictPlan([
      "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
    ], rules);

    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        file: "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
        strategy: "preserve-both",
        source: "policy",
      }),
      expect.objectContaining({
        file: "desktop/src/react/services/ws-message-handler.ts",
        strategy: "human-review",
        source: "linked-risk",
        risk: "high",
        triggeredBy: "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      }),
    ]);
  });

  it("parses conflicted files from git merge-tree output", () => {
    const output = [
      "100644 abc 1\tpackage.json",
      "100644 def 2\tpackage.json",
      "100644 ghi 3\tpackage.json",
      "CONFLICT (content): Merge conflict in desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      "Auto-merging server/index.ts",
    ].join("\n");

    expect(parseMergeTreeConflictingFiles(output)).toEqual([
      "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      "package.json",
    ]);
  });

  it("renders and replaces only the generated PR dashboard block", () => {
    const block = renderPrDashboardBlock({
      generatedAt: "2026-06-20T00:00:00.000Z",
      dryRun: true,
      dashboardBase: {
        upstreamMain: "upstreamsha",
        originMainBefore: "oldmainsha",
        originMainAfter: "newmainsha",
        originMainReplaced: true,
      },
      forkHead: { originDev: "devsha" },
      productionSync: {
        latestStableTag: "v0.331.2",
        lastSyncedTag: "v0.323.0",
        stableSyncAvailable: true,
      },
      pr: {
        number: 1,
        url: "https://github.com/karlorz/openhanako/pull/1",
        mergeable: "CONFLICTING",
      },
      conflicts: [{
        file: "package.json",
        strategy: "defer-to-stable-production-sync",
        source: "policy",
        risk: "medium",
        plannedAction: "Report only. Stable production fork sync owns the package version update.",
      }],
      upstreamSignals: {
        latestCommits: ["abc fix: one"],
        riskyFilesTouched: ["package.json"],
      },
    });

    expect(block).toContain("<!-- openhanako-conflict-dashboard:start -->");
    expect(block).toContain("Permanent draft dashboard. Never merge.");
    expect(block).toContain("package.json");

    const original = [
      "# Human notes",
      "keep this",
      "<!-- openhanako-conflict-dashboard:start -->",
      "old generated text",
      "<!-- openhanako-conflict-dashboard:end -->",
      "tail note",
    ].join("\n");

    const next = buildPrBodyWithDashboard(original, block);

    expect(next).toContain("# Human notes");
    expect(next).toContain("tail note");
    expect(next).not.toContain("old generated text");
    expect(next).toContain("package.json");
  });
});
