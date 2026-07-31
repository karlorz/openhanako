import { describe, expect, it } from "vitest";
import {
  isMarketplaceSkillDisabled,
  migrateLegacyMarketplaceSkillOverrides,
  normalizeMarketplaceSkillOverrides,
  packagePreferenceRefFromLegacySkillRef,
  removeMarketplaceSkillPackagePreference,
  setMarketplaceSkillPreference,
} from "../lib/marketplace-skill-preferences.ts";

describe("marketplace skill preferences", () => {
  const wiki = "skillwiki@llm-wiki";
  const other = "skillwiki@other-marketplace";

  it("defaults to enabled when a package has no override", () => {
    expect(isMarketplaceSkillDisabled(undefined, wiki, "wiki-query")).toBe(false);
    expect(isMarketplaceSkillDisabled({ [wiki]: { disabled: ["other-skill"] } }, wiki, "wiki-query")).toBe(false);
  });

  it("isolates the same skill name by source-qualified package identity", () => {
    const raw = {
      [wiki]: { disabled: ["wiki-query"] },
      [other]: { disabled: ["wiki-query"] },
    };
    expect(isMarketplaceSkillDisabled(raw, wiki, "wiki-query")).toBe(true);
    expect(isMarketplaceSkillDisabled(raw, other, "wiki-query")).toBe(true);
    expect(isMarketplaceSkillDisabled(raw, wiki, "other-skill")).toBe(false);
  });

  it("updates one skill while preserving sibling package entries", () => {
    const raw = {
      [wiki]: { disabled: ["wiki-query", "wiki-audit"] },
      [other]: { disabled: ["wiki-query"] },
    };
    const enabled = setMarketplaceSkillPreference(raw, wiki, "wiki-query", true);
    expect(enabled).toEqual({
      [other]: { disabled: ["wiki-query"] },
      [wiki]: { disabled: ["wiki-audit"] },
    });

    const disabled = setMarketplaceSkillPreference(enabled, wiki, "wiki-distill", false);
    expect(disabled).toEqual({
      [other]: { disabled: ["wiki-query"] },
      [wiki]: { disabled: ["wiki-audit", "wiki-distill"] },
    });
  });

  it("removes handled skills selectively and the whole package on complete uninstall", () => {
    const raw = {
      [wiki]: { disabled: ["wiki-query", "wiki-sync"] },
      [other]: { disabled: ["wiki-query"] },
    };
    expect(removeMarketplaceSkillPackagePreference(raw, wiki, ["wiki-query"])).toEqual({
      [other]: { disabled: ["wiki-query"] },
      [wiki]: { disabled: ["wiki-sync"] },
    });
    expect(removeMarketplaceSkillPackagePreference(raw, wiki)).toEqual({
      [other]: { disabled: ["wiki-query"] },
    });
  });

  it("normalizes duplicates, retains tombstones, and reports malformed entries", () => {
    const result = normalizeMarketplaceSkillOverrides({
      [wiki]: { disabled: ["wiki-query", " wiki-query ", "removed-skill"] },
      "not-qualified": { disabled: ["ignored"] },
      [other]: { disabled: ["bad name", 42, "valid-skill"] },
    });
    expect(result.overrides).toEqual({
      [other]: { disabled: ["valid-skill"] },
      [wiki]: { disabled: ["removed-skill", "wiki-query"] },
    });
    expect(result.diagnostics.map((item) => item.path)).toEqual([
      `skills.marketplace_overrides.${other}.disabled[0]`,
      `skills.marketplace_overrides.${other}.disabled[1]`,
      "skills.marketplace_overrides.not-qualified",
    ].sort((a, b) => a.localeCompare(b)));
  });

  it("parses legacy qualified skill refs into package identity and skill name", () => {
    expect(packagePreferenceRefFromLegacySkillRef("wiki-query@llm-wiki/skillwiki")).toEqual({
      identity: wiki,
      skillName: "wiki-query",
    });
    expect(packagePreferenceRefFromLegacySkillRef("wiki-query")).toBeNull();
  });

  it("migrates only explicit disabled records for the installed package owner", () => {
    const agent = {
      id: "agent-a",
      config: { skills: { marketplace_overrides: { [wiki]: { disabled: ["already-off"] } } } },
      updateConfig: (partial: any) => {
        agent.config.skills.marketplace_overrides = partial.skills.marketplace_overrides;
      },
    };
    const diagnostics: any[] = [];
    const membership = new Map([
      ["wiki-query", { identity: wiki }],
      ["native-name", { identity: "native@other-marketplace" }],
    ]);
    const legacyByAgent = {
      "agent-a": {
        "wiki-query@llm-wiki/skillwiki": { enabled: false },
        "already-off@llm-wiki/skillwiki": false,
        "wiki-ingest@llm-wiki/skillwiki": { enabled: true },
        "native-name@llm-wiki/skillwiki": false,
        malformed: false,
      },
    };

    const migrated = migrateLegacyMarketplaceSkillOverrides({
      agents: [agent],
      legacyByAgent,
      membership,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(migrated).toBe(1);
    expect(agent.config.skills.marketplace_overrides).toEqual({
      [wiki]: { disabled: ["already-off", "wiki-query"] },
    });
    expect(diagnostics).toHaveLength(1);

    expect(migrateLegacyMarketplaceSkillOverrides({
      agents: [agent],
      legacyByAgent,
      membership,
    })).toBe(0);
  });

  it("reports persistence failures without throwing", () => {
    const diagnostics: any[] = [];
    expect(() => migrateLegacyMarketplaceSkillOverrides({
      agents: [{
        id: "agent-a",
        config: { skills: {} },
        updateConfig: () => { throw new Error("read-only"); },
      }],
      legacyByAgent: { "agent-a": { "wiki-query@llm-wiki/skillwiki": false } },
      membership: new Map([["wiki-query", { identity: wiki }]]),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })).not.toThrow();
    expect(diagnostics[0]?.message).toContain("read-only");
  });
});
