import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Workflow states for the office-workflow example.
 *
 *   draft -> submitted -> approved -> sent
 *                       \\-> rejected
 *
 * `rejected` and `sent` are terminal.
 */
export const STATES = Object.freeze({
  DRAFT: "draft",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  SENT: "sent",
  REJECTED: "rejected",
});

export const TERMINAL_STATES = new Set([STATES.SENT, STATES.REJECTED]);

/**
 * Allowed transitions: { fromState: [toState, ...] }.
 * Every other transition is rejected.
 */
export const TRANSITIONS = Object.freeze({
  [STATES.DRAFT]: [STATES.SUBMITTED],
  [STATES.SUBMITTED]: [STATES.APPROVED, STATES.REJECTED],
  [STATES.APPROVED]: [STATES.SENT],
  [STATES.SENT]: [],
  [STATES.REJECTED]: [],
});

/**
 * Audit event types appended for each action.
 */
export const AUDIT_EVENTS = Object.freeze({
  CREATE: "create",
  UPDATE: "update",
  SUBMIT: "submit",
  APPROVE: "approve",
  REJECT: "reject",
  GENERATE_EMAIL_DRAFT: "generate_email_draft",
  MARK_SENT: "mark_sent",
});

/**
 * Validate that a transition is allowed.
 * Returns { ok: true } or { ok: false, error }.
 */
export function validateTransition(fromState, toState) {
  if (!Object.values(STATES).includes(fromState)) {
    return { ok: false, error: `Unknown current state: ${fromState}` };
  }
  if (!Object.values(STATES).includes(toState)) {
    return { ok: false, error: `Unknown target state: ${toState}` };
  }
  const allowed = TRANSITIONS[fromState] || [];
  if (!allowed.includes(toState)) {
    return {
      ok: false,
      error: `Transition ${fromState} -> ${toState} is not allowed`,
    };
  }
  return { ok: true };
}

/**
 * Create a new record with defaults and an initial audit event.
 * Returns a plain object — does not persist.
 */
export function createRecord(input = {}) {
  const now = new Date().toISOString();
  const id = input.id || generateId();
  const record = {
    id,
    requesterName: stringOrEmpty(input.requesterName),
    requesterEmail: stringOrEmpty(input.requesterEmail),
    organization: stringOrEmpty(input.organization),
    summary: stringOrEmpty(input.summary),
    lineItems: stringOrEmpty(input.lineItems),
    dueDate: stringOrEmpty(input.dueDate),
    internalNotes: stringOrEmpty(input.internalNotes),
    status: STATES.DRAFT,
    emailDraft: null,
    createdAt: now,
    updatedAt: now,
    audit: [
      {
        at: now,
        event: AUDIT_EVENTS.CREATE,
        detail: "Record created",
      },
    ],
  };
  return record;
}

/**
 * Apply field updates to a record. Only mutable fields may change.
 * Status, id, createdAt, audit are not editable here. Appends an
 * `update` audit event when any field actually changes.
 * Returns a new record object; does not mutate the input.
 */
export function updateRecord(record, patch = {}) {
  if (!record) throw new Error("updateRecord: record is required");
  if (isTerminal(record)) {
    throw new Error(`Cannot update a terminal record (status=${record.status})`);
  }
  const mutableFields = [
    "requesterName",
    "requesterEmail",
    "organization",
    "summary",
    "lineItems",
    "dueDate",
    "internalNotes",
  ];
  let changed = false;
  const next = { ...record, audit: record.audit.slice() };
  for (const field of mutableFields) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      const value = stringOrEmpty(patch[field]);
      if (next[field] !== value) {
        next[field] = value;
        changed = true;
      }
    }
  }
  if (changed) {
    next.updatedAt = new Date().toISOString();
    next.audit.push({
      at: next.updatedAt,
      event: AUDIT_EVENTS.UPDATE,
      detail: "Record fields updated",
    });
  }
  return next;
}

/**
 * Transition a record to a new status. Validates the transition and
 * appends the matching audit event. Returns a new record object.
 * Throws on invalid transition.
 */
export function transitionRecord(record, toState, detail = "") {
  if (!record) throw new Error("transitionRecord: record is required");
  const result = validateTransition(record.status, toState);
  if (!result.ok) throw new Error(result.error);
  const now = new Date().toISOString();
  const event = eventForTransition(toState);
  const next = {
    ...record,
    audit: record.audit.slice(),
    status: toState,
    updatedAt: now,
  };
  next.audit.push({
    at: now,
    event,
    detail: detail || `Status -> ${toState}`,
  });
  return next;
}

/**
 * Attach a generated email draft to a record and append an audit event.
 * `draft` should be { subject, text, html }.
 */
export function attachEmailDraft(record, draft) {
  if (!record) throw new Error("attachEmailDraft: record is required");
  if (!draft || typeof draft !== "object") {
    throw new Error("attachEmailDraft: draft object is required");
  }
  if (typeof draft.subject !== "string" ||
      typeof draft.text !== "string" ||
      typeof draft.html !== "string") {
    throw new Error("attachEmailDraft: draft must have subject, text, html strings");
  }
  const now = new Date().toISOString();
  const next = {
    ...record,
    audit: record.audit.slice(),
    emailDraft: {
      subject: draft.subject,
      text: draft.text,
      html: draft.html,
      generatedAt: now,
    },
    updatedAt: now,
  };
  next.audit.push({
    at: now,
    event: AUDIT_EVENTS.GENERATE_EMAIL_DRAFT,
    detail: "Email draft generated",
  });
  return next;
}

export function isTerminal(record) {
  return TERMINAL_STATES.has(record.status);
}

function eventForTransition(toState) {
  switch (toState) {
    case STATES.SUBMITTED: return AUDIT_EVENTS.SUBMIT;
    case STATES.APPROVED: return AUDIT_EVENTS.APPROVE;
    case STATES.REJECTED: return AUDIT_EVENTS.REJECT;
    case STATES.SENT: return AUDIT_EVENTS.MARK_SENT;
    default: return "transition";
  }
}

function stringOrEmpty(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function generateId() {
  return "ow-" + crypto.randomBytes(6).toString("hex");
}

/**
 * File-backed JSON store for office-workflow records.
 *
 * Stores a single JSON document containing a records map keyed by id.
 * Writes are atomic (write temp + rename) which is good enough for v1.
 *
 * The store is injectable: tests pass a custom `dataFile` path; the
 * runtime uses `ctx.dataDir`.
 */
export class WorkflowStore {
  constructor({ dataDir, dataFile } = {}) {
    if (dataFile) {
      this.dataFile = dataFile;
    } else if (dataDir) {
      this.dataDir = dataDir;
      this.dataFile = path.join(dataDir, "records.json");
    } else {
      throw new Error("WorkflowStore requires dataDir or dataFile");
    }
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
  }

  loadAll() {
    this.ensureDir();
    if (!fs.existsSync(this.dataFile)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(this.dataFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  }

  saveAll(records) {
    this.ensureDir();
    const tmp = `${this.dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), "utf-8");
    fs.renameSync(tmp, this.dataFile);
  }

  list() {
    const records = this.loadAll();
    return Object.values(records).sort((a, b) =>
      (b.createdAt || "").localeCompare(a.createdAt || "")
    );
  }

  get(id) {
    const records = this.loadAll();
    return records[id] || null;
  }

  save(record) {
    const records = this.loadAll();
    records[record.id] = record;
    this.saveAll(records);
    return record;
  }
}
