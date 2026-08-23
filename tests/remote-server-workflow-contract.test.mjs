import { describe, expect, it } from "vitest";
import fs from "node:fs";
import YAML from "yaml";

describe("remote server workflow contract", () => {
  it("keeps remote assessment policy in schema-valid notes", () => {
    const source = fs.readFileSync(".claude/dev-loop.config.md", "utf8");
    const config = YAML.parse(source.match(/```yaml\n([\s\S]*?)\n```/)?.[1] ?? "");
    expect(config.notes.remote_assessment_policy).toBe(
      "Attended read-only evidence lives at .claude/remote-assessment/latest.json (30-minute TTL); use the smoke helper and offline check-remote-prerequisites.mjs flow documented in CONTEXT.md.",
    );
    expect(config).not.toHaveProperty("remote_assessment");
  });

  it("documents the no-network checker boundary and installed-cache prohibition", () => {
    const docs = ["CONTEXT.md", "docs/agents/openhanako-dev-loop-setup.md", "docs/server-install.md"]
      .map((file) => fs.readFileSync(file, "utf8")).join("\n");
    expect(docs).toMatch(/attended[^\n]*refresh/i);
    expect(docs).toMatch(/absent|stale[^\n]*(unknown|checker)/i);
    expect(docs).toMatch(/do not scrape credentials|contact sg01 merely|merely because prep/i);
    expect(docs).toMatch(/installed-cache patch|installed cache/i);
    expect(docs).toMatch(/deployment-coupled/);
  });

  it("keeps the checker read-only and free of remote/runtime authorities", () => {
    const checker = fs.readFileSync("scripts/check-remote-prerequisites.mjs", "utf8");
    expect(checker).not.toMatch(/child_process|\bfetch\s*\(|node:https?|WebSocket|ssh|keychain|localStorage|renderer/i);
    expect(checker).not.toMatch(/writeFile|mkdir|rename|unlink|rmSync|createWriteStream/);
    expect(checker).toContain("fs.readFileSync(workItemPath");
    expect(checker).toContain("fs.readFileSync(pathname");
  });
});
