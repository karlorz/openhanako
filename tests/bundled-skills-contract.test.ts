import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SkillManager } from "../core/skill-manager.ts";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.ts";

const root = path.resolve(import.meta.dirname, "..");
const skillDir = path.join(root, "skills2set", "marketplace-manager");
const skillFile = path.join(skillDir, "SKILL.md");
const referenceNames = [
  "claude-skill-packages.md",
  "native-hana-plugins.md",
  "troubleshooting.md",
];
const approvedDescription = "Manage Hana Marketplace sources and Claude-compatible skill packages, including installation, package enable or disable, per-Agent skill routing, uninstall, and troubleshooting. Use for Marketplace source or package operations and when distinguishing Hana skill packages from native PluginManager plugins; route native plugin authoring to hana-plugin-creator.";

function readRequiredFile(filePath: string) {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(`${path.relative(root, filePath)} should exist`, { cause: error });
  }
  expect(content.trim(), `${path.relative(root, filePath)} should not be empty`).not.toBe("");
  return content;
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  expect(match, "SKILL.md should contain YAML frontmatter").not.toBeNull();
  return YAML.load(match![1]) as Record<string, unknown>;
}

describe("bundled marketplace-manager skill contract", () => {
  it("ships only the approved compact skill and three direct references", () => {
    const core = readRequiredFile(skillFile);
    const referencesDir = path.join(skillDir, "references");

    expect(fs.readdirSync(skillDir).sort()).toEqual(["SKILL.md", "references"]);
    expect(fs.readdirSync(referencesDir).sort()).toEqual([...referenceNames].sort());
    expect(core.split(/\r?\n/).length).toBeLessThanOrEqual(150);

    for (const referenceName of referenceNames) {
      const reference = readRequiredFile(path.join(referencesDir, referenceName));
      expect(core).toContain(`references/${referenceName}`);
      for (const otherReference of referenceNames) {
        expect(reference).not.toContain(`references/${otherReference}`);
        expect(reference).not.toContain(`./${otherReference}`);
      }
    }
  });

  it("uses the stable two-field metadata contract and defaults on for new Agents", () => {
    const content = readRequiredFile(skillFile);
    const frontmatter = parseFrontmatter(content);
    const metadata = parseSkillMetadata(content, "fallback");

    expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
    expect(metadata).toMatchObject({
      name: "marketplace-manager",
      description: approvedDescription,
      disableModelInvocation: false,
      defaultEnabled: true,
    });
    expect(approvedDescription.trim().split(/\s+/)).toHaveLength(43);

    const loaded = loadSkillsFromDir({ dir: skillDir, source: "bundled" });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0]).toMatchObject({
      name: "marketplace-manager",
      description: approvedDescription,
      filePath: skillFile,
    });

    const manager = new SkillManager({ skillsDir: path.join(root, "skills2set") });
    manager.init({ getSkills: () => loaded }, new Map(), new Set());
    const managerSkill = manager.allSkills.find(skill => skill.name === "marketplace-manager");
    expect(managerSkill?._hidden).toBe(false);
    expect(manager.computeDefaultEnabledForNewAgent()).toContain("marketplace-manager");
  });
});
