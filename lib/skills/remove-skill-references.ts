import fs from "fs";
import path from "path";
import { loadConfig, saveConfig } from "../memory/config-loader.ts";

export interface RemoveAgentSkillReferencesResult {
  updatedAgents: string[];
  failedAgents: Array<{ agentId: string; error: string }>;
}

export function removeAgentSkillReferences(
  agentsDir: string,
  skillNames: Iterable<string>,
): RemoveAgentSkillReferencesResult {
  const names = new Set(skillNames);
  const updatedAgents: string[] = [];
  const failedAgents: Array<{ agentId: string; error: string }> = [];
  if (names.size === 0 || !fs.existsSync(agentsDir)) return { updatedAgents, failedAgents };

  for (const agentId of fs.readdirSync(agentsDir)) {
    const configPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = loadConfig(configPath);
      const enabled = config?.skills?.enabled;
      if (!Array.isArray(enabled) || !enabled.some((name) => names.has(name))) continue;
      saveConfig(configPath, {
        skills: { enabled: enabled.filter((name) => !names.has(name)) },
      });
      updatedAgents.push(agentId);
    } catch (err: any) {
      failedAgents.push({ agentId, error: err?.message || String(err) });
    }
  }
  return { updatedAgents, failedAgents };
}
