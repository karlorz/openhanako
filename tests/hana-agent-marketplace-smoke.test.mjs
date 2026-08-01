import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertContainedCleanupTarget,
  assertLifecycleTrace,
  assertPersistedSessionEvidence,
  branchHasFinalAssistantResponse,
  buildLifecyclePrompt,
  extractMarketplaceTrace,
  fixtureSpec,
  redactSecrets,
  writeMarketplaceFixture,
} from "../scripts/hana-agent-marketplace-smoke.mjs";

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-market-smoke-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("hana Agent Marketplace smoke helpers", () => {
  it("writes a minimal source-qualified local Claude fixture and refuses collisions", () => {
    const root = tempDir();
    const spec = fixtureSpec("auto");
    const sourceDir = writeMarketplaceFixture(root, spec);
    expect(JSON.parse(fs.readFileSync(path.join(sourceDir, ".claude-plugin", "marketplace.json"), "utf8")))
      .toMatchObject({ plugins: [{ name: spec.pluginId, source: "./packages/skills" }] });
    expect(fs.readFileSync(path.join(sourceDir, "packages", "skills", spec.skillName, "SKILL.md"), "utf8"))
      .toContain(`name: ${spec.skillName}`);
    expect(() => writeMarketplaceFixture(root, spec)).toThrow(/already exists/i);
  });

  it("builds a no-bypass prompt for the exact lifecycle", () => {
    const prompt = buildLifecyclePrompt(fixtureSpec("operate"));
    expect(prompt).toContain("Use only the plugin_marketplace tool");
    expect(prompt).toContain("set_source_enabled false using expectedRevision and expectedDigest");
    expect(prompt).toContain("set_package_enabled false using the latest expectedRevision and expectedDigest");
    expect(prompt).toContain("The user explicitly authorizes only the exact disposable source and package lifecycle");
    expect(prompt).toContain("Never bypass review or change permission mode");
  });

  it("extracts current-branch tool calls and pairs results by call id", () => {
    const branch = [{
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "plugin_marketplace", arguments: { action: "list_sources" } }],
      },
    }, {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        isError: false,
        details: { confirmation: { status: "approved" } },
        content: [{ type: "text", text: "ok" }],
      },
    }];
    expect(extractMarketplaceTrace(branch)).toEqual([expect.objectContaining({
      action: "list_sources",
      success: true,
      confirmation: { status: "approved" },
    })]);
  });

  it("distinguishes intermediate tool turns from the final assistant response", () => {
    const toolTurn = [{
      type: "message",
      message: { role: "assistant", stopReason: "toolUse", content: [] },
    }];
    expect(branchHasFinalAssistantResponse(toolTurn)).toBe(false);
    expect(branchHasFinalAssistantResponse([...toolTurn, {
      type: "message",
      message: { role: "toolResult", content: [] },
    }, {
      type: "message",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    }])).toBe(true);
  });

  it("rejects any non-marketplace tool call instead of hiding it from smoke evidence", () => {
    const branch = [{
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } }],
      },
    }];
    const trace = extractMarketplaceTrace(branch);
    expect(trace).toEqual([expect.objectContaining({ name: "bash", action: null })]);
    expect(() => assertLifecycleTrace(trace, "operate")).toThrow(/forbidden tool calls.*bash/i);
  });

  it("validates ordered lifecycle and records the enforced permission path", () => {
    const actions = [
      "list_sources", "add_source", "refresh_source", "set_source_enabled", "set_source_enabled",
      "list_catalog", "inspect_package", "plan_install", "install", "list_installed_packages",
      "set_package_enabled", "set_package_enabled", "plan_uninstall", "uninstall", "remove_source",
    ];
    const autoTrace = actions.map((action) => ({
      name: "plugin_marketplace",
      action,
      result: {},
      success: true,
      confirmation: null,
    }));
    expect(assertLifecycleTrace(autoTrace, "auto")).toEqual({
      kind: "automatic-review-enforced",
      successfulReviewedMutations: [
        "add_source", "refresh_source", "set_source_enabled", "set_source_enabled", "install",
        "set_package_enabled", "set_package_enabled", "uninstall", "remove_source",
      ],
    });
    expect(assertLifecycleTrace(autoTrace, "operate")).toEqual(expect.objectContaining({
      kind: "full-session-access",
    }));

    const deniedTrace = autoTrace.map((call) => ({ ...call }));
    deniedTrace[1] = {
      ...deniedTrace[1],
      success: false,
      result: { isError: true, details: { errorCode: "TOOL_APPROVAL_DENIED" } },
      confirmation: { status: "denied" },
    };
    expect(() => assertLifecycleTrace(deniedTrace, "auto")).toThrow(/failures.*add_source/i);

    const missingResultTrace = autoTrace.map((call) => ({ ...call }));
    missingResultTrace[1] = { ...missingResultTrace[1], result: null, success: false };
    expect(() => assertLifecycleTrace(missingResultTrace, "auto")).toThrow(/missing results.*add_source/i);
  });

  it("requires the persisted detached-session permission scope", () => {
    const roots = ["/tmp/hana-marketplaces", "/tmp/hana-skills"];
    expect(assertPersistedSessionEvidence({
      permissionMode: "auto",
      accessMode: "operate",
      authorizedFolders: roots,
      workspaceFolders: [],
    }, "auto", roots)).toEqual({
      permissionMode: "auto",
      accessMode: "operate",
      authorizedFolders: [...roots].sort(),
    });
    expect(() => assertPersistedSessionEvidence({
      permissionMode: "operate",
      accessMode: "operate",
      authorizedFolders: roots,
      workspaceFolders: [],
    }, "auto", roots)).toThrow(/permission mode mismatch/i);
    expect(() => assertPersistedSessionEvidence({
      permissionMode: "auto",
      accessMode: "operate",
      authorizedFolders: [roots[0]],
      workspaceFolders: [],
    }, "auto", roots)).toThrow(/authorized folders mismatch/i);
  });

  it("rejects broad cleanup targets and redacts credentials", () => {
    const root = tempDir();
    expect(() => assertContainedCleanupTarget(root, root)).toThrow(/unsafe/i);
    expect(() => assertContainedCleanupTarget(root, path.join(root, "..", "outside"))).toThrow(/unsafe/i);
    expect(assertContainedCleanupTarget(root, path.join(root, "exact-fixture"))).toBe(path.join(root, "exact-fixture"));
    expect(redactSecrets("Authorization: Bearer abc123 token=abc123", ["abc123"]))
      .not.toContain("abc123");
  });
});
