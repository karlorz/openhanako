/**
 * Agent-scoped memory-change reminder isolation contracts (#2106).
 *
 * Candidate-only surface (v0.380.10+): process-local EnvChangeLedger + hana_reminder
 * blocks can fan memory_facts changes into every live session unless dispatch is
 * filtered by owning agentId. Current fork (pre-activation) does not ship that
 * surface; this suite locks the isolation contract and characterizes absence so
 * the leak cannot land silently during next-stable migration.
 *
 * Policy: characterization only. Do not invent production reminder modules here.
 * If a live leak is demonstrated on production code under this master work item,
 * stop and open a separate security work item instead of silently fixing it.
 */

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { SessionCoordinator } from "../core/session-coordinator.ts";
import {
  compileFacts,
  dispatchReminder,
  filterReminderRecipients,
  memoryChangeReminderSurfaceActive,
} from "./helpers/migration-reminder.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listCoreModuleBasenames(): string[] {
  const coreDir = path.join(ROOT, "core");
  return fs.readdirSync(coreDir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".js"))
    .map((name) => name.replace(/\.(ts|js)$/, ""));
}

describe("memory-change reminder agent isolation (#2106)", () => {
  it("does not deliver Agent A memory-change reminders to Agent B sessions", async () => {
    const deliveries = await dispatchReminder(
      { type: "hana_reminder", agentId: "agent-a", changedFacts: ["fact-a"] },
      [
        { sessionId: "sess-a", agentId: "agent-a" },
        { sessionId: "sess-b", agentId: "agent-b" },
      ],
    );

    expect(deliveries).toEqual([
      expect.objectContaining({ sessionId: "sess-a", agentId: "agent-a" }),
    ]);
    expect(deliveries.some((d) => d.sessionId === "sess-b" || d.agentId === "agent-b")).toBe(false);
  });

  it("filterReminderRecipients drops unmatched and empty agent ownership", () => {
    const subscriptions = [
      { sessionId: "sess-a", agentId: "agent-a" },
      { sessionId: "sess-b", agentId: "agent-b" },
      { sessionId: "sess-c", agentId: "agent-a" },
    ];

    expect(filterReminderRecipients(
      { type: "hana_reminder", agentId: "agent-a", changedFacts: ["x"] },
      subscriptions,
    )).toEqual([
      { sessionId: "sess-a", agentId: "agent-a" },
      { sessionId: "sess-c", agentId: "agent-a" },
    ]);

    expect(filterReminderRecipients(
      { type: "hana_reminder", agentId: "", changedFacts: ["x"] },
      subscriptions,
    )).toEqual([]);

    expect(filterReminderRecipients(
      { type: "hana_reminder", agentId: "agent-z", changedFacts: ["x"] },
      subscriptions,
    )).toEqual([]);
  });

  it("characterizes current-fork absence of candidate memory-change reminder modules", () => {
    const coreModules = listCoreModuleBasenames();
    expect(coreModules).not.toContain("session-reminders");
    expect(coreModules).not.toContain("env-change-ledger");
    expect(memoryChangeReminderSurfaceActive(coreModules)).toBe(false);

    // Preferred candidate surface after stable activation (inventory only).
    expect(memoryChangeReminderSurfaceActive([
      "core/session-reminders.ts",
      "core/env-change-ledger.ts",
    ])).toBe(true);
  });

  it("SessionCoordinator does not expose candidate reminder render/consume APIs yet", () => {
    const proto = SessionCoordinator.prototype as Record<string, unknown>;
    expect(typeof proto.renderSessionReminderBlock).not.toBe("function");
    expect(typeof proto.consumeRenderedSessionReminderBlock).not.toBe("function");
    expect(typeof proto.consumeSessionReminderBlock).not.toBe("function");
    expect(typeof proto.noteSessionTimeObserved).not.toBe("function");
  });

  it("documents unscoped memory_facts fan-out as the #2106 leak shape to reject", async () => {
    // Candidate EnvChangeLedger records memory_facts without agentId. An unscoped
    // fan-out over all live sessions is the reported cross-Agent leak. The
    // isolation contract requires re-scoping by event.agentId before delivery.
    const unscopedLedgerEvent = {
      type: "memory_facts" as const,
      payload: { addedLines: ["fact-a"] },
      // intentionally no agentId — candidate shape that enables #2106
    };
    expect(unscopedLedgerEvent).not.toHaveProperty("agentId");
    expect((unscopedLedgerEvent as any).agentId).toBeUndefined();

    const leakyFanout = [
      { sessionId: "sess-a", agentId: "agent-a" },
      { sessionId: "sess-b", agentId: "agent-b" },
    ];
    // Without agent ownership on the event, isolation must refuse delivery rather
    // than broadcast. filterReminderRecipients requires event.agentId.
    expect(filterReminderRecipients(
      { type: "hana_reminder", agentId: "", changedFacts: unscopedLedgerEvent.payload.addedLines },
      leakyFanout,
    )).toEqual([]);

    const scoped = await dispatchReminder(
      { type: "hana_reminder", agentId: "agent-a", changedFacts: unscopedLedgerEvent.payload.addedLines },
      leakyFanout,
    );
    expect(scoped).toEqual([
      expect.objectContaining({ sessionId: "sess-a", agentId: "agent-a", changedFacts: ["fact-a"] }),
    ]);
  });
});

describe("memory fact provenance (assistant cannot become user fact)", () => {
  it("assistant statements without explicit provenance never compile as owner:user", () => {
    expect(compileFacts([
      { role: "assistant", content: "The user prefers dark mode." },
    ])).not.toContainEqual(expect.objectContaining({ owner: "user" }));
  });

  it("user statements remain user-owned and explicit provenance can promote assistant text", () => {
    expect(compileFacts([
      { role: "user", content: "I prefer dark mode." },
    ])).toContainEqual(expect.objectContaining({
      owner: "user",
      content: "I prefer dark mode.",
    }));

    expect(compileFacts([
      {
        role: "assistant",
        content: "Confirmed preference: dark mode.",
        provenance: { owner: "user", explicit: true, sourceRole: "assistant", confirmedBy: "user" },
      },
    ])).toContainEqual(expect.objectContaining({
      owner: "user",
      content: "Confirmed preference: dark mode.",
    }));
  });
});
