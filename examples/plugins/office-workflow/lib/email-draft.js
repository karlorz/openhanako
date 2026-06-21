/**
 * Email draft generation for the office-workflow example.
 *
 * Derives subject, plain-text body, and email-safe HTML body from a
 * workflow record. The output is a draft for manual review/copy — the
 * plugin does not send email.
 */

/**
 * Generate an email draft { subject, text, html } from a record.
 * The HTML is email-safe: escaped text, inline-styled structural
 * elements only, no scripts, no external resources.
 */
export function generateEmailDraft(record) {
  if (!record) throw new Error("generateEmailDraft: record is required");
  const subject = buildSubject(record);
  const text = buildPlainText(record);
  const html = buildHtml(record);
  return { subject, text, html };
}

function buildSubject(record) {
  const org = record.organization ? `[${record.organization}] ` : "";
  const summary = truncate(record.summary || record.requesterName || "Office request", 80);
  return `${org}Office request: ${summary}`;
}

function buildPlainText(record) {
  const lines = [];
  lines.push(`Requester: ${record.requesterName || "-"}`);
  if (record.requesterEmail) lines.push(`Email: ${record.requesterEmail}`);
  if (record.organization) lines.push(`Organization: ${record.organization}`);
  if (record.dueDate) lines.push(`Due: ${record.dueDate}`);
  lines.push("");
  lines.push("Summary:");
  lines.push(record.summary || "-");
  if (record.lineItems) {
    lines.push("");
    lines.push("Line items:");
    lines.push(record.lineItems);
  }
  if (record.internalNotes) {
    lines.push("");
    lines.push("Internal notes:");
    lines.push(record.internalNotes);
  }
  lines.push("");
  lines.push(`Status: ${record.status}`);
  lines.push(`Record ID: ${record.id}`);
  return lines.join("\n");
}

function buildHtml(record) {
  const rows = [];
  rows.push(rowHtml("Requester", record.requesterName));
  if (record.requesterEmail) rows.push(rowHtml("Email", record.requesterEmail));
  if (record.organization) rows.push(rowHtml("Organization", record.organization));
  if (record.dueDate) rows.push(rowHtml("Due", record.dueDate));
  rows.push(rowHtml("Status", record.status));
  rows.push(rowHtml("Record ID", record.id));

  const sections = [];
  sections.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1a1a1a;">${rows.join("")}</table>`);
  sections.push(`<p style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1a1a1a;margin-top:16px;"><strong>Summary</strong></p><p style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1a1a1a;white-space:pre-wrap;margin:4px 0 16px;">${escapeHtml(record.summary || "-")}</p>`);
  if (record.lineItems) {
    sections.push(`<p style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1a1a1a;margin-top:16px;"><strong>Line items</strong></p><pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#1a1a1a;background:#f5f5f5;padding:12px;border-radius:6px;white-space:pre-wrap;margin:4px 0 16px;">${escapeHtml(record.lineItems)}</pre>`);
  }
  if (record.internalNotes) {
    sections.push(`<p style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1a1a1a;margin-top:16px;"><strong>Internal notes</strong></p><p style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1a1a1a;white-space:pre-wrap;margin:4px 0 16px;">${escapeHtml(record.internalNotes)}</p>`);
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Office request draft</title></head>
<body style="margin:0;padding:24px;background:#ffffff;">
${sections.join("\n")}
</body></html>`;
}

function rowHtml(label, value) {
  if (!value) return "";
  return `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top;width:140px;">${escapeHtml(label)}</td><td style="padding:4px 0;color:#1a1a1a;vertical-align:top;">${escapeHtml(value)}</td></tr>`;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
