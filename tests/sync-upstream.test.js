import { describe, expect, it } from "vitest";

import {
  changedDivergingFiles,
  ISSUE_COMMANDS,
  loadRules,
  releaseChannelLabel,
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
});
