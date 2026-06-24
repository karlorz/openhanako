import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pluginDir = path.join(root, "examples", "plugins", "office-workflow");

// The lib files are ESM (.js) shipped under the plugin directory. Vitest
// can import them directly because the repo is `"type": "module"`.
async function loadStore() {
  const url = new URL(
    `file://${path.join(pluginDir, "lib", "workflow-store.js")}`
  );
  return import(url.href);
}

async function loadEmailDraft() {
  const url = new URL(
    `file://${path.join(pluginDir, "lib", "email-draft.js")}`
  );
  return import(url.href);
}

describe("office-workflow plugin: manifest, docs, and source shape", () => {
  it("ships a manifest with a distinct office-workflow identity", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf-8")
    );
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: "office-workflow",
      name: "Office Workflow",
      trust: "full-access",
      contributes: {
        page: { route: "/page" },
      },
    });
    expect(manifest.id).not.toBe("office");
  });

  it("documents the example as a generic template and states no real email sending", () => {
    const readme = fs.readFileSync(path.join(pluginDir, "README.md"), "utf-8");
    expect(readme).toContain("generic");
    expect(readme).toContain("does not send real email");
    expect(readme).not.toContain("heimatec-automation");
  });

  it("documents the ctx.dataDir, ResourceIO, and sessionPermission boundary", () => {
    const readme = fs.readFileSync(path.join(pluginDir, "README.md"), "utf-8");

    expect(readme).toContain("ctx.dataDir");
    expect(readme).toContain("ctx.resources");
    expect(readme).toContain("SessionFile");
    expect(readme).toContain("writeExpectedVersion");
    expect(readme).toContain("sessionPermission");
    expect(readme).toContain("does not currently expose agent-callable tools");
    expect(readme).toContain("Do not write user resources directly");
  });

  it("exposes the workflow store, email draft, routes, and UI source", () => {
    expect(fs.existsSync(path.join(pluginDir, "lib", "workflow-store.js"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "lib", "email-draft.js"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "routes", "page.js"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "ui", "Panel.tsx"))).toBe(true);

    const routes = fs.readFileSync(path.join(pluginDir, "routes", "page.js"), "utf-8");
    expect(routes).toContain("/api/records");
    expect(routes).toContain("/api/records/:id/transition");
    expect(routes).toContain("/api/records/:id/email-draft");

    const panel = fs.readFileSync(path.join(pluginDir, "ui", "Panel.tsx"), "utf-8");
    expect(panel).toContain("@hana/plugin-sdk");
    expect(panel).toContain("@hana/plugin-components");
  });
});

describe("office-workflow plugin: workflow state machine", () => {
  it("creates a draft record with defaults and an audit event", async () => {
    const { createRecord, STATES, AUDIT_EVENTS } = await loadStore();
    const record = createRecord({
      requesterName: "Alice",
      organization: "Acme",
      summary: "Quote for 10 widgets",
    });
    expect(record.status).toBe(STATES.DRAFT);
    expect(record.requesterName).toBe("Alice");
    expect(record.id).toMatch(/^ow-/);
    expect(record.audit).toHaveLength(1);
    expect(record.audit[0].event).toBe(AUDIT_EVENTS.CREATE);
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it("allows draft -> submitted -> approved -> sent", async () => {
    const { createRecord, transitionRecord, STATES } = await loadStore();
    let record = createRecord({ summary: "Flow" });
    record = transitionRecord(record, STATES.SUBMITTED);
    expect(record.status).toBe(STATES.SUBMITTED);
    record = transitionRecord(record, STATES.APPROVED);
    expect(record.status).toBe(STATES.APPROVED);
    record = transitionRecord(record, STATES.SENT);
    expect(record.status).toBe(STATES.SENT);
    expect(record.audit).toHaveLength(4);
  });

  it("allows submitted -> rejected as terminal", async () => {
    const { createRecord, transitionRecord, isTerminal, STATES } = await loadStore();
    let record = createRecord({ summary: "Reject me" });
    record = transitionRecord(record, STATES.SUBMITTED);
    record = transitionRecord(record, STATES.REJECTED);
    expect(record.status).toBe(STATES.REJECTED);
    expect(isTerminal(record)).toBe(true);
  });

  it("rejects invalid transitions", async () => {
    const { createRecord, transitionRecord, STATES } = await loadStore();
    const record = createRecord({ summary: "Bad" });
    expect(() => transitionRecord(record, STATES.APPROVED)).toThrow(/not allowed/);
    expect(() => transitionRecord(record, STATES.SENT)).toThrow(/not allowed/);
  });

  it("rejects transitions out of terminal states", async () => {
    const { createRecord, transitionRecord, STATES } = await loadStore();
    let record = createRecord({ summary: "Done" });
    record = transitionRecord(record, STATES.SUBMITTED);
    record = transitionRecord(record, STATES.APPROVED);
    record = transitionRecord(record, STATES.SENT);
    expect(() => transitionRecord(record, STATES.DRAFT)).toThrow(/not allowed/);
    expect(() => transitionRecord(record, STATES.SUBMITTED)).toThrow(/not allowed/);
  });
});

describe("office-workflow plugin: audit + updates", () => {
  it("appends an audit event for every action", async () => {
    const { createRecord, transitionRecord, updateRecord, STATES } = await loadStore();
    let record = createRecord({ summary: "Audit" });
    record = updateRecord(record, { summary: "Audit 2" });
    record = transitionRecord(record, STATES.SUBMITTED);
    record = transitionRecord(record, STATES.APPROVED);
    const events = record.audit.map((a) => a.event);
    expect(events).toEqual([
      "create",
      "update",
      "submit",
      "approve",
    ]);
  });

  it("does not append an update event when nothing changes", async () => {
    const { createRecord, updateRecord } = await loadStore();
    const record = createRecord({ summary: "Same" });
    const next = updateRecord(record, { summary: "Same" });
    expect(next.audit).toHaveLength(1);
  });

  it("refuses to update a terminal record", async () => {
    const { createRecord, transitionRecord, updateRecord, STATES } = await loadStore();
    let record = createRecord({ summary: "Frozen" });
    record = transitionRecord(record, STATES.SUBMITTED);
    record = transitionRecord(record, STATES.REJECTED);
    expect(() => updateRecord(record, { summary: "Try" })).toThrow(/terminal/);
  });
});

describe("office-workflow plugin: persistence", () => {
  it("persists and reloads records via WorkflowStore", async () => {
    const { createRecord, WorkflowStore, STATES, transitionRecord } = await loadStore();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-store-"));
    try {
      const store = new WorkflowStore({ dataDir: tmpDir });
      const record = store.save(createRecord({ summary: "Persisted", requesterName: "Bob" }));
      const store2 = new WorkflowStore({ dataDir: tmpDir });
      const loaded = store2.get(record.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.requesterName).toBe("Bob");
      expect(loaded!.status).toBe(STATES.DRAFT);

      // Transition and re-save; the new status should survive reload.
      const updated = store2.save(transitionRecord(loaded!, STATES.SUBMITTED));
      const store3 = new WorkflowStore({ dataDir: tmpDir });
      const reloaded = store3.get(record.id);
      expect(reloaded!.status).toBe(STATES.SUBMITTED);
      expect(reloaded!.audit).toEqual(updated.audit);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when no records exist", async () => {
    const { WorkflowStore } = await loadStore();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-empty-"));
    try {
      const store = new WorkflowStore({ dataDir: tmpDir });
      expect(store.list()).toEqual([]);
      expect(store.get("missing")).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("office-workflow plugin: email draft generation", () => {
  it("produces subject, plain text, and email-safe HTML", async () => {
    const { createRecord } = await loadStore();
    const { generateEmailDraft } = await loadEmailDraft();
    const record = createRecord({
      requesterName: "Carol",
      requesterEmail: "carol@example.com",
      organization: "Globex",
      summary: "Need 5 widgets by Friday",
      lineItems: "- Widget A x5",
      dueDate: "2026-07-01",
      internalNotes: "VIP",
    });
    const draft = generateEmailDraft(record);
    expect(draft.subject).toContain("[Globex]");
    expect(draft.subject).toContain("Office request:");
    expect(draft.text).toContain("Requester: Carol");
    expect(draft.text).toContain("Email: carol@example.com");
    expect(draft.text).toContain("Need 5 widgets by Friday");
    expect(draft.text).toContain(`Status: ${record.status}`);
    expect(draft.html).toContain("<!doctype html>");
    expect(draft.html).toContain("Carol");
    expect(draft.html).not.toContain("<script");
  });

  it("escapes HTML in user-controlled fields", async () => {
    const { createRecord } = await loadStore();
    const { generateEmailDraft } = await loadEmailDraft();
    const record = createRecord({
      requesterName: "<script>alert(1)</script>",
      summary: "5 < 10 & 10 > 5",
    });
    const draft = generateEmailDraft(record);
    expect(draft.html).not.toContain("<script>alert(1)</script>");
    expect(draft.html).toContain("&lt;script&gt;");
    expect(draft.html).toContain("5 &lt; 10 &amp; 10 &gt; 5");
  });

  it("omits empty optional fields from the HTML", async () => {
    const { createRecord } = await loadStore();
    const { generateEmailDraft } = await loadEmailDraft();
    const record = createRecord({ requesterName: "Dan", summary: "Minimal" });
    const draft = generateEmailDraft(record);
    expect(draft.html).not.toContain("Line items");
    expect(draft.html).not.toContain("Internal notes");
    expect(draft.html).not.toContain("Email:");
  });
});
