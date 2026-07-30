import fs from "fs";
import path from "path";
import { assertMarketplaceId, assertPluginId } from "./plugin-marketplace-identity.ts";
import {
  assertInstallTargetInsideRoot,
  installSkillPackageFromDirectory,
  sanitizeSkillName,
} from "./skills/skill-package-installer.ts";

export const CLAUDE_SKILLS_INSTALL_DIR = "plugin-marketplace-claude-skills";

/** Claude plugin.json fields Hana does not install in the skills-lane v1. */
export const CLAUDE_UNSUPPORTED_COMPONENT_FIELDS = [
  "agents",
  "commands",
  "hooks",
  "mcpServers",
  "mcp",
  "lsp",
  "monitors",
  "workflows",
  "outputStyles",
  "settings",
] as const;

export interface ClaudeSkillsInstallRecord {
  kind: "claude-skills";
  marketplaceId: string;
  pluginId: string;
  packagePath: string;
  resolvedRevision: string | null;
  skills: string[];
  warnings?: string[];
  installedAt: string;
}

export type ClaudeSkillsInstallState = "not-installed" | "installed" | "partial" | "stale-record";

export interface ReconciledClaudeSkillsInstall {
  state: ClaudeSkillsInstallState;
  recorded: string[];
  present: string[];
  missing: string[];
  invalid: string[];
}

export interface ClaudeSkillsUninstallResult extends ReconciledClaudeSkillsInstall {
  marketplaceId: string;
  pluginId: string;
  complete: boolean;
  deleted: string[];
  alreadyMissing: string[];
  failed: Array<{ name: string; error: string }>;
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
  conflictPolicy?: "preserve" | "replace";
}): {
  installed: Array<{ name: string; dir: string }>;
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
} {
  const packageRoot = path.resolve(options.packageRoot);
  const installDir = path.resolve(options.installDir);
  const owner = options.owner || "user";
  const conflictPolicy = options.conflictPolicy || "preserve";
  const skillDirs = discoverClaudeSkillDirs(packageRoot);
  const installed: Array<{ name: string; dir: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const warnings = inspectClaudePackageWarnings(packageRoot);

  if (skillDirs.length === 0) {
    return {
      installed,
      skipped: [{ path: packageRoot, reason: "no SKILL.md packages found" }],
      warnings,
    };
  }

  for (const skillDir of skillDirs) {
    try {
      const result = installSkillPackageFromDirectory({
        sourceDir: skillDir,
        installDir,
        owner,
        conflictPolicy,
      });
      installed.push({ name: result.name, dir: result.dir });
    } catch (err: any) {
      skipped.push({
        path: skillDir,
        reason: err?.message || String(err),
      });
    }
  }
  return { installed, skipped, warnings };
}

function readJsonFile(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return Boolean(value);
}

export function inspectClaudePackageWarnings(packageRoot: string): string[] {
  const warnings: string[] = [];
  const pluginJson = readJsonFile(path.join(packageRoot, ".claude-plugin", "plugin.json"))
    || readJsonFile(path.join(packageRoot, "plugin.json"));
  if (pluginJson && typeof pluginJson === "object") {
    for (const field of CLAUDE_UNSUPPORTED_COMPONENT_FIELDS) {
      if (hasValue(pluginJson[field])) {
        warnings.push(`unsupported Claude component not installed: ${field}`);
      }
    }
  }

  const packageJson = readJsonFile(path.join(packageRoot, "package.json"));
  if (packageJson && typeof packageJson === "object") {
    if (hasValue(packageJson.bin)) {
      warnings.push("package declares external CLI binaries; Hana does not install or execute them");
    }
    if (hasValue(packageJson.scripts)) {
      warnings.push("package declares npm scripts; Hana does not run package lifecycle or helper scripts");
    }
    if (hasValue(packageJson.dependencies) || hasValue(packageJson.devDependencies)) {
      warnings.push("package declares npm dependencies; Hana imports skills without running package installation");
    }
  }

  if (fs.existsSync(path.join(packageRoot, "scripts"))) {
    warnings.push("package contains scripts/ resources outside imported skills; Hana does not execute them");
  }

  return [...new Set(warnings)];
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
    ...(Array.isArray(record.warnings) && record.warnings.length > 0 ? { warnings: [...record.warnings] } : {}),
    installedAt: record.installedAt || new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export function readClaudeSkillsInstallRecord(
  hanakoHome: string,
  marketplaceId: string,
  pluginId: string,
): ClaudeSkillsInstallRecord | null {
  const expectedMarketplaceId = assertMarketplaceId(marketplaceId);
  const expectedPluginId = assertPluginId(pluginId);
  const filePath = claudeSkillsRecordPath(hanakoHome, expectedMarketplaceId, expectedPluginId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw?.kind !== "claude-skills") return null;
    if (raw.marketplaceId !== expectedMarketplaceId || raw.pluginId !== expectedPluginId) return null;
    if (!Array.isArray(raw.skills) || raw.skills.some((name: unknown) => typeof name !== "string")) return null;
    return raw as ClaudeSkillsInstallRecord;
  } catch {
    return null;
  }
}

export function listClaudeSkillsInstallRecords(hanakoHome: string): ClaudeSkillsInstallRecord[] {
  const root = path.join(hanakoHome, CLAUDE_SKILLS_INSTALL_DIR);
  if (!fs.existsSync(root)) return [];
  const out: ClaudeSkillsInstallRecord[] = [];
  for (const source of fs.readdirSync(root, { withFileTypes: true })) {
    if (!source.isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(root, source.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const pluginId = file.name.slice(0, -".json".length);
      let record: ClaudeSkillsInstallRecord | null = null;
      try {
        record = readClaudeSkillsInstallRecord(hanakoHome, source.name, pluginId);
      } catch {
        // Ignore malformed filesystem entries outside the strict marketplace identity grammar.
      }
      if (record) out.push(record);
    }
  }
  return out.sort((a, b) =>
    a.marketplaceId.localeCompare(b.marketplaceId)
    || a.pluginId.localeCompare(b.pluginId)
  );
}

function normalizedRecordedSkills(record: ClaudeSkillsInstallRecord): string[] {
  return [...new Set(record.skills)];
}

function resolveRecordedSkillPath(userSkillsDir: string, skillName: string): string | null {
  const normalized = sanitizeSkillName(skillName);
  if (!normalized || normalized !== skillName) return null;
  const root = path.resolve(userSkillsDir);
  const candidate = path.resolve(root, normalized);
  try {
    assertInstallTargetInsideRoot(candidate, root);
    return candidate;
  } catch {
    return null;
  }
}

export function reconcileClaudeSkillsInstall(
  record: ClaudeSkillsInstallRecord | null,
  userSkillsDir: string,
): ReconciledClaudeSkillsInstall {
  if (!record) {
    return { state: "not-installed", recorded: [], present: [], missing: [], invalid: [] };
  }

  const recorded = normalizedRecordedSkills(record);
  const present: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const skillName of recorded) {
    const skillPath = resolveRecordedSkillPath(userSkillsDir, skillName);
    if (!skillPath) invalid.push(skillName);
    else if (fs.existsSync(skillPath)) present.push(skillName);
    else missing.push(skillName);
  }

  const state: ClaudeSkillsInstallState = recorded.length > 0
    && present.length === recorded.length
    && invalid.length === 0
    ? "installed"
    : present.length > 0
      ? "partial"
      : "stale-record";
  return { state, recorded, present, missing, invalid };
}

export function reconcileClaudeSkillsInstallRecord(
  hanakoHome: string,
  marketplaceId: string,
  pluginId: string,
  userSkillsDir = path.join(hanakoHome, "skills"),
): ReconciledClaudeSkillsInstall {
  const record = readClaudeSkillsInstallRecord(hanakoHome, marketplaceId, pluginId);
  return reconcileClaudeSkillsInstall(record, userSkillsDir);
}

export function removeClaudeSkillsInstallRecord(
  hanakoHome: string,
  marketplaceId: string,
  pluginId: string,
): void {
  const filePath = claudeSkillsRecordPath(hanakoHome, marketplaceId, pluginId);
  fs.rmSync(filePath, { force: true });
  const sourceDir = path.dirname(filePath);
  try {
    if (fs.readdirSync(sourceDir).length === 0) fs.rmdirSync(sourceDir);
  } catch {
    // The source directory may already be absent or may contain other package records.
  }
}

export function uninstallClaudeSkillsInstallRecord(options: {
  hanakoHome: string;
  marketplaceId: string;
  pluginId: string;
  userSkillsDir?: string;
  removeDir?: (dir: string) => void;
}): ClaudeSkillsUninstallResult | null {
  const marketplaceId = assertMarketplaceId(options.marketplaceId);
  const pluginId = assertPluginId(options.pluginId);
  const record = readClaudeSkillsInstallRecord(options.hanakoHome, marketplaceId, pluginId);
  if (!record) return null;

  const userSkillsDir = options.userSkillsDir || path.join(options.hanakoHome, "skills");
  const before = reconcileClaudeSkillsInstallRecord(
    options.hanakoHome,
    marketplaceId,
    pluginId,
    userSkillsDir,
  );
  const removeDir = options.removeDir || ((dir: string) => fs.rmSync(dir, { recursive: true, force: true }));
  const deleted: string[] = [];
  const alreadyMissing: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const skillName of before.recorded) {
    const skillPath = resolveRecordedSkillPath(userSkillsDir, skillName);
    if (!skillPath) {
      failed.push({ name: skillName, error: "invalid recorded skill name" });
      continue;
    }
    if (!fs.existsSync(skillPath)) {
      alreadyMissing.push(skillName);
      continue;
    }
    try {
      removeDir(skillPath);
      if (fs.existsSync(skillPath)) {
        failed.push({ name: skillName, error: "skill directory still exists after removal" });
      } else {
        deleted.push(skillName);
      }
    } catch (err: any) {
      failed.push({ name: skillName, error: err?.message || String(err) });
    }
  }

  const unresolved = failed.map((item) => item.name);
  if (unresolved.length === 0) {
    removeClaudeSkillsInstallRecord(options.hanakoHome, marketplaceId, pluginId);
  } else {
    writeClaudeSkillsInstallRecord(options.hanakoHome, {
      ...record,
      marketplaceId,
      pluginId,
      skills: unresolved,
    });
  }

  return {
    marketplaceId,
    pluginId,
    state: before.state,
    recorded: before.recorded,
    present: before.present,
    missing: before.missing,
    invalid: before.invalid,
    complete: failed.length === 0,
    deleted,
    alreadyMissing,
    failed,
  };
}
