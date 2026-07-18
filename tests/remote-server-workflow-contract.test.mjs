import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("remote server workflow contract", () => {
  it("keeps refresh attended and generic prep integration honest", () => {
    const config = fs.readFileSync(".claude/dev-loop.config.md", "utf8");
    expect(config).toContain("generic_dev_loop_hook_available: false");
    expect(config).toContain("plugin_follow_up_required_for_automatic_prep: true");
    expect(config).toContain("mode: attended-read-only");
    expect(config).toContain("evidence_ttl_seconds: 1800");
    expect(config).toContain("check-remote-prerequisites.mjs");
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
