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
    window.t = ((key: string) => {
      const labels: Record<string, string> = {
        'settings.plugins.marketSourceAdd': 'Add source',
        'settings.plugins.marketSourceCancel': 'Cancel',
        'settings.plugins.marketSourceRefreshAll': 'Reload source list',
        'settings.plugins.marketSourceRefresh': 'Refresh',
        'settings.plugins.marketSourceRemove': 'Remove',
        'settings.plugins.marketSourceStatusOk': 'OK',
        'settings.plugins.marketSourceStatusError': 'Error',
        'settings.plugins.marketSourceStatusStale': 'Stale',
        'settings.plugins.marketSourceAuthorityCustom': 'Custom',
        'settings.plugins.marketSourceKindGit': 'Git (public HTTPS)',
        'settings.plugins.marketSourceKindLocal': 'Local (server path)',
        'settings.plugins.marketSourceId': 'Source ID',
        'settings.plugins.marketSourceName': 'Source name',
        'settings.plugins.marketSourceKind': 'Source kind',
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

    render(<MarketplaceSourcesPanel />);

    expect(await screen.findByText('Team Git')).toBeInTheDocument();
    expect(screen.getByText('https://github.com/example-org/hana-market · refs/tags/v1.2.0 · catalog/marketplace.json')).toBeInTheDocument();
    expect(screen.getByText('3 packages')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('[server-local path redacted]')).toBeInTheDocument();
    expect(screen.getByText('Catalog validation failed')).toBeInTheDocument();
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

  it('labels refresh and source form controls for keyboard and assistive technology', async () => {
    mockHanaFetch.mockResolvedValue(response({
      access: { isStudioOwner: true },
      registry: { revision: 1, digest: 'f'.repeat(64), degraded: false },
      sources: [],
    }));

    render(<MarketplaceSourcesPanel />);

    expect(await screen.findByRole('button', { name: 'Reload source list' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    expect(screen.getByRole('textbox', { name: 'Source ID' })).toHaveAttribute('name', 'marketplaceSourceId');
    expect(screen.getByRole('textbox', { name: 'Source name' })).toHaveAttribute('name', 'marketplaceSourceName');
    expect(screen.getByRole('combobox', { name: 'Source kind' })).toHaveAttribute('name', 'marketplaceSourceKind');
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
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Marketplace source team disabled', 'success'));
  });
});
