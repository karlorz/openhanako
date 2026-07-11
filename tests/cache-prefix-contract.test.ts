import { describe, expect, it } from "vitest";
import {
  buildLlmContextCachePrefixContract,
  diffCachePrefixContracts,
} from "../lib/llm/cache-prefix-contract.ts";
import {
  assertSessionSnapshotRequest,
  buildSessionCacheSnapshot,
  buildSessionSnapshotRequestContract,
} from "../core/session-cache-snapshot.ts";
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

const model = {
  id: "deepseek-v4-pro",
  provider: "deepseek",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
};

describe("LLM cache prefix contract", () => {
  it("keeps the contract stable when only conversation messages change", () => {
    const base = buildLlmContextCachePrefixContract({
      model,
      systemPrompt: "stable system prompt",
      tools: [tool("read"), tool("exec_command")],
      messages: [{ role: "user", content: "first turn" }],
    } as any);
    const afterToolCall = buildLlmContextCachePrefixContract({
      model,
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
      model,
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
    });

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model,
      systemPrompt: "mutated system prompt",
      tools: [tool("read")],
    })).map((d) => d.field)).toContain("systemPromptHash");

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model,
      systemPrompt: "stable system prompt",
      tools: [tool("read", "changed desc")],
    })).map((d) => d.field)).toContain("toolSchemaHash");

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model: { ...model, id: "deepseek-v4-flash" },
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
    })).map((d) => d.field)).toContain("modelHash");
  });

  it("rebuilds session cache-prefix hashes after a pause-time tool schema change and recovers without a dead-session contract violation", () => {
    const migration = makeMigrationSession({
      sessionPath: "/sessions/sess_migration_a.jsonl",
    });
    const systemPrompt = `session:${migration.sessionId}`;
    const messages = [{ role: "user", content: "pause-boundary turn" }];
    const beforeTools = [tool("write_plugin")];
    const afterTools = [tool("write_plugin"), tool("install_plugin")];

    // Production path: session cache snapshots are rebuilt from the current
    // provider-visible tool schema after intentional lifecycle changes.
    const beforeSnapshot = buildSessionCacheSnapshot({
      sessionPath: migration.sessionPath,
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt,
      tools: beforeTools,
      messages,
      reason: "user_pause.before",
    });
    const afterSnapshot = buildSessionCacheSnapshot({
      sessionPath: migration.sessionPath,
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt,
      tools: afterTools,
      messages,
      reason: "user_pause.after",
    });

    expect(afterSnapshot.cachePrefixHash).not.toBe(beforeSnapshot.cachePrefixHash);
    expect(afterSnapshot.toolSchemaHash).not.toBe(beforeSnapshot.toolSchemaHash);
    expect(afterSnapshot.toolNames).toEqual(["write_plugin", "install_plugin"]);

    // Without renew/rebuild, a request that carries the new tool schema against
    // the old snapshot is a real contract mismatch (cache recovery path).
    const staleRequest = buildSessionSnapshotRequestContract({
      snapshot: beforeSnapshot,
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt,
      tools: afterTools,
      messages,
      prefixMessageCount: messages.length,
    });
    const staleCheck = assertSessionSnapshotRequest(beforeSnapshot, staleRequest);
    expect(staleCheck.ok).toBe(false);
    expect(staleCheck.diffs.map((d) => d.field)).toEqual(
      expect.arrayContaining(["toolSchemaHash", "cachePrefixHash"]),
    );
    expect(staleCheck.metadata).toMatchObject({
      cacheStrategy: "cache_recovery",
      degradeReason: "session_snapshot_contract_mismatch",
    });

    // After rebuild, the same request matches the renewed snapshot. That is the
    // production recovery outcome: invalidate/rebuild rather than leave a dead
    // session under a permanent "Cache prefix contract violated" failure.
    const rebuiltRequest = buildSessionSnapshotRequestContract({
      snapshot: afterSnapshot,
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt,
      tools: afterTools,
      messages,
      prefixMessageCount: messages.length,
    });
    const rebuiltCheck = assertSessionSnapshotRequest(afterSnapshot, rebuiltRequest);
    expect(rebuiltCheck).toMatchObject({
      ok: true,
      strict: true,
      diffs: [],
    });
    expect(rebuiltCheck.metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
      degradeReason: "",
      cachePrefixHash: afterSnapshot.cachePrefixHash,
    });

    // LLM prefix contract follows the same rebuild boundary for tool schema.
    const beforeContract = buildLlmContextCachePrefixContract({
      model,
      systemPrompt,
      tools: beforeTools,
    });
    const afterContract = buildLlmContextCachePrefixContract({
      model,
      systemPrompt,
      tools: afterTools,
    });
    expect(diffCachePrefixContracts(beforeContract, afterContract).map((d) => d.field))
      .toEqual(expect.arrayContaining(["toolSchemaHash", "cachePrefixHash"]));
    expect(afterContract.toolSchemaHash).toBe(afterSnapshot.toolSchemaHash);
  });
});
