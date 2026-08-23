/**
 * Shared reminder / memory-fact isolation fixtures for next-stable migration.
 *
 * Candidate v0.380.10 introduces process-local env-change ledgers + hana_reminder
 * blocks. Issue #2106 reports memory-change reminders can cross Agent boundaries
 * when ledger events lack agent ownership and dispatch fans out unscoped.
 *
 * These helpers encode the behavioral contract only. They must not be treated as
 * production code and must not invent candidate runtime modules into the fork.
 */

export type MemoryChangeReminderEvent = {
  type: "hana_reminder";
  agentId: string;
  changedFacts?: string[];
  sessionId?: string;
};

export type ReminderSubscription = {
  sessionId: string;
  agentId: string;
};

export type ReminderDelivery = ReminderSubscription & {
  type: "hana_reminder";
  changedFacts: string[];
};

/**
 * Agent-scoped recipient filter for memory-change reminders.
 * Only subscriptions whose agentId matches the event owner receive the event.
 */
export function filterReminderRecipients(
  event: MemoryChangeReminderEvent | null | undefined,
  subscriptions: ReminderSubscription[] | null | undefined,
): ReminderSubscription[] {
  const agentId = typeof event?.agentId === "string" ? event.agentId.trim() : "";
  if (!agentId || !Array.isArray(subscriptions)) return [];
  return subscriptions.filter((sub) => {
    const subAgentId = typeof sub?.agentId === "string" ? sub.agentId.trim() : "";
    return subAgentId.length > 0 && subAgentId === agentId;
  });
}

/**
 * Pure dispatch characterization for the isolation contract.
 * Production may implement this under another name after stable activation.
 */
export async function dispatchReminder(
  event: MemoryChangeReminderEvent,
  subscriptions: ReminderSubscription[],
): Promise<ReminderDelivery[]> {
  return filterReminderRecipients(event, subscriptions).map((sub) => ({
    sessionId: sub.sessionId,
    agentId: sub.agentId,
    type: "hana_reminder",
    changedFacts: Array.isArray(event?.changedFacts) ? [...event.changedFacts] : [],
  }));
}

/**
 * Inventory probe: whether the current process has candidate reminder modules.
 * Pass module ids / path basenames observed on disk or via dynamic import maps.
 */
export function memoryChangeReminderSurfaceActive(
  knownModules: Iterable<string> | Record<string, unknown> | null | undefined,
): boolean {
  if (!knownModules) return false;
  const required = ["session-reminders", "env-change-ledger"];
  const present = new Set<string>();
  if (typeof (knownModules as any)[Symbol.iterator] === "function") {
    for (const id of knownModules as Iterable<string>) {
      const normalized = String(id || "").replace(/\\/g, "/");
      for (const token of required) {
        if (normalized.includes(token)) present.add(token);
      }
    }
  } else {
    for (const key of Object.keys(knownModules as Record<string, unknown>)) {
      const normalized = String(key || "").replace(/\\/g, "/");
      for (const token of required) {
        if (normalized.includes(token)) present.add(token);
      }
    }
  }
  return required.every((token) => present.has(token));
}

export type FactMessage = {
  role: "user" | "assistant" | string;
  content: string;
  provenance?: {
    owner?: string;
    sourceRole?: string;
    explicit?: boolean;
    [key: string]: unknown;
  } | null;
};

export type CompiledFact = {
  owner: string;
  content: string;
  provenance: {
    sourceRole: string;
    explicit: boolean;
    [key: string]: unknown;
  };
};

/**
 * Characterization compileFacts gate for memory provenance.
 * Assistant statements cannot become owner:"user" facts without explicit provenance.
 * This is the contract shape Task 5 locks for migration; not a production compiler.
 */
export function compileFacts(messages: FactMessage[] | null | undefined): CompiledFact[] {
  if (!Array.isArray(messages)) return [];
  const facts: CompiledFact[] = [];
  for (const message of messages) {
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    if (!content) continue;
    const role = typeof message?.role === "string" ? message.role : "";
    const provenance = message?.provenance && typeof message.provenance === "object"
      ? message.provenance
      : null;

    if (role === "user") {
      facts.push({
        owner: "user",
        content,
        provenance: {
          sourceRole: "user",
          explicit: true,
          ...(provenance || {}),
        },
      });
      continue;
    }

    if (role === "assistant") {
      const explicitUserOwned = provenance?.owner === "user" && provenance?.explicit === true;
      if (explicitUserOwned) {
        facts.push({
          owner: "user",
          content,
          provenance: {
            sourceRole: provenance?.sourceRole || "assistant",
            explicit: true,
            ...provenance,
          },
        });
      }
      // Without explicit user provenance, assistant content must not become a user fact.
    }
  }
  return facts;
}
