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

function marketplaceSkill(
  name: string,
  identity = 'skillwiki@llm-wiki',
  enabled = true,
  overrides: Record<string, unknown> = {},
) {
  return {
    name,
    description: `${name} description`,
    source: 'user',
    enabled,
    active: enabled,
    configurable: true,
    readonly: false,
    marketplacePackage: {
      identity,
      skillName: name,
      explicitlyDisabled: !enabled,
      packageEnabled: true,
    },
    ...overrides,
  };
}

function mockInventory(options: {
  plugins?: unknown[];
  inventory?: Record<string, unknown>;
  onPut?: (body: unknown) => void;
  onDelete?: (path: string, body: unknown) => void;
  skills?: Record<string, unknown[]>;
  onPatch?: (path: string, body: unknown) => void;
  patchFailures?: Set<string>;
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
    if (typeof path === 'string' && path.startsWith('/api/skills?')) {
      const agentId = new URLSearchParams(path.split('?')[1]).get('agentId') || '';
      return jsonResponse({ skills: options.skills?.[agentId] || [] });
    }
    if (typeof path === 'string' && path.startsWith('/api/plugins/') && path.endsWith('/config') && !init?.method) {
      return jsonResponse({ schema: { properties: {} }, values: {} });
    }
    if (typeof path === 'string' && path.startsWith('/api/agents/') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body || '{}'));
      options.onPatch?.(path, body);
      const skillName = decodeURIComponent(path.split('/').pop() || '');
      if (options.patchFailures?.has(skillName)) return jsonResponse({ error: `failed ${skillName}` }, 500);
      return jsonResponse({ ok: true });
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
        'settings.plugins.skillPackageOpenSkills': `Open skills for ${params?.name || ''}`.trim(),
        'settings.plugins.skillPackageOpenArea': `Open the ${params?.name || ''} skill package`.trim(),
        'settings.plugins.skillPackagePageBreadcrumb': 'Skill package navigation',
        'settings.plugins.skillPackagePageAvailability': 'Package availability',
        'settings.plugins.skillPackagePageSkills': 'Skills',
        'settings.plugins.skillPackagePageOpenMarketplace': 'Open marketplace',
        'settings.plugins.skillPackagePageGlobalEnabled': 'Available to all Agents',
        'settings.plugins.skillPackagePageGlobalDisabled': 'Unavailable to all Agents',
        'settings.plugins.skillPackagePageSourceBlocked': 'Source unavailable; preferences preserved.',
        'settings.plugins.skillPackagePageSourceBlockedLabel': 'source unavailable',
        'settings.plugins.skillPackagePageDisabledHint': 'Disabled globally; preferences preserved.',
        'settings.plugins.skillPackagePageAvailabilityHint': 'Package availability hint',
        'settings.plugins.skillPackagePagePartialHint': 'Partially installed.',
        'settings.plugins.skillPackagePageStaleHint': 'Stale install record.',
        'settings.plugins.skillPackagePagePreferencesPreserved': 'Preferences are preserved while unavailable.',
        'settings.plugins.skillPackagePageAgentHint': 'Changes apply only to the selected Agent.',
        'settings.plugins.skillPackagePageSummary': `${params?.installed || '0'} installed · ${params?.enabled || '0'} enabled · ${params?.disabled || '0'} disabled`,
        'settings.plugins.skillPackagePageEnableAll': 'Enable all',
        'settings.plugins.skillPackagePageDisableAll': 'Disable all',
        'settings.plugins.skillPackagePageBatchNoop': 'No changes needed.',
        'settings.plugins.skillPackagePageBatchSuccess': `${params?.action || ''}: ${params?.count || '0'} skill(s) updated.`,
        'settings.plugins.skillPackagePageBatchPartial': `${params?.action || ''}: ${params?.succeeded || '0'} updated; ${params?.failed || '0'} failed.`,
        'settings.plugins.skillPackagePageReadOnly': 'Read-only',
        'settings.plugins.skillPackagePageNoAgent': 'Select an Agent.',
        'settings.plugins.skillPackagePageLoading': 'Loading package skills…',
        'settings.plugins.skillPackagePageNoSkills': 'No package skills for this Agent.',
        'settings.plugins.skillPackagePageLoadError': 'Failed to load package skills',
        'settings.plugins.skillPackagePageStaleReturn': 'Package no longer installed.',
        'settings.plugins.skillPackageLayerPackage': 'Package',
        'settings.plugins.skillPackageLayerAgentPreference': 'Agent preference',
        'settings.plugins.skillPackageLayerEffectiveAvailability': 'Effective availability',
        'settings.plugins.skillPackageLayerAvailable': 'available',
        'settings.plugins.skillPackageLayerUnavailable': 'unavailable',
        'settings.plugins.skillPackageLayerPartial': 'partially available',
        'settings.plugins.skillPackageEnable': 'Enable',
        'settings.plugins.skillPackageDisable': 'Disable',
        'settings.plugins.marketPackageGateEnabled': 'enabled',
        'settings.plugins.marketPackageGateDisabled': 'disabled',
        'settings.skills.toggleDisableNamed': `Disable ${params?.name || ''}`.trim(),
        'settings.skills.toggleEnableNamed': `Enable ${params?.name || ''}`.trim(),
        'settings.skills.marketplaceInactiveAgent': 'Disabled for this Agent; preference preserved.',
        'settings.plugins.empty': 'No plugins installed',
        'settings.plugins.manageTitle': 'Manage Plugins',
        'settings.plugins.reload': 'Reload',
        'settings.plugins.showDiagnostics': 'Show diagnostics',
        'settings.plugins.openMarketplace': 'Open plugin marketplace',
        'settings.plugins.configure': `Configure ${params?.name || ''}`.trim(),
        'settings.plugins.deleteConfirm': `Remove plugin "${params?.name || ''}"? Plugin data will be preserved.`,
        'settings.plugins.marketplaceTitle': 'Plugin Marketplace',
        'settings.plugins.marketplaceHint': 'Browse plugins',
        'settings.plugins.marketplaceChangedRetry': 'Marketplace settings changed again. Please try the toggle once more.',
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
    const openSkills = screen.getByRole('button', { name: 'Open skills for SkillWiki' });
    expect(openSkills).toBeInTheDocument();
    expect(openSkills).toHaveAttribute('title', 'Open skills for SkillWiki');
    expect(openSkills).toHaveTextContent('Manage in Skills');
    expect(openSkills.className).toMatch(/pv-add-form-btn/);
    expect(openSkills.className).toMatch(/plugin-labeled-action/);
    expect(openSkills.className).not.toMatch(/skill-card-delete/);

    const toggle = screen.getByRole('button', { name: 'Toggle package skillwiki@llm-wiki' });
    expect(toggle).toHaveTextContent('Disable');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('makes the marketplace teaser row navigate from its body and keeps a bare browse affordance', async () => {
    mockInventory();
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    const browse = await screen.findByRole('button', { name: 'Open plugin marketplace' });
    expect(browse).toHaveAttribute('type', 'button');
    expect(browse).toHaveAttribute('title', 'Open plugin marketplace');
    expect(browse.className).toMatch(/skills-list-item/);
    expect(browse.className).toMatch(/plugin-marketplace-entry/);
    expect(browse.className).not.toMatch(/settings-save-btn-sm/);
    expect(browse.querySelector('svg')).toBeInTheDocument();
    expect(browse.querySelector('span[aria-hidden="true"]')?.className).toMatch(/settings-icon-btn/);
    expect(browse.querySelector('span[aria-hidden="true"]')?.className).toMatch(/plugin-action-icon/);

    fireEvent.click(screen.getByText('Browse plugins'));
    expect(useSettingsStore.getState().activeTab).toBe('plugin-marketplace');
  });

  it('keeps native configure as a visible bare gear action', async () => {
    mockInventory({
      plugins: [{
        id: 'hyperframes',
        name: 'HyperFrames',
        status: 'loaded',
        source: 'community',
        trust: 'full-access',
        contributions: ['configuration'],
      }],
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    const configure = await screen.findByRole('button', { name: 'Configure HyperFrames' });
    expect(configure).toHaveAttribute('title', 'Configure HyperFrames');
    expect(configure.className).toMatch(/settings-icon-btn/);
    expect(configure.className).toMatch(/plugin-action-icon/);
    expect(configure.className).not.toMatch(/skill-card-delete/);
    fireEvent.click(configure);
    await waitFor(() => expect(hanaFetch).toHaveBeenCalledWith('/api/plugins/hyperframes/config'));
  });

  it('keeps native plugins visible when skill-package inventory is unavailable', async () => {
    hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/plugins?source=community') {
        return jsonResponse([{
          id: 'hyperframes',
          name: 'HyperFrames',
          status: 'loaded',
          source: 'community',
          trust: 'full-access',
          contributions: ['configuration'],
        }]);
      }
      if (path === '/api/plugins/marketplace/installed-skill-packages') {
        throw new Error('inventory unsupported');
      }
      return jsonResponse({});
    });

    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    expect(await screen.findByText('HyperFrames')).toBeInTheDocument();
    expect(screen.queryByText('No plugins installed')).not.toBeInTheDocument();
  });

  it('keeps native removal confirmation and lifecycle request on a bare danger icon', async () => {
    const deletes: string[] = [];
    mockInventory({
      plugins: [{
        id: 'hyperframes',
        name: 'HyperFrames',
        status: 'loaded',
        source: 'community',
        trust: 'full-access',
      }],
      onDelete: (path) => deletes.push(path),
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    const remove = await screen.findByRole('button', {
      name: 'Remove plugin "HyperFrames"? Plugin data will be preserved.',
    });
    expect(remove).toHaveAttribute('title', 'Remove plugin "HyperFrames"? Plugin data will be preserved.');
    expect(remove.className).toMatch(/settings-icon-btn/);
    expect(remove.className).toMatch(/plugin-action-icon/);
    expect(remove.className).toMatch(/plugin-action-danger/);
    expect(remove.className).not.toMatch(/skill-card-delete/);
    fireEvent.click(remove);

    await waitFor(() => expect(deletes).toEqual(['/api/plugins/hyperframes']));
    expect(mockConfirm).toHaveBeenCalledWith('Remove plugin "HyperFrames"? Plugin data will be preserved.');
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

  it('locks a package toggle while its activation write is in flight', async () => {
    let resolveWrite: ((response: Response) => void) | undefined;
    let putCount = 0;
    hanaFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/plugins?source=community') return jsonResponse([]);
      if (path === '/api/plugins/marketplace/installed-skill-packages') return jsonResponse(skillPackageInventory());
      if (path === '/api/plugins/marketplace/config/activations' && init?.method === 'PUT') {
        putCount += 1;
        return new Promise<Response>((resolve) => { resolveWrite = resolve; });
      }
      return jsonResponse({});
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    const toggle = await screen.findByRole('button', { name: /Toggle package skillwiki@llm-wiki/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(putCount).toBe(1));
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(putCount).toBe(1);

    resolveWrite?.(jsonResponse({ ok: true }));
    await waitFor(() => expect(toggle).not.toBeDisabled());
  });

  it('refreshes the inventory and retries a stale package-gate write once', async () => {
    const puts: unknown[] = [];
    let inventoryLoads = 0;
    const refreshedInventory = skillPackageInventory({
      registry: { revision: 9, digest: 'b'.repeat(64) },
      activations: {
        marketplaceSkillPackages: { 'other@src': { enabled: true } },
        marketplaceSkills: { 'wiki-query@llm-wiki/skillwiki': { enabled: false } },
        runtimePlugins: { 'newer@source': { enabled: true } },
      },
    });
    hanaFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/plugins?source=community') return jsonResponse([]);
      if (path === '/api/plugins/marketplace/installed-skill-packages') {
        inventoryLoads += 1;
        return jsonResponse(inventoryLoads === 1 ? skillPackageInventory() : refreshedInventory);
      }
      if (path === '/api/plugins/marketplace/config/activations' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return puts.length === 1
          ? jsonResponse({
              error: 'Marketplace registry revision conflict: expected 7, current 9',
              code: 'PLUGIN_MARKETPLACE_REGISTRY_STALE',
            }, 409)
          : jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    fireEvent.click(await screen.findByRole('button', { name: /Toggle package skillwiki@llm-wiki/ }));

    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({
      activations: {
        marketplaceSkillPackages: {
          'other@src': { enabled: true },
          'skillwiki@llm-wiki': { enabled: false },
        },
        marketplaceSkills: { 'wiki-query@llm-wiki/skillwiki': { enabled: false } },
        runtimePlugins: { 'newer@source': { enabled: true } },
      },
      expectedRevision: 9,
      expectedDigest: 'b'.repeat(64),
    });
    expect(useSettingsStore.getState().toastType).toBe('success');
  });

  it('stops after a second stale package-gate conflict and asks for one manual retry', async () => {
    let putCount = 0;
    let inventoryLoads = 0;
    hanaFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/plugins?source=community') return jsonResponse([]);
      if (path === '/api/plugins/marketplace/installed-skill-packages') {
        inventoryLoads += 1;
        return jsonResponse(skillPackageInventory({
          registry: { revision: 7 + inventoryLoads, digest: String(inventoryLoads).repeat(64) },
        }));
      }
      if (path === '/api/plugins/marketplace/config/activations' && init?.method === 'PUT') {
        putCount += 1;
        return jsonResponse({
          error: 'Marketplace registry revision conflict',
          code: 'PLUGIN_MARKETPLACE_REGISTRY_STALE',
        }, 409);
      }
      return jsonResponse({});
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    fireEvent.click(await screen.findByRole('button', { name: /Toggle package skillwiki@llm-wiki/ }));

    await waitFor(() => expect(putCount).toBe(2));
    expect(useSettingsStore.getState().toastType).toBe('error');
    expect(useSettingsStore.getState().toastMessage).toBe('Marketplace settings changed again. Please try the toggle once more.');
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

  it('opens a package-local settings page and returns to the loaded Manage Plugins list', async () => {
    mockInventory({
      skills: {
        hana: [marketplaceSkill('wiki-query'), marketplaceSkill('local-only', 'other@source')],
      },
    });
    useSettingsStore.setState({
      agents: [{ id: 'hana', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
      currentAgentId: 'hana',
      settingsAgentId: 'hana',
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open skills for SkillWiki' }));
    expect(await screen.findByText('Package availability')).toBeInTheDocument();
    expect(screen.getByText('wiki-query')).toBeInTheDocument();
    expect(screen.queryByText('local-only')).not.toBeInTheDocument();
    const layerText = Array.from(document.querySelectorAll('[class*="skills-list-desc"]'))
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim());
    expect(layerText).toContain('Package: enabled');
    expect(layerText.some((text) => text?.startsWith('Agent preference:'))).toBe(true);
    expect(layerText).toContain('Effective availability: available');

    const packageToggle = screen.getByRole('button', { name: 'Toggle package skillwiki@llm-wiki' });
    expect(packageToggle).toHaveTextContent('Disable');
    expect(packageToggle).toHaveAttribute('aria-pressed', 'true');
    const skillToggle = screen.getByRole('button', { name: 'Disable wiki-query' });
    expect(skillToggle).toHaveTextContent('Disable');
    expect(skillToggle).toHaveAttribute('aria-pressed', 'true');

    const openMarketplace = screen.getByRole('button', { name: 'Open marketplace' });
    expect(openMarketplace).toHaveAttribute('title', 'Open marketplace');
    expect(openMarketplace.className).toMatch(/settings-icon-btn/);
    expect(openMarketplace.className).toMatch(/plugin-action-icon/);
    expect(openMarketplace.className).not.toMatch(/settings-save-btn-sm/);
    fireEvent.click(openMarketplace);
    expect(useSettingsStore.getState().activeTab).toBe('plugin-marketplace');

    fireEvent.click(screen.getByRole('button', { name: 'Manage Plugins' }));
    expect(await screen.findByRole('button', { name: 'Open skills for SkillWiki' })).toBeInTheDocument();
  });

  it('reloads package membership and counts when the selected Agent changes', async () => {
    mockInventory({
      skills: {
        hana: [marketplaceSkill('wiki-query')],
        other: [marketplaceSkill('wiki-write', 'skillwiki@llm-wiki', false)],
      },
    });
    useSettingsStore.setState({
      agents: [
        { id: 'hana', name: 'Hanako', yuan: 'hanako', isPrimary: true },
        { id: 'other', name: 'Other', yuan: 'hanako', isPrimary: false },
      ],
      currentAgentId: 'hana',
      settingsAgentId: 'hana',
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open skills for SkillWiki' }));
    expect(await screen.findByText('wiki-query')).toBeInTheDocument();
    expect(screen.queryByText('wiki-write')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hanako' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Other' }));

    expect(await screen.findByText('wiki-write')).toBeInTheDocument();
    expect(screen.queryByText('wiki-query')).not.toBeInTheDocument();
  });

  it('uses the existing per-agent PATCH path for one package skill only', async () => {
    const patches: Array<{ path: string; body: unknown }> = [];
    mockInventory({
      skills: { hana: [marketplaceSkill('wiki-query')] },
      onPatch: (path, body) => patches.push({ path, body }),
    });
    useSettingsStore.setState({
      agents: [{ id: 'hana', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
      currentAgentId: 'hana',
      settingsAgentId: 'hana',
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open skills for SkillWiki' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disable wiki-query' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      path: '/api/agents/hana/skills/wiki-query',
      body: { enabled: false },
    });
    expect(hanaFetch.mock.calls.some(([path]) => String(path).includes('/api/agents/hana/skills/wiki-write'))).toBe(false);
  });

  it('batch-updates only writable members and reports partial failures', async () => {
    const patches: Array<{ path: string; body: unknown }> = [];
    mockInventory({
      skills: {
        hana: [
          marketplaceSkill('wiki-query', 'skillwiki@llm-wiki', false),
          marketplaceSkill('wiki-write', 'skillwiki@llm-wiki', false),
          marketplaceSkill('other-package', 'other@source', false),
          marketplaceSkill('readonly', 'skillwiki@llm-wiki', false, { configurable: false }),
        ],
      },
      onPatch: (path, body) => patches.push({ path, body }),
      patchFailures: new Set(['wiki-write']),
    });
    useSettingsStore.setState({
      agents: [{ id: 'hana', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
      currentAgentId: 'hana',
      settingsAgentId: 'hana',
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open skills for SkillWiki' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enable all' }));

    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches.map(({ path }) => path).sort()).toEqual([
      '/api/agents/hana/skills/wiki-query',
      '/api/agents/hana/skills/wiki-write',
    ]);
    expect(useSettingsStore.getState().toastType).toBe('error');
    expect(useSettingsStore.getState().toastMessage).toContain('1 updated; 1 failed');
  });

  it('locks per-agent controls for a source-blocked package without writing preferences', async () => {
    const patches: unknown[] = [];
    mockInventory({
      inventory: skillPackageInventory({
        packages: [{
          ...skillPackageRow,
          packageEnabled: false,
          packageGateState: 'blocked-by-source',
          sourceStatus: 'disabled',
        }],
      }),
      skills: { hana: [marketplaceSkill('wiki-query', 'skillwiki@llm-wiki', true)] },
      onPatch: (path, body) => patches.push({ path, body }),
    });
    useSettingsStore.setState({
      agents: [{ id: 'hana', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
      currentAgentId: 'hana',
      settingsAgentId: 'hana',
    });
    const { PluginsTab } = await import('../../settings/tabs/PluginsTab');
    render(<PluginsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open skills for SkillWiki' }));
    const skillToggle = await screen.findByRole('button', { name: 'Enable wiki-query' });
    expect(skillToggle).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Toggle package skillwiki@llm-wiki' })).toBeDisabled();
    expect(screen.getByText('Preferences are preserved while unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable all' })).toBeDisabled();
    fireEvent.click(skillToggle);
    expect(patches).toHaveLength(0);
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
