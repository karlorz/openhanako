/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSettingsStore } from '../../settings/store';

const hanaFetch = vi.fn();
const mockConfirm = vi.fn();

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
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

const skillPackageRow = {
  kind: 'marketplace-skill-package',
  identity: 'skillwiki@llm-wiki',
  pluginId: 'skillwiki',
  marketplaceId: 'llm-wiki',
  name: 'SkillWiki',
  version: '0.10.22',
  description: 'Wiki skills package',
  packageState: 'installed',
  packageEnabled: true,
  packageGateRecorded: false,
  packageGateState: 'default-enabled',
  skillNames: ['wiki-query', 'wiki-write'],
  skillCount: 2,
  missingSkillNames: [],
  invalidSkillNames: [],
  sourceStatus: 'ok',
  installAdapter: 'skill-manager',
  installTarget: 'hana-skills',
  actions: {
    canToggle: true,
    canUninstall: true,
    canOpenSkills: true,
    canReinstall: true,
  },
};

const inventoryActivations = {
  marketplaceSkillPackages: {},
  marketplaceSkills: { 'wiki-query@llm-wiki/skillwiki': { enabled: true } },
  runtimePlugins: { 'demo@llm-wiki': { enabled: true } },
};

const inventoryRegistry = {
  revision: 7,
  digest: 'a'.repeat(64),
};

function skillPackageInventory(overrides: Record<string, unknown> = {}) {
  return {
    packages: [skillPackageRow],
    registry: inventoryRegistry,
    access: { isStudioOwner: true, isLocalOwner: true },
    activations: structuredClone(inventoryActivations),
    ...overrides,
  };
}

function mockInventory(options: {
  plugins?: unknown[];
  inventory?: Record<string, unknown>;
  onPut?: (body: unknown) => void;
  onDelete?: (path: string, body: unknown) => void;
} = {}) {
  const plugins = options.plugins ?? [];
  const inventory = options.inventory ?? skillPackageInventory();
  hanaFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/plugins?source=community') {
      return jsonResponse(plugins);
    }
    if (path === '/api/plugins/marketplace/installed-skill-packages') {
      return jsonResponse(inventory);
    }
    if (path === '/api/plugins/marketplace/config/activations' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      options.onPut?.(body);
      return jsonResponse({ ok: true, activations: body.activations, registry: inventoryRegistry });
    }
    if (
      typeof path === 'string'
      && path.startsWith('/api/plugins/marketplace/')
      && path.endsWith('/skills')
      && init?.method === 'DELETE'
    ) {
      const body = JSON.parse(String(init.body || '{}'));
      options.onDelete?.(path, body);
      return jsonResponse({ ok: true, deleted: ['wiki-query', 'wiki-write'], complete: true });
    }
    if (typeof path === 'string' && path.startsWith('/api/plugins/') && init?.method === 'DELETE') {
      options.onDelete?.(path, null);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({});
  });
}

describe('PluginsTab skill package inventory', () => {
  beforeEach(() => {
    hanaFetch.mockReset();
    mockConfirm.mockReset();
    mockConfirm.mockReturnValue(true);
    vi.stubGlobal('confirm', mockConfirm);
    window.t = ((key: string, params?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'settings.plugins.skillPackageKind': 'Hana skills',
        'settings.plugins.skillPackageStatusEnabled': 'enabled',
        'settings.plugins.skillPackageStatusDisabled': 'disabled',
        'settings.plugins.skillPackageStatusPartial': 'partial',
        'settings.plugins.skillPackageStatusStale': 'stale',
        'settings.plugins.skillPackageToggle': `Toggle package ${params?.identity || ''}`.trim(),
        'settings.plugins.skillPackageUninstallConfirm':
          `Uninstall ${params?.identity || ''} (${params?.skillCount || '0'} skills)?`,
        'settings.plugins.skillPackageManageInSkills': 'Manage in Skills',
        'settings.plugins.empty': 'No plugins installed',
        'settings.plugins.manageTitle': 'Manage Plugins',
        'settings.plugins.reload': 'Reload',
        'settings.plugins.showDiagnostics': 'Show diagnostics',
        'settings.plugins.openMarketplace': 'Open plugin marketplace',
        'settings.plugins.marketplaceTitle': 'Plugin Marketplace',
        'settings.plugins.marketplaceHint': 'Browse plugins',
        'settings.plugins.marketSourcesSection': 'Marketplace sources',
        'settings.plugins.dropzone': 'Drop plugins here',
        'settings.plugins.permissionTitle': 'Permissions',
        'settings.plugins.fullAccessToggle': 'Full access',
        'settings.plugins.fullAccessDesc': 'Full access desc',
        'settings.plugins.devToolsToggle': 'Dev tools',
        'settings.plugins.devToolsDesc': 'Dev tools desc',
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

  it('renders a marketplace skill package row with Hana skills kind and enabled status', async () => {
    mockInventory();
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    expect(await screen.findByText('SkillWiki')).toBeInTheDocument();
    expect(screen.getByText('skillwiki@llm-wiki')).toBeInTheDocument();
    expect(screen.getByText('Hana skills')).toBeInTheDocument();
    expect(screen.getByText('enabled')).toBeInTheDocument();
    expect(screen.queryByText('loaded')).not.toBeInTheDocument();
    expect(screen.queryByText('No plugins installed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage in Skills' })).toBeInTheDocument();
  });

  it('does not claim empty inventory when only skill packages are installed', async () => {
    mockInventory({ plugins: [] });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    expect(await screen.findByText('SkillWiki')).toBeInTheDocument();
    expect(screen.queryByText('No plugins installed')).not.toBeInTheDocument();
  });

  it('uninstalls skill packages via DELETE .../skills with marketplace revision body', async () => {
    const deletes: Array<{ path: string; body: unknown }> = [];
    mockInventory({
      onDelete: (path, body) => {
        deletes.push({ path, body });
      },
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    const uninstall = await screen.findByTitle(/Uninstall skillwiki@llm-wiki/);
    fireEvent.click(uninstall);

    await waitFor(() => expect(deletes.length).toBe(1));
    expect(deletes[0].path).toBe('/api/plugins/marketplace/skillwiki/skills');
    expect(deletes[0].body).toEqual({
      marketplaceId: 'llm-wiki',
      expectedRevision: 7,
      expectedDigest: 'a'.repeat(64),
    });
    expect(deletes.some((d) => d.path === '/api/plugins/skillwiki')).toBe(false);
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('toggles package gate via activations PUT that clones sibling maps', async () => {
    const puts: unknown[] = [];
    mockInventory({
      onPut: (body) => {
        puts.push(body);
      },
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    const toggle = await screen.findByRole('button', { name: /Toggle package skillwiki@llm-wiki/ });
    fireEvent.click(toggle);

    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({
      activations: {
        marketplaceSkillPackages: {
          'skillwiki@llm-wiki': { enabled: false },
        },
        marketplaceSkills: { 'wiki-query@llm-wiki/skillwiki': { enabled: true } },
        runtimePlugins: { 'demo@llm-wiki': { enabled: true } },
      },
      expectedRevision: 7,
      expectedDigest: 'a'.repeat(64),
    });
  });

  it('refuses package gate toggle when inventory has no activations snapshot', async () => {
    const puts: unknown[] = [];
    mockInventory({
      inventory: skillPackageInventory({ activations: null }),
      onPut: (body) => {
        puts.push(body);
      },
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    const toggle = await screen.findByRole('button', { name: /Toggle package skillwiki@llm-wiki/ });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(useSettingsStore.getState().toastType).toBe('error');
    });
    expect(useSettingsStore.getState().toastMessage).toContain('missing activations snapshot');
    expect(puts.length).toBe(0);
    expect(
      hanaFetch.mock.calls.some(
        ([path, init]) =>
          path === '/api/plugins/marketplace/config/activations' && init?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it('hides package toggle when row.actions.canToggle is false', async () => {
    mockInventory({
      inventory: skillPackageInventory({
        packages: [{
          ...skillPackageRow,
          actions: { ...skillPackageRow.actions, canToggle: false },
        }],
      }),
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    expect(await screen.findByText('SkillWiki')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Toggle package skillwiki@llm-wiki/ })).not.toBeInTheDocument();
    expect(screen.getByTitle(/Uninstall skillwiki@llm-wiki/)).toBeInTheDocument();
  });

  it('navigates Manage in Skills to the skills settings tab', async () => {
    mockInventory();
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage in Skills' }));
    expect(useSettingsStore.getState().activeTab).toBe('skills');
  });

  it('hides owner actions for non-owners but still shows the inventory row', async () => {
    mockInventory({
      inventory: skillPackageInventory({
        access: { isStudioOwner: false, isLocalOwner: false },
        activations: undefined,
      }),
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    expect(await screen.findByText('SkillWiki')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Toggle package skillwiki@llm-wiki/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Uninstall skillwiki@llm-wiki/)).not.toBeInTheDocument();
  });

  it('shows disabled / partial / stale badges, never native loaded', async () => {
    mockInventory({
      inventory: skillPackageInventory({
        packages: [
          { ...skillPackageRow, identity: 'a@src', pluginId: 'a', name: 'A', packageEnabled: false, packageState: 'installed' },
          { ...skillPackageRow, identity: 'b@src', pluginId: 'b', name: 'B', packageEnabled: true, packageState: 'partial' },
          { ...skillPackageRow, identity: 'c@src', pluginId: 'c', name: 'C', packageEnabled: true, packageState: 'stale-record' },
        ],
      }),
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    expect(await screen.findByText('A')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
    expect(screen.getByText('partial')).toBeInTheDocument();
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.queryByText('loaded')).not.toBeInTheDocument();
  });
});
