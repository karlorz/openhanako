import fs from "fs";
import path from "path";
import { assertMarketplaceId, assertPluginId } from "./plugin-marketplace-identity.ts";
import { installSkillPackageFromDirectory } from "./skills/skill-package-installer.ts";

export const CLAUDE_SKILLS_INSTALL_DIR = "plugin-marketplace-claude-skills";

export interface ClaudeSkillsInstallRecord {
  kind: "claude-skills";
  marketplaceId: string;
  pluginId: string;
  packagePath: string;
  resolvedRevision: string | null;
  skills: string[];
  installedAt: string;
}

export interface DiscoverClaudeSkillDirsOptions {
  /** Prefer package plugin.json "skills" field when present (e.g. "./skills/"). */
  preferPluginJson?: boolean;
}

/**
 * Find skill package roots (directories containing SKILL.md) under a Claude plugin package.
 * Avoids double-counting a nested path when an ancestor is already a skill root.
 */
export function discoverClaudeSkillDirs(
  packageRoot: string,
  options: DiscoverClaudeSkillDirsOptions = {},
): string[] {
  if (!packageRoot || !fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
    return [];
  }
  const preferPluginJson = options.preferPluginJson !== false;
  if (preferPluginJson) {
    const fromManifest = skillDirsFromPluginJson(packageRoot);
    if (fromManifest.length > 0) return fromManifest;
  }

  const found: string[] = [];
  walkSkillDirs(packageRoot, packageRoot, found);
  return found.sort((a, b) => a.localeCompare(b));
}

function skillDirsFromPluginJson(packageRoot: string): string[] {
  const candidates = [
    path.join(packageRoot, ".claude-plugin", "plugin.json"),
    path.join(packageRoot, "plugin.json"),
  ];
  for (const manifestPath of candidates) {
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const skillsField = raw?.skills;
      if (typeof skillsField !== "string" || !skillsField.trim()) continue;
      let rel = skillsField.trim();
      while (rel.startsWith("./")) rel = rel.slice(2);
      if (rel.startsWith("/") || rel.includes("..")) continue;
      const skillsRoot = path.join(packageRoot, rel);
      if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) continue;
      // skills field may point at a single skill dir or a container of skills
      if (fs.existsSync(path.join(skillsRoot, "SKILL.md"))) {
        return [skillsRoot];
      }
      const nested: string[] = [];
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const child = path.join(skillsRoot, entry.name);
        if (fs.existsSync(path.join(child, "SKILL.md"))) nested.push(child);
      }
      if (nested.length > 0) return nested.sort((a, b) => a.localeCompare(b));
      // Container without direct children — fall through to walk
      const walked: string[] = [];
      walkSkillDirs(skillsRoot, skillsRoot, walked);
      if (walked.length > 0) return walked.sort((a, b) => a.localeCompare(b));
    } catch {
      // ignore malformed plugin.json
    }
  }
  return [];
}

function walkSkillDirs(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (fs.existsSync(path.join(dir, "SKILL.md"))) {
    out.push(dir);
    // Do not descend into skill package internals
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    // Skip heavy/non-skill trees
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    walkSkillDirs(root, path.join(dir, entry.name), out);
  }
}

export function installClaudeSkillsFromPackage(options: {
  packageRoot: string;
  installDir: string;
  owner?: string;
}): {
  installed: Array<{ name: string; dir: string }>;
  skipped: Array<{ path: string; reason: string }>;
} {
  const packageRoot = path.resolve(options.packageRoot);
  const installDir = path.resolve(options.installDir);
  const owner = options.owner || "user";
  const skillDirs = discoverClaudeSkillDirs(packageRoot);
  const installed: Array<{ name: string; dir: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  if (skillDirs.length === 0) {
    return {
      installed,
      skipped: [{ path: packageRoot, reason: "no SKILL.md packages found" }],
    };
  }

  for (const skillDir of skillDirs) {
    try {
      const result = installSkillPackageFromDirectory({
        sourceDir: skillDir,
        installDir,
        owner,
      });
      installed.push({ name: result.name, dir: result.dir });
    } catch (err: any) {
      skipped.push({
        path: skillDir,
        reason: err?.message || String(err),
      });
    }
  }
  return { installed, skipped };
}

export function claudeSkillsRecordPath(
  hanakoHome: string,
  marketplaceId: string,
  pluginId: string,
): string {
  const mid = assertMarketplaceId(marketplaceId);
  const pid = assertPluginId(pluginId);
  return path.join(hanakoHome, CLAUDE_SKILLS_INSTALL_DIR, mid, `${pid}.json`);
}

export function writeClaudeSkillsInstallRecord(
  hanakoHome: string,
  record: ClaudeSkillsInstallRecord,
): void {
  const filePath = claudeSkillsRecordPath(hanakoHome, record.marketplaceId, record.pluginId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: ClaudeSkillsInstallRecord = {
    kind: "claude-skills",
    marketplaceId: assertMarketplaceId(record.marketplaceId),
    pluginId: assertPluginId(record.pluginId),
    packagePath: record.packagePath,
    resolvedRevision: record.resolvedRevision,
    skills: [...record.skills],
    installedAt: record.installedAt || new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export function readClaudeSkillsInstallRecord(
  hanakoHome: string,
  marketplaceId: string,
  pluginId: string,
): ClaudeSkillsInstallRecord | null {
  const filePath = claudeSkillsRecordPath(hanakoHome, marketplaceId, pluginId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw?.kind !== "claude-skills") return null;
    return raw as ClaudeSkillsInstallRecord;
  } catch {
    return null;
  }
}
