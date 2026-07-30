/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginMarketplaceTab } from '../../settings/tabs/PluginMarketplaceTab';

const mockHanaFetch = vi.fn();
const mockSet = vi.fn();
const mockShowToast = vi.fn();

vi.mock('../../settings/store', () => ({
  useSettingsStore: (selector?: (state: any) => unknown) => {
    const state = { set: mockSet, showToast: mockShowToast };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockHanaFetch(...args),
}));

vi.mock('../../settings/components/MarketplaceSourcesPanel', () => ({
  MarketplaceSourcesPanel: () => <div data-testid="marketplace-sources-panel" />,
}));

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (markdown: string) => markdown,
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

function catalogPlugin(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: 'skillwiki',
    id: 'skillwiki',
    name: 'skillwiki',
    version: '0.10.22',
    description: 'SkillWiki skills',
    publisher: 'llm-wiki',
    trust: 'restricted',
    marketplaceId: 'llm-wiki',
    compositeKey: 'skillwiki@llm-wiki',
    sourceAuthority: 'custom',
    sourceStatus: 'ok',
    catalogFormat: 'claude',
    installTarget: 'hana-skills',
    installAdapter: 'skill-manager',
    installable: true,
    confirmationLevel: 'inline',
    capabilityInventory: {
      skills: ['skillwiki'],
      nativePluginContributions: [],
      agentFacing: ['skills'],
      serverImpact: [],
      unsupportedClaudeComponents: [],
    },
    warnings: [],
    installPlan: {
      action: 'install',
      destination: 'hana-skills',
      installAdapter: 'skill-manager',
      confirmationLevel: 'inline',
      warnings: [],
      installable: true,
    },
    canInstall: true,
    active: false,
    ...overrides,
  };
}

function mockCatalog(plugins: unknown[]) {
  mockHanaFetch.mockImplementation(async (url: string) => {
    if (url === '/api/plugins/marketplace/catalog') {
      return jsonResponse({ plugins, sources: [], warnings: [] });
    }
    if (url.includes('/readme')) {
      return jsonResponse({ markdown: '' });
    }
    if (url === '/api/plugins/marketplace/sources') {
      return jsonResponse({ sources: [] });
    }
    return jsonResponse({ ok: true, name: 'skillwiki' });
  });
}

describe('PluginMarketplaceTab inspector rendering', () => {
  beforeEach(() => {
    mockHanaFetch.mockReset();
    mockSet.mockReset();
    mockShowToast.mockReset();
    window.t = ((key: string) => {
      const labels: Record<string, string> = {
        'settings.plugins.marketBack': 'Back',
        'settings.plugins.marketplaceHint': 'Install marketplace packages',
        'settings.plugins.marketplaceCount': '1 package',
        'settings.plugins.marketLoading': 'Loading...',
        'settings.plugins.marketInstall': 'Install',
        'settings.plugins.marketInstallSkills': 'Install skills',
        'settings.plugins.marketIncompatible': 'Incompatible',
        'settings.plugins.marketSelectPlugin': 'Select a package',
      };
      return labels[key] || key;
    }) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders source-qualified identity and inspector fields for Hana skill packages', async () => {
    mockCatalog([catalogPlugin()]);

    render(<PluginMarketplaceTab />);

    expect((await screen.findAllByText('skillwiki@llm-wiki')).length).toBeGreaterThan(0);
    expect(screen.getByText('Install Target')).toBeInTheDocument();
    expect(screen.getAllByText('Hana skills').length).toBeGreaterThan(0);
    expect(screen.getByText('Install Adapter')).toBeInTheDocument();
    expect(screen.getAllByText('Skill manager').length).toBeGreaterThan(0);
    expect(screen.getByText('Confirmation')).toBeInTheDocument();
    expect(screen.getByText('Inline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install skills' })).toBeEnabled();
    expect(screen.getByText('Agent-facing')).toBeInTheDocument();
    expect(screen.getAllByText('skills').length).toBeGreaterThan(0);
  });

  it('shows unsupported packages as inspect only and disables install', async () => {
    mockCatalog([
      catalogPlugin({
        installTarget: 'unsupported',
        installAdapter: 'none',
        installable: false,
        canInstall: false,
        confirmationLevel: 'capability-review',
        capabilityInventory: {
          skills: [],
          nativePluginContributions: [],
          agentFacing: [],
          serverImpact: [],
          unsupportedClaudeComponents: ['hooks'],
        },
        warnings: ['Claude package source kind is not installable in Hana v1: git-subdir'],
        installPlan: {
          action: 'install',
          destination: 'unsupported',
          installAdapter: 'none',
          confirmationLevel: 'capability-review',
          warnings: ['Claude package source kind is not installable in Hana v1: git-subdir'],
          installable: false,
        },
      }),
    ]);

    render(<PluginMarketplaceTab />);

    expect((await screen.findAllByText('Unsupported')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Inspect only' })).toBeDisabled();
    expect(screen.getByText('Unsupported Claude components')).toBeInTheDocument();
    expect(screen.getByText('hooks')).toBeInTheDocument();
    expect(screen.getByText('Warnings')).toBeInTheDocument();
    expect(screen.getByText('Claude package source kind is not installable in Hana v1: git-subdir')).toBeInTheDocument();
  });

  it('requires typed-exact confirmation before native marketplace install mutation', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('native-page@official');
    mockCatalog([
      catalogPlugin({
        pluginId: 'native-page',
        id: 'native-page',
        name: 'Native Page',
        publisher: 'Hana',
        trust: 'full-access',
        marketplaceId: 'official',
        compositeKey: 'native-page@official',
        catalogFormat: null,
        installTarget: 'native-plugin',
        installAdapter: 'plugin-manager',
        confirmationLevel: 'typed-exact',
        capabilityInventory: {
          skills: [],
          nativePluginContributions: ['tools', 'routes'],
          agentFacing: ['tools'],
          serverImpact: ['routes'],
          unsupportedClaudeComponents: [],
        },
        warnings: ['native plugin requests full-access review'],
        installPlan: {
          action: 'install',
          destination: 'native-plugin',
          installAdapter: 'plugin-manager',
          confirmationLevel: 'typed-exact',
          warnings: ['native plugin requests full-access review'],
          installable: true,
        },
      }),
    ]);

    render(<PluginMarketplaceTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(promptSpy).toHaveBeenCalledWith(expect.stringContaining('Type native-page@official to install.'));
    });
    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/plugins/marketplace/native-page/install', expect.objectContaining({
        method: 'POST',
      }));
    });
  });
});
