/**
 * Shared session identity fixture for next-stable migration characterization.
 * Keyed by sessionId, sessionPath, and sourceEntryId so routing / replay /
 * branch-reset tests can stay consistent across suites.
 */
export function makeMigrationSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess_migration_a",
    sessionPath: "/tmp/sessions/sess_migration_a.jsonl",
    sourceEntryId: "entry_user_1",
    agentId: "hanako",
    ...overrides,
  };
}

/**
 * Inventory-driven probe for the candidate-only session_compaction_result event.
 * Current fork terminal compaction lifecycle is compaction_end; do not invent
 * production handlers before stable activation.
 */
export function sessionCompactionResultActive(
  knownEventTypes: Iterable<string> | Record<string, unknown> | null | undefined,
): boolean {
  if (!knownEventTypes) return false;
  if (typeof (knownEventTypes as any)[Symbol.iterator] === "function") {
    for (const type of knownEventTypes as Iterable<string>) {
      if (type === "session_compaction_result") return true;
    }
    return false;
  }
  return Object.prototype.hasOwnProperty.call(knownEventTypes, "session_compaction_result");
}
