import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  assertNoForceAdoptFromMain,
  attachPickFromMainDecisions,
  buildConflictPlan,
  checkForkReclaimGuards,
  decisionForConflictPath,
  loadPickFromMainDecisions,
  loadRules,
  pickFromMainDecisionIndex,
} from "../scripts/sync-upstream.mjs";

describe("pick-from-main decisions (real loader)", () => {
  it("loads the inventory referenced by fork-sync rules", () => {
    const rules = loadRules();
    expect(rules.pickFromMain?.inventory).toBe("docs/fork-sync/pick-from-main-decisions.yml");
    const decisions = loadPickFromMainDecisions();
    expect(decisions.schemaVersion).toBe(1);
    expect(decisions.paths.length).toBeGreaterThanOrEqual(16);
    expect(decisions.adoptNow).toEqual([]);
    expect(decisions.reclaimGuards.length).toBeGreaterThanOrEqual(4);
  });

  it("covers every current planned conflict path with a decision row", () => {
    const decisions = loadPickFromMainDecisions();
    const index = pickFromMainDecisionIndex(decisions);
    const plan = buildConflictPlan(
      decisions.paths.map((row) => row.path).filter((p) => p !== "package-lock.json"),
    );
    for (const item of plan.conflicts) {
      expect(index.has(item.file), `missing decision for ${item.file}`).toBe(true);
      expect(item.pickFromMain?.decision).toMatch(/^(adopt-now|wait-stable|preserve-fork)$/);
      if (item.pickFromMain.decision !== "adopt-now") {
        expect(item.pickFromMain.forceAdoptForbidden).toBe(true);
      }
    }
    expect(plan.pickFromMain.adoptNowCount).toBe(0);
  });

  it("forbids force-adopt of wait-stable and preserve-fork paths (real assert entry)", () => {
    const result = assertNoForceAdoptFromMain({
      attemptedPaths: [
        "package.json",
        "release-digest.v1.json",
        "desktop/main.cjs",
        "build/installer.nsh",
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.forbidden.map((f) => f.file).sort()).toEqual([
      "build/installer.nsh",
      "desktop/main.cjs",
      "package.json",
      "release-digest.v1.json",
    ]);
    expect(assertNoForceAdoptFromMain({ attemptedPaths: [] }).ok).toBe(true);
  });

  it("attaches decisions onto synthetic conflict plans via the real helper", () => {
    const plan = attachPickFromMainDecisions({
      kind: "openhanako-fork-conflict-plan",
      conflicts: [
        { file: "package.json", strategy: "defer-to-stable-production-sync" },
        { file: "unknown-file.xyz", strategy: "take-main" },
      ],
    });
    expect(plan.conflicts[0].pickFromMain.decision).toBe("wait-stable");
    expect(plan.conflicts[1].pickFromMain.decision).toBe("unlisted");
    expect(plan.conflicts[1].pickFromMain.forceAdoptForbidden).toBe(true);
    expect(decisionForConflictPath("scripts/fix-modules.cjs")?.decision).toBe("wait-stable");
  });
});

describe("fork reclaim guards (real working tree)", () => {
  it("passes on the current fork seams (no duplicate reclaim of landed fixes)", () => {
    const result = checkForkReclaimGuards();
    expect(result.ok, JSON.stringify(result.violations, null, 2)).toBe(true);
    expect(result.violationCount).toBe(0);
  });

  it("detects reclaimed connect-probe inlining when main source is polluted", () => {
    const root = process.cwd();
    const realMain = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
    const polluted = `${realMain}\n// reclaim test\nconst baseUrl must be http(s) = true;\nlogin redirect blocked\n`;
    const result = checkForkReclaimGuards({
      readFileSync: (rel) => {
        if (rel === "desktop/main.cjs") return polluted;
        return fs.readFileSync(path.join(root, rel), "utf8");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.id === "connect-probe-isolation")).toBe(true);
  });

  it("detects obsolete resource-url transport predicate reclaim in rules", () => {
    const root = process.cwd();
    const result = checkForkReclaimGuards({
      readFileSync: (rel) => {
        if (rel === "docs/fork-sync/rules.yml") {
          return "isLocalTransport is `!connection || connection.kind === 'local'`\n";
        }
        return fs.readFileSync(path.join(root, rel), "utf8");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.id === "resource-url-owner-only-native")).toBe(true);
  });

  it("detects LAN websocket reclaim that drops resolveConnectionWsAuth", () => {
    const root = process.cwd();
    const result = checkForkReclaimGuards({
      readFileSync: (rel) => {
        if (rel === "desktop/src/react/services/websocket.ts") {
          return "if (connection.kind === 'lan') { return { mode: 'legacy-query-token' }; }\n";
        }
        return fs.readFileSync(path.join(root, rel), "utf8");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.id === "ticket-primary-ws")).toBe(true);
  });
});
