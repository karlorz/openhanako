import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { hana } from '@hana/plugin-sdk';
import {
  Button,
  CardShell,
  EmptyState,
  HanaThemeProvider,
  List,
  SettingRow,
  TextInput,
} from '@hana/plugin-components';
import '@hana/plugin-components/styles.css';

type Record = {
  id: string;
  requesterName: string;
  requesterEmail: string;
  organization: string;
  summary: string;
  lineItems: string;
  dueDate: string;
  internalNotes: string;
  status: string;
  emailDraft: { subject: string; text: string; html: string; generatedAt: string } | null;
  createdAt: string;
  updatedAt: string;
  audit: { at: string; event: string; detail: string }[];
};

const STATES = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  SENT: 'sent',
  REJECTED: 'rejected',
} as const;

const TRANSITIONS: Record<string, string[]> = {
  [STATES.DRAFT]: [STATES.SUBMITTED],
  [STATES.SUBMITTED]: [STATES.APPROVED, STATES.REJECTED],
  [STATES.APPROVED]: [STATES.SENT],
  [STATES.SENT]: [],
  [STATES.REJECTED]: [],
};

function Panel() {
  const [records, setRecords] = useState<Record[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ subject: string; text: string; html: string } | null>(null);
  const [form, setForm] = useState({
    requesterName: '',
    requesterEmail: '',
    organization: '',
    summary: '',
    lineItems: '',
    dueDate: '',
    internalNotes: '',
  });

  useEffect(() => {
    hana.ready();
    hana.ui.resize({ height: 720 });
    refreshRecords();
  }, []);

  async function refreshRecords() {
    const res = await fetch('/api/records');
    const data = await res.json();
    setRecords(data.records || []);
  }

  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) || null,
    [records, selectedId]
  );

  async function createDraft() {
    const res = await fetch('/api/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    await refreshRecords();
    setSelectedId(data.record.id);
    setDraft(null);
    await hana.toast.show({ message: 'Draft created', type: 'success' });
  }

  async function transition(to: string) {
    if (!selected) return;
    const res = await fetch(`/api/records/${selected.id}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (!res.ok) {
      const err = await res.json();
      await hana.toast.show({ message: err.error || 'Transition failed', type: 'error' });
      return;
    }
    await refreshRecords();
    await hana.toast.show({ message: `Status -> ${to}`, type: 'success' });
  }

  async function generateDraft() {
    if (!selected) return;
    const res = await fetch(`/api/records/${selected.id}/email-draft`, { method: 'POST' });
    const data = await res.json();
    await refreshRecords();
    setDraft(data.draft);
    await hana.toast.show({ message: 'Email draft generated', type: 'success' });
  }

  async function copyDraftText() {
    if (!draft) return;
    await hana.clipboard.writeText(draft.text);
    await hana.toast.show({ message: 'Copied plain text', type: 'success' });
  }

  return (
    <HanaThemeProvider mode="inherit">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 16 }}>
        <CardShell title="New request" description="Intake form for a neutral office request.">
          <SettingRow
            label="Requester name"
            control={<TextInput value={form.requesterName} onChange={(e) => setForm({ ...form, requesterName: e.currentTarget.value })} />}
          />
          <SettingRow
            label="Requester email"
            control={<TextInput value={form.requesterEmail} onChange={(e) => setForm({ ...form, requesterEmail: e.currentTarget.value })} />}
          />
          <SettingRow
            label="Organization"
            control={<TextInput value={form.organization} onChange={(e) => setForm({ ...form, organization: e.currentTarget.value })} />}
          />
          <SettingRow
            label="Summary"
            control={<TextInput value={form.summary} onChange={(e) => setForm({ ...form, summary: e.currentTarget.value })} />}
          />
          <SettingRow
            label="Due date"
            control={<TextInput value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.currentTarget.value })} />}
          />
          <SettingRow
            label="Line items"
            control={<TextInput value={form.lineItems} onChange={(e) => setForm({ ...form, lineItems: e.currentTarget.value })} />}
          />
          <SettingRow
            label="Internal notes"
            control={<TextInput value={form.internalNotes} onChange={(e) => setForm({ ...form, internalNotes: e.currentTarget.value })} />}
          />
          <Button variant="primary" onClick={createDraft}>Save draft</Button>
        </CardShell>

        <CardShell title="Records" description="Click a record to inspect and act on it.">
          {records.length === 0 ? (
            <EmptyState title="No records" description="Create a draft to get started." />
          ) : (
            <List
              items={records.map((r) => ({
                id: r.id,
                title: r.summary || r.requesterName || r.id,
                meta: r.status,
                action: (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSelectedId(r.id);
                      setDraft(null);
                    }}
                  >
                    {selectedId === r.id ? 'Selected' : 'Select'}
                  </Button>
                ),
              }))}
            />
          )}
          {selected && (
            <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(TRANSITIONS[selected.status] || []).map((to) => (
                <Button key={to} variant="ghost" onClick={() => transition(to)}>{to}</Button>
              ))}
              <Button variant="ghost" onClick={generateDraft}>Generate email draft</Button>
              <Button variant="ghost" onClick={copyDraftText} disabled={!draft}>Copy draft text</Button>
            </div>
          )}
        </CardShell>

        {selected && (
          <CardShell title="Selected record" description={selected.id}>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>
{JSON.stringify({
  status: selected.status,
  requesterName: selected.requesterName,
  requesterEmail: selected.requesterEmail,
  organization: selected.organization,
  summary: selected.summary,
  dueDate: selected.dueDate,
  lineItems: selected.lineItems,
  internalNotes: selected.internalNotes,
  createdAt: selected.createdAt,
  updatedAt: selected.updatedAt,
}, null, 2)}
            </pre>
          </CardShell>
        )}

        {selected && (
          <CardShell title="Audit timeline" description="Append-only event log.">
            {selected.audit.length === 0 ? (
              <EmptyState title="No events" description="Actions will appear here." />
            ) : (
              <List
                items={selected.audit.map((a, i) => ({
                  id: `${i}-${a.at}`,
                  title: a.event,
                  meta: a.at,
                }))}
              />
            )}
          </CardShell>
        )}

        {draft && (
          <CardShell title="Email draft" description="Generated draft — not sent.">
            <SettingRow label="Subject" control={<TextInput value={draft.subject} onChange={() => {}} />} />
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{draft.text}</pre>
          </CardShell>
        )}
      </div>
    </HanaThemeProvider>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Panel />);
