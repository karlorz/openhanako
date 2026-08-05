/**
 * @vitest-environment jsdom
 *
 * Config-editor identity isolation (review finding): when the open config
 * editor switches from plugin A to plugin B, the editor must remount per
 * plugin so A's draft/pluginConfig is never visible or savable under B's
 * identity. B's config fetch is held pending to make the transient window
 * deterministic.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSettingsStore } from '../../settings/store';

const hanaFetch = vi.fn();

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
  hanaUrl: (path: string) => path,
  yuanFallbackAvatar: () => 'data:image/svg+xml,avatar',
}));

vi.mock('../../settings/components/MarketplaceSourcesPanel', () => ({
  MarketplaceSourcesPanel: () => <div data-testid="marketplace-sources-panel" />,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function communityPlugin(id: string, name: string) {
  return {
    id,
    name,
    status: 'loaded',
    source: 'community',
    trust: 'full-access',
    contributions: ['configuration'],
  };
}

const configSchema = {
  properties: {
    apiKey: { type: 'string', title: 'API Key' },
  },
};

describe('PluginsTab config editor identity isolation', () => {
  beforeEach(() => {
    hanaFetch.mockReset();
    window.t = ((key: string, params?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'settings.plugins.configure': `Configure ${params?.name || ''}`.trim(),
        'settings.plugins.configTitle': `Configure ${params?.name || ''}`.trim(),
        'settings.api.save': 'Save',
        'settings.autoSaved': 'Saved',
        'settings.saveFailed': 'Save failed',
      };
      return labels[key] || key;
    }) as typeof window.t;
    window.platform = {
      selectFile: vi.fn(),
      selectDirectory: vi.fn(),
      showInFinder: vi.fn(),
      selectPlugin: vi.fn(),
      getFilePath: vi.fn(),
    } as unknown as typeof window.platform;
    useSettingsStore.setState({
      pluginAllowFullAccess: false,
      pluginDevToolsEnabled: false,
      pluginUserDir: '',
      toastMessage: '',
      toastType: '',
      toastVisible: false,
      activeTab: 'plugins',
      set: useSettingsStore.getState().set,
      showToast: useSettingsStore.getState().showToast,
    } as never);
  });

  afterEach(() => {
    cleanup();
    hanaFetch.mockReset();
    vi.unstubAllGlobals();
  });

  it('remounts the config editor per plugin so a switched plugin never shows or saves the previous draft', async () => {
    let resolveBConfig: ((data: unknown) => void) | undefined;
    const puts: Array<{ path: string; body: unknown }> = [];
    hanaFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/plugins?source=community') {
        return jsonResponse([communityPlugin('plugin-a', 'Alpha'), communityPlugin('plugin-b', 'Beta')]);
      }
      if (path === '/api/plugins/marketplace/installed-skill-packages') {
        return jsonResponse({
          packages: [],
          registry: null,
          access: { isStudioOwner: true, isLocalOwner: true },
          activations: {},
        });
      }
      if (path === '/api/plugins/plugin-a/config' && !init?.method) {
        return jsonResponse({ pluginId: 'plugin-a', schema: configSchema, values: { apiKey: 'aaa' } });
      }
      if (path === '/api/plugins/plugin-b/config' && !init?.method) {
        // Held pending: the switch transient must be deterministic.
        return new Promise<Response>((resolve) => {
          resolveBConfig = (data: unknown) => resolve(jsonResponse(data));
        });
      }
      if (path === '/api/plugins/plugin-b/config' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body || '{}'));
        puts.push({ path, body });
        return jsonResponse({ pluginId: 'plugin-b', schema: configSchema, values: body.values });
      }
      return jsonResponse({});
    });

    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    // Open Alpha's editor and dirty its draft.
    fireEvent.click(await screen.findByRole('button', { name: 'Configure Alpha' }));
    const alphaInput = await screen.findByDisplayValue('aaa');
    fireEvent.change(alphaInput, { target: { value: 'changed-aaa' } });
    expect(screen.getByDisplayValue('changed-aaa')).toBeInTheDocument();

    // Switch to Beta. While Beta's config fetch is still pending, Alpha's
    // draft must not be visible or savable under Beta's identity.
    fireEvent.click(screen.getByRole('button', { name: 'Configure Beta' }));
    expect(screen.queryByDisplayValue('changed-aaa')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    // Once Beta's fetch resolves, the editor shows Beta's own values with a
    // clean (disabled) save button.
    resolveBConfig?.({ pluginId: 'plugin-b', schema: configSchema, values: { apiKey: 'bbb' } });
    const betaInput = await screen.findByDisplayValue('bbb');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    // Editing and saving Beta writes only Beta's values to Beta's route.
    fireEvent.change(betaInput, { target: { value: 'changed-bbb' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      path: '/api/plugins/plugin-b/config',
      body: { values: { apiKey: 'changed-bbb' } },
    });
  });
});
