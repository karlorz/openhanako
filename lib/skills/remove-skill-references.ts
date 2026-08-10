import fs from "fs";
import path from "path";
import { loadConfig, saveConfig } from "../memory/config-loader.ts";
import {
  normalizeMarketplaceLegacySkillMigrations,
  removeMarketplaceLegacySkillMigrationPackage,
  removeMarketplaceSkillPackagePreference,
} from "../marketplace-skill-preferences.ts";

export interface RemoveAgentSkillReferencesResult {
  updatedAgents: string[];
  failedAgents: Array<{ agentId: string; error: string }>;
}

export interface RemoveAgentSkillReferencesOptions {
  /** A complete uninstall removes this package's config-owned Marketplace state. */
  marketplacePackageIdentity?: string;
  /** Live agent objects, used to keep in-memory config aligned with disk cleanup. */
  agents?: Iterable<any>;
}

function indexLiveAgents(agents: Iterable<any> | undefined): Map<string, any> {
  const byId = new Map<string, any>();
  if (!agents) return byId;
  for (const agent of agents) {
    if (agent && typeof agent.id === "string") byId.set(agent.id, agent);
  }
  return byId;
}

export function removeAgentSkillReferences(
  agentsDir: string,
  skillNames: Iterable<string>,
  options: RemoveAgentSkillReferencesOptions = {},
): RemoveAgentSkillReferencesResult {
  const names = new Set(skillNames);
  const liveAgents = indexLiveAgents(options.agents);
  const packageIdentity = typeof options.marketplacePackageIdentity === "string"
    ? options.marketplacePackageIdentity.trim()
    : "";
  const updatedAgents: string[] = [];
  const failedAgents: Array<{ agentId: string; error: string }> = [];
  if ((names.size === 0 && !packageIdentity) || !fs.existsSync(agentsDir)) {
    return { updatedAgents, failedAgents };
  }

  for (const agentId of fs.readdirSync(agentsDir)) {
    const configPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = loadConfig(configPath);
      const enabled = config?.skills?.enabled;
      const skillsPatch: Record<string, unknown> = {};
      if (Array.isArray(enabled) && enabled.some((name) => names.has(name))) {
        skillsPatch.enabled = enabled.filter((name) => !names.has(name));
      }

      if (packageIdentity) {
        const nextOverrides = removeMarketplaceSkillPackagePreference(
          config?.skills?.marketplace_overrides,
          packageIdentity,
        );
        if (nextOverrides) {
          // config-loader's existing null-as-delete merge removes this exact
          // package key while preserving sibling package preferences.
          skillsPatch.marketplace_overrides = {
            [packageIdentity]: nextOverrides[packageIdentity] || null,
          };
        }

        const nextMigrations = removeMarketplaceLegacySkillMigrationPackage(
          config?.skills?.marketplace_legacy_skill_migrations,
          packageIdentity,
        );
        if (nextMigrations) {
          const currentMigrations = normalizeMarketplaceLegacySkillMigrations(
            config?.skills?.marketplace_legacy_skill_migrations,
          );
          const removedRefs = Object.keys(currentMigrations)
            .filter((legacyRef) => nextMigrations[legacyRef] !== true);
          if (removedRefs.length > 0) {
            // config-loader deep-merges nested maps, so delete only the exact
            // source-qualified refs owned by the package. Do not replace the
            // map: sibling package completion ledger entries must survive.
            skillsPatch.marketplace_legacy_skill_migrations = Object.fromEntries(
              removedRefs.map((legacyRef) => [legacyRef, null]),
            );
          }
        }
      }

      if (Object.keys(skillsPatch).length === 0) continue;
      const liveAgent = liveAgents.get(agentId);
      if (typeof liveAgent?.updateConfig === "function") {
        // The package route reloads the skill manager after this operation;
        // use the agent's normal config path so its in-memory config and
        // prompt lifecycle stay consistent before that reload.
        liveAgent.updateConfig({ skills: skillsPatch });
      } else {
        saveConfig(configPath, { skills: skillsPatch });
        // Keep simple test adapters and non-runtime callers aligned when
        // they expose a config object but no Agent.updateConfig lifecycle.
        if (liveAgent?.config) {
          liveAgent.config.skills = loadConfig(configPath)?.skills || {};
        }
      }
      updatedAgents.push(agentId);
    } catch (err: any) {
      failedAgents.push({ agentId, error: err?.message || String(err) });
    }
  }
  return { updatedAgents, failedAgents };
}
