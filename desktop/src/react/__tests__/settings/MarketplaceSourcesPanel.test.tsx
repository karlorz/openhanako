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
    expect(screen.getByText('https://github.com/example-org/hana-market · refs/tags/v1.2.0 · catalog/marketplace.json')).toBeInTheDocument();
    expect(screen.getByText('3 packages')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('[server-local path redacted]')).toBeInTheDocument();
    expect(screen.getByText('Catalog validation failed')).toBeInTheDocument();
  });

  it('uses the existing bare icon language for mutable source actions', async () => {
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
    expect(refresh.className).toMatch(/settings-icon-btn/);
    expect(refresh.className).toMatch(/plugin-action-icon/);
    expect(refresh.className).not.toMatch(/skill-card-delete/);
    expect(refresh.parentElement?.className).toMatch(/marketplace-source-actions/);

    const remove = screen.getByRole('button', { name: 'Remove marketplace source team-git' });
    expect(remove).toHaveAttribute('title', 'Remove marketplace source team-git');
    expect(remove.className).toMatch(/settings-icon-btn/);
    expect(remove.className).toMatch(/plugin-action-icon/);
    expect(remove.className).toMatch(/plugin-action-danger/);
    expect(remove.className).not.toMatch(/skill-card-delete/);

    const toggle = screen.getByRole('button', { name: 'Disable team-git' });
    expect(toggle).toHaveAttribute('title', 'Disable team-git');
    expect(toggle.className).toMatch(/hana-toggle/);
    expect(toggle.className).toMatch(/on/);
    expect(toggle.className).not.toMatch(/pv-add-form-btn/);

    expect(Array.from(refresh.parentElement?.children || [])).toEqual([
      refresh,
      remove,
      toggle,
    ]);
  });

  it('keeps source refresh/remove callbacks and revision/digest behavior unchanged', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let loadCount = 0;
    const calls: Array<{ url: string; method?: string }> = [];
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        loadCount += 1;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: 9, digest: 'a'.repeat(64), degraded: false },
          sources: [{ id: 'team-git', name: 'Team Git', authority: 'custom', enabled: true, mutable: true }],
        });
      }
      if (url === '/api/plugins/marketplace/sources/team-git/refresh') {
        expect(init?.method).toBe('POST');
        return response({ ok: true });
      }
      if (url === '/api/plugins/marketplace/sources/team-git?expectedRevision=9&expectedDigest=' + 'a'.repeat(64)) {
        expect(init?.method).toBe('DELETE');
        return response({ ok: true });
      }
      return response({});
    });

    render(<MarketplaceSourcesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh team-git' }));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('settings.plugins.marketSourceRefreshed', 'success'));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove marketplace source team-git' }));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('settings.plugins.marketSourceRemoved', 'success'));
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
    let loads = 0;
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        loads += 1;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: loads === 1 ? 5 : 6, digest: (loads === 1 ? 'd' : 'e').repeat(64), degraded: false },
          sources: [{ id: 'team', name: 'Team', kind: 'git', authority: 'custom', enabled: true, status: 'ok', catalogCount: 1, mutable: true }],
        });
      }
      if (url === '/api/plugins/marketplace/sources/team/enabled') {
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(String(init?.body))).toEqual({ enabled: false, expectedRevision: 5, expectedDigest: 'd'.repeat(64) });
        return response({ revision: 6 });
      }
      return response({});
    });

    render(<MarketplaceSourcesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable team' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Disable marketplace source team'));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Marketplace source team Disabled', 'success'));
  });

  it('refreshes sources and retries a stale source toggle once with the new registry preconditions', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let loads = 0;
    const toggleBodies: unknown[] = [];
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        loads += 1;
        const fresh = loads > 1;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: fresh ? 57 : 48, digest: (fresh ? 'f' : 'e').repeat(64), degraded: false },
          sources: [{ id: 'team', name: 'Team', kind: 'git', authority: 'custom', enabled: true, mutable: true }],
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

    render(<MarketplaceSourcesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable team' }));

    await waitFor(() => expect(toggleBodies).toHaveLength(2));
    expect(toggleBodies).toEqual([
      { enabled: false, expectedRevision: 48, expectedDigest: 'e'.repeat(64) },
      { enabled: false, expectedRevision: 57, expectedDigest: 'f'.repeat(64) },
    ]);
    expect(mockShowToast).toHaveBeenCalledWith('Marketplace source team Disabled', 'success');
  });

  it('submits a one-field Git source through the compact server request boundary', async () => {
    let loads = 0;
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/sources' && !init?.method) {
        loads += 1;
        return response({
          access: { isStudioOwner: true },
          registry: { revision: loads === 1 ? 7 : 8, digest: (loads === 1 ? 'a' : 'b').repeat(64), degraded: false },
          sources: [],
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

    render(<MarketplaceSourcesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add source' }));
    const sourceInput = screen.getByRole('textbox', { name: 'Source' });
    fireEvent.change(sourceInput, { target: { value: 'https://github.com/example-org/hana-market' } });
    expect(screen.getByText('Detected: public HTTPS Git repository')).toBeInTheDocument();
    fireEvent.submit(sourceInput.closest('form')!);

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('settings.plugins.marketSourceAdded', 'success'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
