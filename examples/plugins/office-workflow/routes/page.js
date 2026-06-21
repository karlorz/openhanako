import {
  attachEmailDraft,
  createRecord,
  STATES,
  TRANSITIONS,
  transitionRecord,
  updateRecord,
  WorkflowStore,
} from "../lib/workflow-store.js";
import { generateEmailDraft } from "../lib/email-draft.js";

export default function registerOfficeWorkflowRoutes(app, ctx) {
  const store = new WorkflowStore({ dataDir: ctx.dataDir });

  // Iframe shell for the contributed page.
  app.get("/page", (c) => c.html(renderShell(c, ctx)));

  // Records API.
  app.get("/api/records", (c) => c.json({ records: store.list() }));

  app.post("/api/records", async (c) => {
    const body = await readJson(c);
    const record = createRecord(body);
    store.save(record);
    return c.json({ record }, 201);
  });

  app.post("/api/records/:id", async (c) => {
    const id = c.req.param("id");
    const record = store.get(id);
    if (!record) return c.json({ error: "record not found" }, 404);
    try {
      const next = updateRecord(record, await readJson(c));
      store.save(next);
      return c.json({ record: next });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post("/api/records/:id/transition", async (c) => {
    const id = c.req.param("id");
    const record = store.get(id);
    if (!record) return c.json({ error: "record not found" }, 404);
    const body = await readJson(c);
    const toState = typeof body?.to === "string" ? body.to : "";
    if (!toState) return c.json({ error: "to is required" }, 400);
    try {
      const next = transitionRecord(record, toState, body?.detail);
      store.save(next);
      return c.json({ record: next });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post("/api/records/:id/email-draft", async (c) => {
    const id = c.req.param("id");
    const record = store.get(id);
    if (!record) return c.json({ error: "record not found" }, 404);
    const draft = generateEmailDraft(record);
    const next = store.save(attachEmailDraft(record, draft));
    return c.json({ record: next, draft });
  });

  // Introspection helpers (useful for the UI and dev tests).
  app.get("/api/workflow/info", (c) =>
    c.json({
      states: Object.values(STATES),
      transitions: TRANSITIONS,
    })
  );
}

async function readJson(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function renderShell(c, ctx) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const base = `/api/plugins/${ctx.pluginId}`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <link rel="stylesheet" href="${base}/assets/panel.css">
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="page">
  <div id="root" data-surface="page"></div>
  <script type="module" src="${base}/assets/panel.js"></script>
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
