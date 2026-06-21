# Office Workflow Example Plugin

This is a generic office workflow example/template plugin for OpenHanako.
It demonstrates a neutral request/quotation workflow with deterministic
state transitions, plugin-private persistence, append-only audit history,
and email draft generation. It is intentionally not tied to any specific
product or vendor (no Heimatec, no Product Intel, no real email sending).

## What It Demonstrates

- A full-access plugin shape with a page contribution, plugin routes, and
  plugin-private local storage.
- A deterministic workflow state machine:
  `draft -> submitted -> approved -> sent`, plus terminal `rejected`.
- Append-only audit events for every create/update/transition/email-draft
  action.
- Email-ready draft generation producing subject, plain text, and
  email-safe HTML derived from the record.
- Manual send tracking (`sent` is a workflow state with audit metadata;
  this plugin does not deliver email).

## Status Model

| Transition | Allowed from | Result |
|------------|--------------|--------|
| submit | `draft` | `submitted` |
| approve | `submitted` | `approved` |
| reject | `submitted` | `rejected` |
| mark sent | `approved` | `sent` |

Every other transition is rejected with an explicit error. Every action
appends an audit event to the record.

## Layout

```text
office-workflow/
├── manifest.json
├── README.md
├── index.js                 # plugin lifecycle
├── routes/page.js           # iframe shell + JSON API
├── lib/workflow-store.js    # record + audit persistence
├── lib/email-draft.js       # subject/plain/html draft generation
├── ui/Panel.tsx             # React iframe UI
└── ui/panel.css             # minimal styles
```

## Install / Dev

In production, bundle `ui/Panel.tsx` into `assets/panel.js` and copy
`ui/panel.css` to `assets/panel.css`, then drop this directory into
`${HANA_HOME}/plugins/office-workflow`. Hana serves plugin static files
through `/api/plugins/{pluginId}/assets/...`.

For local development use the dev install/reload loop described in
`PLUGINS.md` (`plugin.dev.install`, `plugin.dev.reload`).

## What This Plugin Does NOT Do

- It does not send real email. `sent` is a manual workflow state with
  audit metadata only.
- It does not implement multi-role RBAC. v1 is a deterministic demo with
  explicit manual actions.
- It does not import or port code from any vendor-specific automation
  product or carry vendor-specific assumptions into this repository.
- It does not add core OpenHanako record tables, migrations, or
  platform-level approval primitives.

## Optional Future Work

PDF export is intentionally out of scope for v1. If added later, reuse
the host `SessionFile` / `stageFile` semantics (see `PLUGINS.md` § 媒体交付)
instead of bundling a PDF engine.
