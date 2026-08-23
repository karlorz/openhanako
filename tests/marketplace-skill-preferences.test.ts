import { describe, expect, it, vi } from "vitest";
import {
  isMarketplaceSkillDisabled,
  migrateLegacyMarketplaceSkillOverrides,
  normalizeMarketplaceLegacySkillMigrations,
  normalizeMarketplaceSkillOverrides,
  packagePreferenceRefFromLegacySkillRef,
  removeMarketplaceLegacySkillMigrationPackage,
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
    const agent: any = {
      id: "agent-a",
      config: { skills: { marketplace_overrides: { [wiki]: { disabled: ["already-off"] } } } },
      updateConfig: (partial: any) => {
        agent.config.skills = { ...agent.config.skills, ...partial.skills };
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
    expect(migrated.configWrites).toBe(1);
    expect(migrated.retirementCandidates).toEqual([
      { agentId: "agent-a", legacyRef: "wiki-query@llm-wiki/skillwiki" },
    ]);
    expect(agent.config.skills.marketplace_overrides).toEqual({
      [wiki]: { disabled: ["already-off", "wiki-query"] },
    });
    expect(agent.config.skills.marketplace_legacy_skill_migrations).toEqual({
      "wiki-query@llm-wiki/skillwiki": true,
    });
    expect(diagnostics).toHaveLength(1);

    expect(migrateLegacyMarketplaceSkillOverrides({
      agents: [agent],
      legacyByAgent,
      membership,
    }).configWrites).toBe(0);
  });

  it("reports persistence failures without throwing", () => {
    const diagnostics: any[] = [];
    const result = migrateLegacyMarketplaceSkillOverrides({
      agents: [{
        id: "agent-a",
        config: { skills: {} },
        updateConfig: () => { throw new Error("read-only"); },
      }],
      legacyByAgent: { "agent-a": { "wiki-query@llm-wiki/skillwiki": false } },
      membership: new Map([["wiki-query", { identity: wiki }]]),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(result).toEqual({ configWrites: 0, retirementCandidates: [] });
    expect(diagnostics[0]?.message).toContain("read-only");
  });

  // --- Blocker A regression tests ---

  it("persists completion metadata and does not re-add a tombstone after enable -> reload", () => {
    const agent: any = {
      id: "agent-a",
      config: { skills: {} },
      updateConfig: (partial: any) => {
        agent.config.skills = { ...agent.config.skills, ...partial.skills };
      },
    };
    const membership = new Map([["wiki-query", { identity: wiki }]]);
    const legacyByAgent = {
      "agent-a": { "wiki-query@llm-wiki/skillwiki": false },
    };

    const result1 = migrateLegacyMarketplaceSkillOverrides({
      agents: [agent],
      legacyByAgent,
      membership,
    });

    expect(result1.configWrites).toBe(1);
    expect(result1.retirementCandidates).toEqual([
      { agentId: "agent-a", legacyRef: "wiki-query@llm-wiki/skillwiki" },
    ]);
    expect(agent.config.skills.marketplace_overrides).toEqual({
      [wiki]: { disabled: ["wiki-query"] },
    });
    expect(agent.config.skills.marketplace_legacy_skill_migrations).toEqual({
      "wiki-query@llm-wiki/skillwiki": true,
    });

    agent.config.skills.marketplace_overrides = setMarketplaceSkillPreference(
      agent.config.skills.marketplace_overrides,
      wiki,
      "wiki-query",
      true,
    );

    const result2 = migrateLegacyMarketplaceSkillOverrides({
      agents: [agent],
      legacyByAgent,
      membership,
    });

    expect(result2.configWrites).toBe(0);
    expect(result2.retirementCandidates).toEqual([
      { agentId: "agent-a", legacyRef: "wiki-query@llm-wiki/skillwiki" },
    ]);
    expect(agent.config.skills.marketplace_overrides).toEqual({});
  });

  it("persists missing completion metadata for an existing tombstone before retirement", () => {
    const updateConfig = vi.fn();
    const agent: any = {
      id: "agent-a",
      config: {
        skills: {
          marketplace_overrides: { [wiki]: { disabled: ["wiki-query"] } },
        },
      },
      updateConfig,
    };
    const membership = new Map([["wiki-query", { identity: wiki }]]);
    const legacyByAgent = {
      "agent-a": { "wiki-query@llm-wiki/skillwiki": false },
    };
    const result = migrateLegacyMarketplaceSkillOverrides({
      agents: [agent],
      legacyByAgent,
      membership,
    });

    expect(result.configWrites).toBe(1);
    expect(updateConfig).toHaveBeenCalledWith({
      skills: {
        marketplace_overrides: { [wiki]: { disabled: ["wiki-query"] } },
        marketplace_legacy_skill_migrations: {
          "wiki-query@llm-wiki/skillwiki": true,
        },
      },
    });
    expect(result.retirementCandidates).toEqual([
      { agentId: "agent-a", legacyRef: "wiki-query@llm-wiki/skillwiki" },
    ]);
  });

  it("preserves sibling legacy records when one agent's config persistence fails", () => {
    // Agent-a fails to persist; agent-b succeeds. The successful agent's
    // legacy records should be retired, while agent-a's should NOT be retired
    // (so the migration can retry on the next pass).
    const agentA: any = {
      id: "agent-a",
      config: { skills: {} },
      updateConfig: () => { throw new Error("read-only"); },
    };
    const agentB: any = {
      id: "agent-b",
      config: { skills: {} },
      updateConfig: (partial: any) => {
        agentB.config.skills = { ...agentB.config.skills, ...partial.skills };
      },
    };
    const membership = new Map([
      ["wiki-query", { identity: wiki }],
      ["wiki-sync", { identity: wiki }],
    ]);
    const legacyByAgent = {
      "agent-a": { "wiki-query@llm-wiki/skillwiki": false },
      "agent-b": { "wiki-sync@llm-wiki/skillwiki": false },
    };
    const diagnostics: any[] = [];

    const result = migrateLegacyMarketplaceSkillOverrides({
      agents: [agentA, agentB],
      legacyByAgent,
      membership,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    // Agent-a failed; agent-b succeeded.
    expect(result.configWrites).toBe(1);
    expect(diagnostics[0]?.message).toContain("read-only");
    expect(result.retirementCandidates).toEqual([
      { agentId: "agent-b", legacyRef: "wiki-sync@llm-wiki/skillwiki" },
    ]);
  });

  it("records obsolete migrated markers as completion metadata without restoring a tombstone", () => {
    const agent: any = {
      id: "agent-a",
      config: { skills: {} },
      updateConfig: (partial: any) => {
        agent.config.skills = { ...agent.config.skills, ...partial.skills };
      },
    };

    const result = migrateLegacyMarketplaceSkillOverrides({
      agents: [agent],
      legacyByAgent: {
        "agent-a": {
          "wiki-query@llm-wiki/skillwiki": { enabled: false, migrated: true },
        },
      },
      membership: new Map([["wiki-query", { identity: wiki }]]),
    });

    expect(result).toEqual({
      configWrites: 1,
      retirementCandidates: [{ agentId: "agent-a", legacyRef: "wiki-query@llm-wiki/skillwiki" }],
    });
    expect(agent.config.skills.marketplace_overrides).toEqual({});
    expect(agent.config.skills.marketplace_legacy_skill_migrations).toEqual({
      "wiki-query@llm-wiki/skillwiki": true,
    });
  });

  it("normalizes and removes package-scoped completion metadata", () => {
    expect(normalizeMarketplaceLegacySkillMigrations({
      "other@llm-wiki/skillwiki": true,
      "wiki-query@llm-wiki/skillwiki": true,
      "not-qualified": true,
      "wiki-sync@llm-wiki/skillwiki": false,
    })).toEqual({
      "other@llm-wiki/skillwiki": true,
      "wiki-query@llm-wiki/skillwiki": true,
    });
    expect(removeMarketplaceLegacySkillMigrationPackage({
      "wiki-query@llm-wiki/skillwiki": true,
      "other@llm-wiki/skillwiki": true,
      "search@team/demo": true,
    }, wiki)).toEqual({
      "search@team/demo": true,
    });
    expect(removeMarketplaceLegacySkillMigrationPackage({}, wiki)).toBeNull();
  });
});
