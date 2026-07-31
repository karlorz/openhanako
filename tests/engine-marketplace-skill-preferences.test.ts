import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../core/engine.ts";
import {
  writeClaudeSkillsInstallRecord,
} from "../lib/plugin-marketplace-claude-skills.ts";

function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`, "utf8");
}

describe("HanaEngine marketplace skill package wiring", () => {
  it("migrates known legacy opt-outs and exposes source-qualified package gate state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-engine-marketplace-skills-"));
    try {
      const skillsDir = path.join(home, "skills");
      writeSkill(path.join(skillsDir, "wiki-query"), "wiki-query");
      writeClaudeSkillsInstallRecord(home, {
        kind: "claude-skills",
        marketplaceId: "llm-wiki",
        pluginId: "skillwiki",
        packagePath: "packages/skills",
        resolvedRevision: "abc",
        skills: ["wiki-query"],
        installedAt: "2026-07-31T00:00:00.000Z",
      });

      const agent = {
        id: "agent-a",
        config: { skills: { enabled: [] } },
        updateConfig: vi.fn(),
      };
      const activations = {
        agentSkillOverrides: {
          "agent-a": {
            "wiki-query@llm-wiki/skillwiki": { enabled: false },
          },
        },
      };
      const service = {
        registry: {
          getControlPlaneActivations: () => activations,
          listSources: () => [{ id: "llm-wiki", enabled: true }],
        },
      };
      const setResolver = vi.fn();
      const engine: any = Object.create(HanaEngine.prototype);
      engine.hanakoHome = home;
      engine.pluginMarketplaceService = service;
      engine._skills = { skillsDir, setMarketplaceSkillPackageGateResolver: setResolver };
      engine._agentMgr = { agents: new Map([[agent.id, agent]]) };
      engine._ensurePluginMarketplaceService = () => service;

      engine._wireMarketplaceSkillPackageGate();

      expect(agent.updateConfig).toHaveBeenCalledWith({
        skills: {
          marketplace_overrides: {
            "skillwiki@llm-wiki": { disabled: ["wiki-query"] },
          },
        },
      });
      const resolver = setResolver.mock.calls[0][0];
      expect(resolver("wiki-query")).toEqual({
        identity: "skillwiki@llm-wiki",
        skillName: "wiki-query",
        enabled: true,
        state: "enabled",
        reason: null,
      });
      expect(resolver("ordinary")).toEqual({ enabled: true, reason: null });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
