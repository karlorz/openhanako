/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceSourcesPanel } from '../../settings/components/MarketplaceSourcesPanel';

const mockHanaFetch = vi.fn();
const mockShowToast = vi.fn();

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockHanaFetch(...args),
}));

vi.mock('../../settings/store', () => ({
  useSettingsStore: (selector?: (state: any) => unknown) => {
    const state = { showToast: mockShowToast };
    return selector ? selector(state) : state;
  },
}));

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('MarketplaceSourcesPanel product states', () => {
  beforeEach(() => {
    mockHanaFetch.mockReset();
    mockShowToast.mockReset();
    window.t = ((key: string, params?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'settings.plugins.marketSourceAdd': 'Add source',
        'settings.plugins.marketSourceCancel': 'Cancel',
        'settings.plugins.marketSourceRefreshAll': 'Reload source list',
        'settings.plugins.marketSourceRefreshNamed': `Refresh ${params?.id || ''}`.trim(),
        'settings.plugins.marketSourceRemoveNamed': `Remove marketplace source ${params?.id || ''}`.trim(),
        'settings.plugins.marketSourceRefreshAction': 'Refresh',
        'settings.plugins.marketSourceRemoveAction': 'Remove',
        'settings.plugins.marketSourceTechnicalDetails': 'Technical details',
        'settings.plugins.marketSourceLocation': 'Location',
        'settings.plugins.marketSourceGitRef': 'Git ref',
        'settings.plugins.marketSourceIndexPath': 'Index path',
        'settings.plugins.marketSourceResolvedRevision': 'Resolved revision',
        'settings.plugins.marketSourceCatalogDigest': 'Catalog digest',
        'settings.plugins.marketSourceFetchedAt': 'Fetched at',
        'settings.plugins.marketSourceDiagnostics': 'Diagnostics',
        'settings.plugins.marketSourceStatusOk': 'OK',
        'settings.plugins.marketSourceStatusError': 'Error',
        'settings.plugins.marketSourceStatusStale': 'Stale',
        'settings.plugins.marketSourceAuthorityCustom': 'Custom',
        'settings.plugins.marketSourceKindGit': 'Git (public HTTPS)',
        'settings.plugins.marketSourceKindLocal': 'Local (server path)',
        'settings.plugins.marketSourceDialogTitle': 'Add Marketplace Source',
        'settings.plugins.marketSourceDialogClose': 'Close add marketplace source dialog',
        'settings.plugins.marketSourceDialogHelp': 'Paste a marketplace URL, Git repository, or server-local path. Hana detects the source type automatically.',
        'settings.plugins.marketSourceDialogField': 'Source',
        'settings.plugins.marketSourceExampleCatalog': 'https://example.com/marketplace.json',
        'settings.plugins.marketSourceExampleGit': 'https://github.com/org/catalog',
        'settings.plugins.marketSourceExampleLocal': '/path/to/marketplace',
        'settings.plugins.marketSourceExamplesLabel': 'Marketplace source examples',
        'settings.plugins.marketSourceDetectedCatalog': 'Detected: HTTPS catalog',
        'settings.plugins.marketSourceDetectedGit': 'Detected: public HTTPS Git repository',
        'settings.plugins.marketSourceDetectedLocal': 'Detected: server-local path',
        'settings.plugins.marketSourceDetectedUnknown': 'Detected: enter an HTTPS catalog, public HTTPS Git repository, or server-local path.',
        'settings.plugins.marketSourceRequired': 'Enter a marketplace source to continue.',
        'settings.plugins.marketSourceAdding': 'Adding…',
        'settings.plugins.marketSourceReadOnly': 'Browsing is available. Source mutations need server owner access on this connection.',
        'settings.plugins.marketSourceDegraded': 'Source changes are blocked while marketplace JSON is invalid. Repair the advanced configuration and reload.',
        'settings.plugins.marketSourceEnabled': 'Enabled',
        'settings.plugins.marketSourceDisabled': 'Disabled',
        'settings.plugins.marketSourcePackages': `${params?.count || '0'} packages`,
        'settings.plugins.marketSourceEnable': 'Enable',
        'settings.plugins.marketSourceDisable': 'Disable',
        'settings.plugins.marketSourceToggleConfirm': `${params?.operation} marketplace source ${params?.id}? Package identities and installed artifacts remain source-qualified.`,
        'settings.plugins.marketSourceToggleFailed': 'Failed to update marketplace source',
        'settings.plugins.marketSourceToggleSuccess': `Marketplace source ${params?.id} ${params?.state}`,
      };
      return labels[key] || key;
    }) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows origin, type, enabled state, health, count, and redacted locality', async () => {
    mockHanaFetch.mockResolvedValue(response({
      access: { isStudioOwner: true, isLocalOwner: false },
      registry: { revision: 9, digest: 'a'.repeat(64), degraded: false },
      sources: [
        { id: 'team-git', name: 'Team Git', kind: 'git', authority: 'custom', enabled: true, status: 'ok', catalogCount: 3, gitUrl: 'https://github.com/example-org/hana-market', gitRef: 'refs/tags/v1.2.0', indexPath: 'catalog/marketplace.json', mutable: true },
        { id: 'server-local', name: 'Server Local', kind: 'local', authority: 'custom', enabled: false, status: 'error', catalogCount: 0, path: '[redacted]', refreshError: { message: 'Catalog validation failed' }, mutable: true },
      ],
    }));

    render(<MarketplaceSourcesPanel embedded heading="Marketplace sources" />);

    expect(await screen.findByText('Team Git')).toBeInTheDocument();
    const sourceList = document.querySelector('[class*="marketplace-sources-list"]');
    expect(sourceList).toBeInTheDocument();
    expect(sourceList?.querySelectorAll('[class*="marketplace-source-row"]')).toHaveLength(2);
    expect(screen.getAllByText('Technical details')).toHaveLength(2);
    const sourceDetails = document.querySelectorAll('details');
    expect(sourceDetails).toHaveLength(2);
    expect(sourceDetails[0]).not.toHaveAttribute('open');
    fireEvent.click(sourceDetails[0].querySelector('summary')!);
    expect(sourceDetails[0]).toHaveAttribute('open');
    expect(sourceDetails[0]).toHaveTextContent('Location: https://github.com/example-org/hana-market');
    expect(sourceDetails[0]).toHaveTextContent('Git ref: refs/tags/v1.2.0');
    expect(sourceDetails[0]).toHaveTextContent('Index path: catalog/marketplace.json');
    expect(screen.getByText('3 packages')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    fireEvent.click(sourceDetails[1].querySelector('summary')!);
    expect(sourceDetails[1]).toHaveTextContent('Location: [server-local path redacted]');
    expect(sourceDetails[1]).toHaveTextContent('Diagnostics: Catalog validation failed');
  });

  it('uses visible localized labels for mutable source actions', async () => {
    mockHanaFetch.mockResolvedValue(response({
      access: { isStudioOwner: true },
      registry: { revision: 9, digest: 'a'.repeat(64), degraded: false },
      sources: [{
        id: 'team-git',
        name: 'Team Git',
        kind: 'git',
        authority: 'custom',
        enabled: true,
        status: 'ok',
        catalogCount: 3,
        mutable: true,
      }],
    }));

    render(<MarketplaceSourcesPanel />);

    const addButton = await screen.findByRole('button', { name: 'Add source' });
    expect(addButton.textContent).toContain('＋');
    expect(addButton.className).toMatch(/plugin-add-source-btn/);

    const refreshAll = screen.getByRole('button', { name: 'Reload source list' });
    expect(refreshAll.className).toMatch(/settings-icon-btn/);

    const refresh = screen.getByRole('button', { name: 'Refresh team-git' });
    expect(refresh).toHaveAttribute('title', 'Refresh team-git');
    expect(refresh).toHaveTextContent('Refresh');
    expect(refresh.className).toMatch(/pv-add-form-btn/);
    expect(refresh.className).toMatch(/plugin-labeled-action/);
    expect(refresh.className).not.toMatch(/skill-card-delete/);
    expect(refresh.parentElement?.className).toMatch(/marketplace-source-actions/);

    const remove = screen.getByRole('button', { name: 'Remove marketplace source team-git' });
    expect(remove).toHaveAttribute('title', 'Remove marketplace source team-git');
    expect(remove).toHaveTextContent('Remove');
    expect(remove.className).toMatch(/pv-add-form-btn/);
    expect(remove.className).toMatch(/plugin-labeled-action/);
    expect(remove.className).toMatch(/plugin-action-danger/);
    expect(remove.className).not.toMatch(/skill-card-delete/);

    const toggle = screen.getByRole('button', { name: 'Disable team-git' });
    expect(toggle).toHaveAttribute('title', 'Disable team-git');
    expect(toggle).toHaveTextContent('Disable');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle.className).toMatch(/pv-add-form-btn/);

    expect(Array.from(refresh.parentElement?.children || [])).toEqual([
      refresh,
      remove,
      toggle,
    ]);
  });

  it('keeps source refresh/remove callbacks and revision/digest behavior unchanged', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSourcesChanged = vi.fn();
    let loadCount = 0;
    const calls: Array<{ url: string; method?: string }> = [];
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        loadCount += 1;
        const postRefresh = loadCount === 2;
        const postRemove = loadCount === 3;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: 9, digest: 'a'.repeat(64), degraded: false },
          sources: postRemove
            ? []
            : postRefresh
              ? [{ id: 'team-git', name: 'Team Git', authority: 'custom', enabled: true, mutable: true, status: 'ok', catalogCount: 5 }]
              : [{ id: 'team-git', name: 'Team Git', authority: 'custom', enabled: true, mutable: true }],
        });
      }
      if (url === '/api/plugins/marketplace/sources/team-git/refresh') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedRevision: 9,
          expectedDigest: 'a'.repeat(64),
        });
        return response({ ok: true });
      }
      if (url === '/api/plugins/marketplace/sources/team-git?expectedRevision=9&expectedDigest=' + 'a'.repeat(64)) {
        expect(init?.method).toBe('DELETE');
        return response({ ok: true });
      }
      return response({});
    });

    render(<MarketplaceSourcesPanel onSourcesChanged={onSourcesChanged} />);
    expect(await screen.findByText('Team Git')).toBeInTheDocument();
    expect(onSourcesChanged).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh team-git' }));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('settings.plugins.marketSourceRefreshed', 'success'));
    await waitFor(() => expect(onSourcesChanged).toHaveBeenCalledExactlyOnceWith([
      { id: 'team-git', name: 'Team Git', authority: 'custom', enabled: true, mutable: true, status: 'ok', catalogCount: 5 },
    ]));

    onSourcesChanged.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove marketplace source team-git' }));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('settings.plugins.marketSourceRemoved', 'success'));
    await waitFor(() => expect(onSourcesChanged).toHaveBeenCalledExactlyOnceWith([]));
    expect(loadCount).toBeGreaterThanOrEqual(3);
    expect(calls).toContainEqual({
      url: '/api/plugins/marketplace/sources/team-git/refresh',
      method: 'POST',
    });
    expect(calls).toContainEqual({
      url: '/api/plugins/marketplace/sources/team-git?expectedRevision=9&expectedDigest=' + 'a'.repeat(64),
      method: 'DELETE',
    });
  });

  it('refreshes the source snapshot and retries a stale source refresh once', async () => {
    let loads = 0;
    const refreshBodies: unknown[] = [];
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        loads += 1;
        const fresh = loads > 1;
        return response({
          access: { isStudioOwner: true },
          registry: {
            revision: fresh ? 12 : 11,
            digest: (fresh ? 'c' : 'b').repeat(64),
            degraded: false,
          },
          sources: [{ id: 'team', name: 'Team', authority: 'custom', enabled: true, mutable: true }],
        });
      }
      if (url === '/api/plugins/marketplace/sources/team/refresh') {
        refreshBodies.push(JSON.parse(String(init?.body)));
        return refreshBodies.length === 1
          ? response({
              error: 'Marketplace registry revision conflict',
              code: 'PLUGIN_MARKETPLACE_REGISTRY_STALE',
            }, 409)
          : response({ ok: true });
      }
      return response({});
    });

    render(<MarketplaceSourcesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh team' }));

    await waitFor(() => expect(refreshBodies).toHaveLength(2));
    expect(refreshBodies).toEqual([
      { expectedRevision: 11, expectedDigest: 'b'.repeat(64) },
      { expectedRevision: 12, expectedDigest: 'c'.repeat(64) },
    ]);
    expect(mockShowToast).toHaveBeenCalledWith('settings.plugins.marketSourceRefreshed', 'success');
  });

  it('does not expose source mutation icons for immutable rows', async () => {
    mockHanaFetch.mockResolvedValue(response({
      access: { isStudioOwner: true },
      registry: { revision: 1, digest: 'b'.repeat(64), degraded: false },
      sources: [
        { id: 'official', name: 'Official', authority: 'official', mutable: false, enabled: true },
        { id: 'legacy', name: 'Legacy', authority: 'legacy', mutable: true, enabled: true },
      ],
    }));

    render(<MarketplaceSourcesPanel />);

    expect(await screen.findByText('Official')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh official' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove marketplace source official' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh legacy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove marketplace source legacy' })).not.toBeInTheDocument();
  });

  it('blocks mutation controls for non-owners while preserving read-only browsing', async () => {
    mockHanaFetch.mockResolvedValue(response({
      access: { isStudioOwner: false, isLocalOwner: false },
      registry: { revision: 2, digest: 'b'.repeat(64), degraded: false },
      sources: [{ id: 'team', name: 'Team', kind: 'git', authority: 'custom', enabled: true, status: 'ok', catalogCount: 1, mutable: true }],
    }));

    render(<MarketplaceSourcesPanel />);

    expect(await screen.findByText('Team')).toBeInTheDocument();
    expect(screen.getByText('Browsing is available. Source mutations need server owner access on this connection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add source' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Disable team' })).not.toBeInTheDocument();
  });

  it('opens an accessible one-textbox source dialog and restores focus after Escape', async () => {
    mockHanaFetch.mockResolvedValue(response({
      access: { isStudioOwner: true },
      registry: { revision: 1, digest: 'f'.repeat(64), degraded: false },
      sources: [],
    }));

    render(<MarketplaceSourcesPanel />);

    const refreshButton = await screen.findByRole('button', { name: 'Reload source list' });
    expect(refreshButton).toBeInTheDocument();
    const addButton = screen.getByRole('button', { name: 'Add source' });
    addButton.focus();
    fireEvent.click(addButton);

    expect(screen.getByRole('dialog', { name: 'Add Marketplace Source' })).toBeInTheDocument();
    const sourceInput = screen.getByRole('textbox', { name: 'Source' });
    expect(sourceInput).toHaveAttribute('name', 'marketplaceSource');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    await waitFor(() => expect(sourceInput).toHaveFocus());

    fireEvent.keyDown(sourceInput, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(addButton).toHaveFocus());
  });

  it('blocks source mutations when JSON is degraded and gives repair guidance', async () => {
    mockHanaFetch.mockResolvedValue(response({
      access: { isStudioOwner: true },
      registry: { revision: 4, digest: 'c'.repeat(64), degraded: true },
      sources: [{ id: 'team', name: 'Team', kind: 'git', authority: 'custom', enabled: true, status: 'stale', catalogCount: 2, mutable: true }],
    }));

    render(<MarketplaceSourcesPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Source changes are blocked while marketplace JSON is invalid');
    expect(screen.getByRole('button', { name: 'Add source' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Disable team' })).not.toBeInTheDocument();
  });

  it('confirms an exact source enable/disable action and sends revision/digest preconditions', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSourcesChanged = vi.fn();
    let loads = 0;
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        loads += 1;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: loads === 1 ? 5 : 6, digest: (loads === 1 ? 'd' : 'e').repeat(64), degraded: false },
          sources: [{ id: 'team', name: 'Team', kind: 'git', authority: 'custom', enabled: loads === 1, status: 'ok', catalogCount: 1, mutable: true }],
        });
      }
      if (url === '/api/plugins/marketplace/sources/team/enabled') {
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(String(init?.body))).toEqual({ enabled: false, expectedRevision: 5, expectedDigest: 'd'.repeat(64) });
        return response({ revision: 6 });
      }
      return response({});
    });

    render(<MarketplaceSourcesPanel onSourcesChanged={onSourcesChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable team' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Disable marketplace source team'));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Marketplace source team Disabled', 'success'));
    await waitFor(() => expect(onSourcesChanged).toHaveBeenCalledExactlyOnceWith([
      { id: 'team', name: 'Team', kind: 'git', authority: 'custom', enabled: false, status: 'ok', catalogCount: 1, mutable: true },
    ]));
  });

  it('refreshes sources and retries a stale source toggle once with the new registry preconditions', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSourcesChanged = vi.fn();
    let loads = 0;
    const toggleBodies: unknown[] = [];
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        loads += 1;
        const fresh = loads > 1;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: fresh ? 57 : 48, digest: (fresh ? 'f' : 'e').repeat(64), degraded: false },
          sources: [{ id: 'team', name: 'Team', kind: 'git', authority: 'custom', enabled: fresh ? false : true, mutable: true }],
        });
      }
      if (url === '/api/plugins/marketplace/sources/team/enabled') {
        toggleBodies.push(JSON.parse(String(init?.body)));
        return toggleBodies.length === 1
          ? response({
              error: 'Marketplace registry revision conflict: expected 48, current 57',
              code: 'PLUGIN_MARKETPLACE_REGISTRY_STALE',
            }, 409)
          : response({ revision: 58 });
      }
      return response({});
    });

    render(<MarketplaceSourcesPanel onSourcesChanged={onSourcesChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable team' }));

    await waitFor(() => expect(toggleBodies).toHaveLength(2));
    expect(toggleBodies).toEqual([
      { enabled: false, expectedRevision: 48, expectedDigest: 'e'.repeat(64) },
      { enabled: false, expectedRevision: 57, expectedDigest: 'f'.repeat(64) },
    ]);
    expect(mockShowToast).toHaveBeenCalledWith('Marketplace source team Disabled', 'success');
    await waitFor(() => expect(onSourcesChanged).toHaveBeenCalledExactlyOnceWith([
      { id: 'team', name: 'Team', kind: 'git', authority: 'custom', enabled: false, mutable: true },
    ]));
  });

  it('does not notify or reload sources for read-only source loads or callback identity changes', async () => {
    const firstCallback = vi.fn();
    const latestCallback = vi.fn();
    let reads = 0;
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        reads += 1;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: 1, digest: 'a'.repeat(64), degraded: false },
          sources: [{ id: 'team', name: 'Team', authority: 'custom', enabled: true, mutable: true }],
        });
      }
      return response({});
    });

    const { rerender } = render(<MarketplaceSourcesPanel onSourcesChanged={firstCallback} />);

    // 1. Initial render produces one source GET, renders Team, calls neither callback
    expect(await screen.findByText('Team')).toBeInTheDocument();
    expect(reads).toBe(1);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(latestCallback).not.toHaveBeenCalled();

    // 2. Clicking Reload produces a second source GET but still calls no callback
    fireEvent.click(screen.getByRole('button', { name: 'Reload source list' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(firstCallback).not.toHaveBeenCalled();
    expect(latestCallback).not.toHaveBeenCalled();

    // 3. Rerendering with a new callback identity does not produce a third GET
    //    and calls neither the old nor the new callback.
    const { act } = await import('react');
    rerender(<MarketplaceSourcesPanel onSourcesChanged={latestCallback} />);
    await act(async () => { await Promise.resolve(); });
    expect(reads).toBe(2);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(latestCallback).not.toHaveBeenCalled();
  });

  it('submits a one-field Git source through the compact server request boundary', async () => {
    const firstCallback = vi.fn();
    const latestCallback = vi.fn();
    let reads = 0;
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        reads += 1;
        const empty = reads === 1;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: empty ? 7 : 8, digest: (empty ? 'a' : 'b').repeat(64), degraded: false },
          sources: empty ? [] : [{ id: 'team', name: 'Team', authority: 'custom', enabled: true, mutable: true }],
        });
      }
      if (url === '/api/plugins/marketplace/sources' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          source: 'https://github.com/example-org/hana-market',
          expectedRevision: 7,
          expectedDigest: 'a'.repeat(64),
        });
        return response({}, 201);
      }
      return response({});
    });

    const { rerender } = render(<MarketplaceSourcesPanel onSourcesChanged={firstCallback} />);

    // 1. Initial render — callback not called yet
    expect(await screen.findByText('settings.plugins.marketSourceEmpty')).toBeInTheDocument();
    expect(reads).toBe(1);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(latestCallback).not.toHaveBeenCalled();

    // 2. Rerender with latestCallback — no new GET, no callback
    const { act } = await import('react');
    rerender(<MarketplaceSourcesPanel onSourcesChanged={latestCallback} />);
    await act(async () => { await Promise.resolve(); });
    expect(reads).toBe(1);
    expect(latestCallback).not.toHaveBeenCalled();
    expect(firstCallback).not.toHaveBeenCalled();

    // 3. Add source via dialog
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    const sourceInput = screen.getByRole('textbox', { name: 'Source' });
    fireEvent.change(sourceInput, { target: { value: 'https://github.com/example-org/hana-market' } });
    expect(screen.getByText('Detected: public HTTPS Git repository')).toBeInTheDocument();
    fireEvent.submit(sourceInput.closest('form')!);

    // 4. Dialog closes after onSubmit returns, then latestCallback fires with the refreshed list
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockShowToast).toHaveBeenCalledWith('settings.plugins.marketSourceAdded', 'success');
    expect(reads).toBe(2);
    await waitFor(() => expect(latestCallback).toHaveBeenCalledExactlyOnceWith([{ id: 'team', name: 'Team', authority: 'custom', enabled: true, mutable: true }]));
    expect(firstCallback).not.toHaveBeenCalled();
  });

  it('keeps a failed Add Source dialog open with its input and inline error', async () => {
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        return response({
          access: { isStudioOwner: true },
          registry: { revision: 7, digest: 'a'.repeat(64), degraded: false },
          sources: [],
        });
      }
      if (url === '/api/plugins/marketplace/sources' && init?.method === 'POST') {
        return response({ error: 'This source already exists.' }, 409);
      }
      return response({});
    });

    render(<MarketplaceSourcesPanel />);
    await screen.findByText('settings.plugins.marketSourceEmpty');
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    const sourceInput = screen.getByRole('textbox', { name: 'Source' });
    fireEvent.change(sourceInput, { target: { value: 'https://example.com/marketplace.json' } });
    fireEvent.submit(sourceInput.closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent('This source already exists.');
    expect(screen.getByRole('dialog', { name: 'Add Marketplace Source' })).toBeInTheDocument();
    expect(sourceInput).toHaveValue('https://example.com/marketplace.json');
    expect(mockShowToast).toHaveBeenCalledWith('This source already exists.', 'error');
  });
});
