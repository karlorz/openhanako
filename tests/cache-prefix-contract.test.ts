import { describe, expect, it } from "vitest";
import {
  buildLlmContextCachePrefixContract,
  diffCachePrefixContracts,
} from "../lib/llm/cache-prefix-contract.ts";
import { makeMigrationSession } from "./helpers/migration-session.ts";

function tool(name, description = "desc") {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
    execute: () => {},
  };
}

async function snapshotSession({ tools }) {
  const migration = makeMigrationSession();
  const contract = buildLlmContextCachePrefixContract({
    model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
    systemPrompt: `session:${migration.sessionId}`,
    tools: tools.map((name) => tool(name)),
  } as any);
  return {
    sessionId: migration.sessionId,
    sessionPath: migration.sessionPath,
    cachePrefixHash: contract.cachePrefixHash,
    toolSchemaHash: contract.toolSchemaHash,
    error: null as string | null,
  };
}

async function resumeSession({ previous, tools }) {
  const contract = buildLlmContextCachePrefixContract({
    model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
    systemPrompt: `session:${previous.sessionId}`,
    tools: tools.map((name) => tool(name)),
  } as any);
  // Characterize recovery: rebuild/invalidate the prefix after a user pause
  // changes tool schema instead of leaving a dead session error.
  return {
    sessionId: previous.sessionId,
    sessionPath: previous.sessionPath,
    cachePrefixHash: contract.cachePrefixHash,
    toolSchemaHash: contract.toolSchemaHash,
    error: null as string | null,
  };
}

describe("LLM cache prefix contract", () => {
  it("keeps the contract stable when only conversation messages change", () => {
    const base = buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read"), tool("exec_command")],
      messages: [{ role: "user", content: "first turn" }],
    } as any);
    const afterToolCall = buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read"), tool("exec_command")],
      messages: [
        { role: "user", content: "first turn" },
        { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "read" } }] },
        { role: "tool", content: "dynamic tool result", tool_call_id: "call_1" },
      ],
    } as any);

    expect(afterToolCall.cachePrefixHash).toBe(base.cachePrefixHash);
    expect(diffCachePrefixContracts(base, afterToolCall)).toEqual([]);
  });

  it("detects changes to system prompt, tool schema, and model route", () => {
    const base = buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
    });

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "mutated system prompt",
      tools: [tool("read")],
    })).map((d) => d.field)).toContain("systemPromptHash");

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read", "changed desc")],
    })).map((d) => d.field)).toContain("toolSchemaHash");

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
    })).map((d) => d.field)).toContain("modelHash");
  });

  it("invalidates or rebuilds the cache prefix after a user pause changes tool schema", async () => {
    const before = await snapshotSession({ tools: ["write_plugin"] });
    const after = await resumeSession({
      previous: before,
      tools: ["write_plugin", "install_plugin"],
    });

    expect(after.cachePrefixHash).not.toBe(before.cachePrefixHash);
    expect(after.toolSchemaHash).not.toBe(before.toolSchemaHash);
    expect(after.error).toBeNull();
    expect(String(after.error || "")).not.toMatch(/Cache prefix contract violated/);
  });
});
