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
let mockStoreState: Record<string, any>;

vi.mock('../../settings/store', () => ({
  useSettingsStore: (selector?: (state: any) => unknown) => {
    return selector ? selector(mockStoreState) : mockStoreState;
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

function jsonResponse(body: unknown, status?: number): Response {
  return { status, ok: status == null ? true : status >= 200 && status < 300, json: async () => body } as Response;
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
    if (url.startsWith('/api/plugins/marketplace/catalog')) {
      return jsonResponse({
        plugins,
        sources: [],
        warnings: [],
        capabilities: { supported: true, features: { claudeCompatibilityBindings: true } },
        access: { isStudioOwner: true, isLocalOwner: true },
        registry: { revision: 7, digest: 'a'.repeat(64), degraded: false },
        configDiagnostics: { ok: true, degraded: false, path: '/srv/hana/plugin-marketplaces.json', digest: 'a'.repeat(64), file: { revision: 7, activations: {} }, diagnostics: [], summary: { revision: 7 } },
      });
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
    mockStoreState = {
      set: mockSet,
      showToast: mockShowToast,
      agents: [],
      currentAgentId: null,
      settingsAgentId: null,
    };
    window.t = ((key: string, params?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'settings.plugins.marketBack': 'Back',
        'settings.plugins.marketplaceHint': 'Install marketplace packages',
        'settings.plugins.marketplaceCount': `${params?.count || '0'} package`,
        'settings.plugins.reload': 'Reload marketplace',
        'settings.plugins.marketLoading': 'Loading...',
        'settings.plugins.marketInstall': 'Install',
        'settings.plugins.marketInstallSkills': 'Install skills',
        'settings.plugins.marketIncompatible': 'Incompatible',
        'settings.plugins.marketSelectPlugin': 'Select a package',
        'settings.plugins.marketplaceEmpty': 'No plugins to browse',
        'settings.plugins.skillPackageToggle': `Toggle skill package ${params?.identity || ''}`.trim(),
        'settings.autoSaved': 'Saved',
        'settings.saveFailed': 'Save failed',
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

  it('labels the Marketplace toolbar refresh icon as a reload action', async () => {
    mockCatalog([catalogPlugin()]);

    render(<PluginMarketplaceTab />);

    const reload = await screen.findByRole('button', { name: 'Reload marketplace' });
    expect(reload).toHaveAttribute('title', 'Reload marketplace');
    expect(reload.className).toMatch(/settings-icon-btn/);
    expect(reload.querySelector('svg')).toBeInTheDocument();
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

  it('shows unsupported-server guidance instead of falling back to an empty marketplace', async () => {
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/plugins/marketplace/capabilities') {
        return jsonResponse({
          supported: false,
          code: 'PLUGIN_MARKETPLACE_UNSUPPORTED_SERVER',
          upgradeGuidance: 'Upgrade the connected Hana server to use marketplace sources.',
        }, 404);
      }
      return jsonResponse({ plugins: [catalogPlugin()], sources: [], warnings: [] });
    });

    render(<PluginMarketplaceTab />);

    expect(await screen.findByText('Upgrade the connected Hana server to use marketplace sources.')).toBeInTheDocument();
    expect(mockHanaFetch).not.toHaveBeenCalledWith('/api/plugins/marketplace/catalog', expect.anything());
  });

  it('shows native marketplace packages as preview-only until PluginManager audit completes', async () => {
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
        installable: false,
        canInstall: false,
        confirmationLevel: 'typed-exact',
        capabilityInventory: {
          skills: [],
          nativePluginContributions: ['tools', 'routes'],
          agentFacing: ['tools'],
          serverImpact: ['routes'],
          unsupportedClaudeComponents: [],
        },
        warnings: [
          'native marketplace install is preview-only until the PluginManager contract audit is complete',
          'native plugin requests full-access review',
        ],
        installPlan: {
          action: 'install',
          destination: 'native-plugin',
          installAdapter: 'plugin-manager',
          confirmationLevel: 'typed-exact',
          warnings: [
            'native marketplace install is preview-only until the PluginManager contract audit is complete',
            'native plugin requests full-access review',
          ],
          installable: false,
        },
      }),
    ]);

    render(<PluginMarketplaceTab />);

    const installButton = await screen.findByRole('button', { name: 'Inspect only' });
    expect(installButton).toBeDisabled();
    expect(screen.getByText('native marketplace install is preview-only until the PluginManager contract audit is complete')).toBeInTheDocument();
    fireEvent.click(installButton);

    expect(promptSpy).not.toHaveBeenCalled();
    expect(mockHanaFetch).not.toHaveBeenCalledWith('/api/plugins/marketplace/native-page/install', expect.anything());
  });

  it('distinguishes a supported empty catalog from an unsupported or missing source state', async () => {
    mockCatalog([]);

    render(<PluginMarketplaceTab />);

    expect(await screen.findByText('0 package')).toBeInTheDocument();
    expect(screen.getByText('No plugins to browse')).toBeInTheDocument();
    expect(screen.getByText('Supported server')).toBeInTheDocument();
    expect(screen.queryByText('settings.plugins.marketplaceNoSource')).not.toBeInTheDocument();
  });

  it('shows degraded last-known-good JSON diagnostics and repair guidance', async () => {
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/plugins/marketplace/capabilities') {
        return jsonResponse({
          supported: true,
          features: { claudeCompatibilityBindings: false },
          access: { isStudioOwner: true, isLocalOwner: false },
          registry: { revision: 4, digest: 'b'.repeat(64), degraded: true, lastKnownGood: true, path: '[server-local path redacted]', diagnostic: 'Malformed JSON' },
          configDiagnostics: {
            ok: false,
            degraded: true,
            path: '[server-local path redacted]',
            digest: 'b'.repeat(64),
            file: { revision: 4, activations: {} },
            diagnostics: [{ severity: 'error', code: 'INVALID_JSON', path: '$', message: 'Repair malformed JSON and reload.' }],
            summary: { revision: 4, schemaVersion: 2 },
          },
        });
      }
      if (url.startsWith('/api/plugins/marketplace/catalog')) {
        return jsonResponse({ plugins: [], sources: [], warnings: [], capabilities: { supported: true }, access: { isStudioOwner: true }, registry: { revision: 4, digest: 'b'.repeat(64), degraded: true, diagnostic: 'Malformed JSON' }, configDiagnostics: { degraded: true, path: '[server-local path redacted]', digest: 'b'.repeat(64), file: { revision: 4, activations: {} }, diagnostics: [{ code: 'INVALID_JSON', path: '$', message: 'Repair malformed JSON and reload.' }], summary: { revision: 4 } } });
      }
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      return jsonResponse({ plugins: [] });
    });

    render(<PluginMarketplaceTab />);

    expect(await screen.findByText('degraded / last-known-good')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Claude compatibility & advanced JSON configuration'));
    expect(screen.getByText('Invalid edit · last-known-good active')).toBeInTheDocument();
    expect(screen.getByText('[server-local path redacted]')).toBeInTheDocument();
    expect(screen.getByText('$: Repair malformed JSON and reload.')).toBeInTheDocument();
  });

  it('routes Hana-compatible marketplace packages to existing Skills Settings', async () => {
    mockCatalog([catalogPlugin()]);
    render(<PluginMarketplaceTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage in Skills' }));

    expect(mockSet).toHaveBeenCalledWith({ activeTab: 'skills' });
    expect(screen.getByText('Skills Settings / Agent Skill Toggles (not Native Plugins)')).toBeInTheDocument();
  });

  it('shows selected-Agent native access separately and writes the exact qualified identity', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockStoreState.agents = [{ id: 'agent-a', name: 'Agent A' }];
    mockStoreState.currentAgentId = 'agent-a';
    const native = catalogPlugin({
      pluginId: 'native-page',
      id: 'native-page',
      name: 'Native Page',
      marketplaceId: 'official',
      compositeKey: 'native-page@official',
      installTarget: 'native-plugin',
      installAdapter: 'plugin-manager',
      installable: false,
      canInstall: false,
      capabilityInventory: {
        skills: [],
        nativePluginContributions: ['tools', 'routes'],
        agentFacing: ['tools'],
        serverImpact: ['routes'],
        unsupportedClaudeComponents: [],
      },
      runtimeActivation: { state: 'desired-not-installed', reason: 'native runtime plugin artifact is not installed' },
      nativeAgentPluginAccess: {
        identity: 'native-page@official',
        agentId: 'agent-a',
        enabled: false,
        state: 'disabled',
        reason: 'native Agent Plugin Access is disabled and artifact is not installed',
        serverGlobalContributions: ['routes'],
      },
    });
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/capabilities') return jsonResponse({ supported: true, features: {}, access: { isStudioOwner: true }, registry: { revision: 7, digest: 'a'.repeat(64) }, configDiagnostics: { file: { revision: 7, activations: {} }, summary: { revision: 7 } } });
      if (url === '/api/plugins/marketplace/catalog?agentId=agent-a') return jsonResponse({ plugins: [native], sources: [], capabilities: { supported: true, features: {} }, access: { isStudioOwner: true }, registry: { revision: 7, digest: 'a'.repeat(64) }, configDiagnostics: { file: { revision: 7, activations: {} }, summary: { revision: 7 } } });
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url === '/api/plugins/marketplace/config/activations') {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body).toMatchObject({
          expectedRevision: 7,
          expectedDigest: 'a'.repeat(64),
          activations: { agentPluginAccess: { 'agent-a': { 'native-page@official': { enabled: true, contributions: ['tools'] } } } },
        });
        return jsonResponse({ revision: 8 });
      }
      if (url.includes('/readme')) return jsonResponse({ markdown: '' });
      return jsonResponse({});
    });

    render(<PluginMarketplaceTab />);

    expect(await screen.findByText('Selected-Agent Plugin Access')).toBeInTheDocument();
    expect(screen.getByText(/Routes, providers, extensions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable Agent Access' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('native-page@official'));
    expect(await screen.findByText('desired-not-installed · native runtime plugin artifact is not installed')).toBeInTheDocument();
  });

  it('renders live, mirror, and snapshot compatibility state with redacted paths and bridge limits', async () => {
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/plugins/marketplace/capabilities') return jsonResponse({ supported: true, features: { claudeCompatibilityBindings: true }, access: { isStudioOwner: false, isLocalOwner: false }, registry: { revision: 2, digest: 'c'.repeat(64), path: '[server-local path redacted]' }, configDiagnostics: { path: '[server-local path redacted]', file: { revision: 2 }, summary: { revision: 2 } } });
      if (url.startsWith('/api/plugins/marketplace/catalog')) return jsonResponse({ plugins: [], sources: [], capabilities: { supported: true, features: { claudeCompatibilityBindings: true } }, access: { isStudioOwner: false }, registry: { revision: 2, digest: 'c'.repeat(64), path: '[server-local path redacted]' }, configDiagnostics: { path: '[server-local path redacted]', file: { revision: 2 }, summary: { revision: 2 } } });
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url === '/api/plugins/marketplace/compatibility/bindings') return jsonResponse({ bindings: ['live', 'mirror', 'snapshot'].map((mode, index) => ({ binding: { id: `${mode}-binding`, mode, enabled: true, inputs: [{ role: 'user-settings', path: '[server-local path redacted]' }] }, state: { digest: String(index + 1).repeat(64), warnings: mode === 'live' ? [{ code: 'CLAUDE_HOOK_EXCLUDED', message: 'Claude hooks are excluded.' }] : [] }, lastKnownGood: mode === 'mirror', diagnostic: mode === 'mirror' ? { code: 'CLAUDE_COMPAT_INPUT_INVALID', message: 'Repair the authorized input.', graceExpired: true } : null, pendingBoundary: 'next-agent-snapshot' })) });
      return jsonResponse({});
    });

    render(<PluginMarketplaceTab />);
    fireEvent.click(await screen.findByText('Claude compatibility & advanced JSON configuration'));

    expect(screen.getByText('live-binding')).toBeInTheDocument();
    expect(screen.getByText('mirror-binding')).toBeInTheDocument();
    expect(screen.getByText('snapshot-binding')).toBeInTheDocument();
    expect(screen.getAllByText('[server-local path redacted]').length).toBeGreaterThan(0);
    expect(screen.getByText('Claude hooks are excluded.')).toBeInTheDocument();
    expect(screen.getByText('Desktop bridge transport: unavailable in this build.')).toBeInTheDocument();
  });

  it('keeps duplicate package identities keyboard-operable and source-qualified', async () => {
    mockCatalog([
      catalogPlugin({ marketplaceId: 'market-a', compositeKey: 'skillwiki@market-a' }),
      catalogPlugin({ marketplaceId: 'market-b', compositeKey: 'skillwiki@market-b', description: 'Second source' }),
    ]);
    render(<PluginMarketplaceTab />);

    const second = await screen.findByRole('button', { name: 'Inspect skillwiki@market-b' });
    second.focus();
    expect(second).toHaveFocus();
    fireEvent.click(second);

    expect(screen.getAllByText('skillwiki@market-a').length).toBeGreaterThan(0);
    expect(screen.getAllByText('skillwiki@market-b').length).toBeGreaterThan(0);
    expect(second).toHaveAttribute('aria-pressed', 'true');
  });

  it('uninstalls an installed skills package with exact destructive confirmation and qualified identity', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const installed = catalogPlugin({
      canInstall: false,
      packageInstall: {
        state: 'installed',
        recorded: ['wiki-query', 'wiki-sync'],
        present: ['wiki-query', 'wiki-sync'],
        missing: [],
        invalid: [],
      },
    });
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/plugins/marketplace/catalog')) {
        return jsonResponse({
          plugins: [installed],
          sources: [],
          capabilities: { supported: true, features: {} },
          access: { isStudioOwner: true },
          registry: { revision: 7, digest: 'a'.repeat(64) },
        });
      }
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url.includes('/readme')) return jsonResponse({ markdown: '' });
      if (url === '/api/plugins/marketplace/skillwiki/skills') {
        expect(init?.method).toBe('DELETE');
        expect(JSON.parse(String(init?.body))).toEqual({
          marketplaceId: 'llm-wiki',
          expectedRevision: 7,
          expectedDigest: 'a'.repeat(64),
        });
        return jsonResponse({ ok: true, deleted: ['wiki-query', 'wiki-sync'], alreadyMissing: [], failed: [] });
      }
      return jsonResponse({});
    });
    render(<PluginMarketplaceTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall skills' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('skillwiki@llm-wiki'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('shared user skills/wiki-query/'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('shared user skills/wiki-sync/'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Allow Agent plugin dev tools'));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      'Removed 2 recorded skills from skillwiki@llm-wiki',
      'success',
    ));
  });

  it('renders partial and stale package actions independently of native-plugin active state', async () => {
    mockCatalog([
      catalogPlugin({
        active: false,
        canInstall: false,
        packageInstall: {
          state: 'partial',
          recorded: ['wiki-query', 'wiki-sync'],
          present: ['wiki-query'],
          missing: ['wiki-sync'],
          invalid: [],
        },
      }),
      catalogPlugin({
        pluginId: 'stale-pack',
        id: 'stale-pack',
        name: 'stale-pack',
        compositeKey: 'stale-pack@llm-wiki',
        sourceAuthority: 'removed',
        sourceStatus: 'removed',
        sourceEnabled: false,
        available: false,
        installable: false,
        canInstall: false,
        active: false,
        packageInstall: {
          state: 'stale-record',
          recorded: ['old-skill'],
          present: [],
          missing: ['old-skill'],
          invalid: [],
        },
      }),
    ]);
    render(<PluginMarketplaceTab />);

    expect(await screen.findByRole('button', { name: 'Uninstall remaining skills' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect stale-pack@llm-wiki' }));
    expect(screen.getByRole('button', { name: 'Clear stale installation' })).toBeEnabled();
    expect(screen.getByText('stale-record · source removed / uninstall only')).toBeInTheDocument();
  });

  it('reports a partial package uninstall without a success toast', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const partial = catalogPlugin({
      canInstall: false,
      packageInstall: {
        state: 'partial',
        recorded: ['wiki-query', 'wiki-sync'],
        present: ['wiki-query'],
        missing: ['wiki-sync'],
        invalid: [],
      },
    });
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/plugins/marketplace/catalog')) return jsonResponse({ plugins: [partial], sources: [], capabilities: { supported: true }, access: { isStudioOwner: true }, registry: { revision: 7, digest: 'a'.repeat(64) } });
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url.includes('/readme')) return jsonResponse({ markdown: '' });
      if (url === '/api/plugins/marketplace/skillwiki/skills') return jsonResponse({ ok: false, deleted: [], alreadyMissing: ['wiki-sync'], failed: [{ name: 'wiki-query', error: 'busy' }] }, 207);
      return jsonResponse({});
    });
    render(<PluginMarketplaceTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall remaining skills' }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      'Marketplace skills uninstall is partial: wiki-query: busy',
      'error',
    ));
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('surfaces owner or install-permission denial without reporting success', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/plugins/marketplace/capabilities') return jsonResponse({ supported: true, features: {}, access: { isStudioOwner: false }, registry: { revision: 1, digest: 'd'.repeat(64) } });
      if (url.startsWith('/api/plugins/marketplace/catalog')) return jsonResponse({ plugins: [catalogPlugin()], sources: [], capabilities: { supported: true, features: {} }, access: { isStudioOwner: false }, registry: { revision: 1, digest: 'd'.repeat(64) } });
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url.includes('/readme')) return jsonResponse({ markdown: '' });
      if (url === '/api/plugins/marketplace/skillwiki/install') return jsonResponse({ error: 'studio.owner or install permission required', code: 'PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN' }, 403);
      return jsonResponse({});
    });
    render(<PluginMarketplaceTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Install skills' }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('studio.owner or install permission required'), 'error'));
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('hides package enable toggle when skills package is not-installed', async () => {
    mockCatalog([catalogPlugin({
      packageInstall: { state: 'not-installed', recorded: [], present: [], missing: [], invalid: [] },
      packageActivation: {
        identity: 'skillwiki@llm-wiki',
        kind: 'marketplace-skill-package',
        enabled: false,
        state: 'disabled',
        recorded: false,
      },
    })]);
    render(<PluginMarketplaceTab />);

    expect(await screen.findByRole('button', { name: 'Install skills' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Toggle skill package skillwiki@llm-wiki/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Package gate/)).not.toBeInTheDocument();
  });

  it('shows package enable toggle for installed skills packages and PUTs marketplaceSkillPackages clone', async () => {
    const existingActivations = {
      marketplaceSkillPackages: { 'other@src': { enabled: true } },
      marketplaceSkills: { 'wiki-query@llm-wiki/skillwiki': { enabled: true } },
      runtimePlugins: { 'demo@official': { enabled: true } },
      agentSkillOverrides: { 'agent-a': { 'wiki-query@llm-wiki/skillwiki': { enabled: false } } },
      agentPluginAccess: { 'agent-a': { 'demo@official': { enabled: false } } },
    };
    const installed = catalogPlugin({
      canInstall: false,
      packageInstall: {
        state: 'installed',
        recorded: ['wiki-query', 'wiki-sync'],
        present: ['wiki-query', 'wiki-sync'],
        missing: [],
        invalid: [],
      },
      packageActivation: {
        identity: 'skillwiki@llm-wiki',
        kind: 'marketplace-skill-package',
        enabled: true,
        state: 'enabled',
        recorded: false,
        requested: false,
      },
    });
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/capabilities') {
        return jsonResponse({
          supported: true,
          features: {},
          access: { isStudioOwner: true },
          registry: { revision: 7, digest: 'a'.repeat(64) },
          configDiagnostics: {
            file: {
              revision: 7,
              activations: existingActivations,
            },
            summary: { revision: 7 },
          },
        });
      }
      if (url.startsWith('/api/plugins/marketplace/catalog')) {
        return jsonResponse({
          plugins: [installed],
          sources: [],
          capabilities: { supported: true, features: {} },
          access: { isStudioOwner: true },
          registry: { revision: 7, digest: 'a'.repeat(64) },
          configDiagnostics: {
            file: {
              revision: 7,
              activations: existingActivations,
            },
            summary: { revision: 7 },
          },
        });
      }
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url.includes('/readme')) return jsonResponse({ markdown: '' });
      if (url === '/api/plugins/marketplace/config/activations') {
        expect(init?.method).toBe('PUT');
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body).toEqual({
          expectedRevision: 7,
          expectedDigest: 'a'.repeat(64),
          activations: {
            marketplaceSkillPackages: {
              'other@src': { enabled: true },
              'skillwiki@llm-wiki': { enabled: false },
            },
            marketplaceSkills: existingActivations.marketplaceSkills,
            runtimePlugins: existingActivations.runtimePlugins,
            agentSkillOverrides: existingActivations.agentSkillOverrides,
            agentPluginAccess: existingActivations.agentPluginAccess,
          },
        });
        return jsonResponse({ revision: 8 });
      }
      return jsonResponse({});
    });
    render(<PluginMarketplaceTab />);

    expect(await screen.findByRole('button', { name: 'Uninstall skills' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage in Skills' })).toBeInTheDocument();
    expect(screen.getByText(/Package gate/)).toBeInTheDocument();
    expect(screen.getByText(/global skill-manager gate/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Toggle skill package skillwiki@llm-wiki/ }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.anything(), 'success'));
  });

  it('refreshes the marketplace config and retries a stale package-gate write once', async () => {
    const installed = catalogPlugin({
      canInstall: false,
      packageInstall: { state: 'installed', recorded: ['wiki-query'], present: ['wiki-query'], missing: [] },
      packageActivation: { identity: 'skillwiki@llm-wiki', enabled: true, state: 'enabled' },
    });
    const initialActivations = {
      marketplaceSkillPackages: { 'other@src': { enabled: true } },
      marketplaceSkills: { 'wiki-query@llm-wiki/skillwiki': { enabled: true } },
    };
    const freshActivations = {
      marketplaceSkillPackages: { 'other@src': { enabled: false } },
      marketplaceSkills: { 'wiki-query@llm-wiki/skillwiki': { enabled: false } },
      runtimePlugins: { 'newer@source': { enabled: true } },
    };
    const puts: unknown[] = [];
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/capabilities') {
        return jsonResponse({
          supported: true,
          features: {},
          access: { isStudioOwner: true },
          registry: { revision: 7, digest: 'a'.repeat(64) },
          configDiagnostics: { file: { revision: 7, activations: initialActivations } },
        });
      }
      if (url.startsWith('/api/plugins/marketplace/catalog')) {
        return jsonResponse({
          plugins: [installed], sources: [], capabilities: { supported: true, features: {} },
          access: { isStudioOwner: true }, registry: { revision: 7, digest: 'a'.repeat(64) },
          configDiagnostics: { file: { revision: 7, activations: initialActivations } },
        });
      }
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url.includes('/readme')) return jsonResponse({ markdown: '' });
      if (url === '/api/plugins/marketplace/config') {
        return jsonResponse({
          registry: { revision: 11, digest: 'c'.repeat(64) },
          configDiagnostics: { file: { revision: 11, activations: freshActivations } },
        });
      }
      if (url === '/api/plugins/marketplace/config/activations' && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        if (puts.length === 1) {
          throw new Error('Marketplace registry digest conflict: expected stale, current fresh');
        }
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    render(<PluginMarketplaceTab />);

    fireEvent.click(await screen.findByRole('button', { name: /Toggle skill package skillwiki@llm-wiki/ }));

    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({
      activations: {
        marketplaceSkillPackages: {
          'other@src': { enabled: false },
          'skillwiki@llm-wiki': { enabled: false },
        },
        marketplaceSkills: { 'wiki-query@llm-wiki/skillwiki': { enabled: false } },
        runtimePlugins: { 'newer@source': { enabled: true } },
      },
      expectedRevision: 11,
      expectedDigest: 'c'.repeat(64),
    });
    expect(mockShowToast).toHaveBeenCalledWith('Saved', 'success');
  });

  it('refuses package gate toggle when activations snapshot is missing', async () => {
    const installed = catalogPlugin({
      canInstall: false,
      packageInstall: {
        state: 'installed',
        recorded: ['wiki-query'],
        present: ['wiki-query'],
        missing: [],
      },
      packageActivation: {
        identity: 'skillwiki@llm-wiki',
        enabled: true,
        state: 'enabled',
      },
    });
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/plugins/marketplace/capabilities') {
        return jsonResponse({
          supported: true,
          features: {},
          access: { isStudioOwner: true },
          registry: { revision: 7, digest: 'a'.repeat(64) },
          configDiagnostics: { file: { revision: 7 }, summary: { revision: 7 } },
        });
      }
      if (url.startsWith('/api/plugins/marketplace/catalog')) {
        return jsonResponse({
          plugins: [installed],
          sources: [],
          capabilities: { supported: true },
          access: { isStudioOwner: true },
          registry: { revision: 7, digest: 'a'.repeat(64) },
          configDiagnostics: { file: { revision: 7 }, summary: { revision: 7 } },
        });
      }
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url.includes('/readme')) return jsonResponse({ markdown: '' });
      return jsonResponse({});
    });
    render(<PluginMarketplaceTab />);

    fireEvent.click(await screen.findByRole('button', { name: /Toggle skill package skillwiki@llm-wiki/ }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('missing activations snapshot'),
      'error',
    ));
    expect(
      mockHanaFetch.mock.calls.some(
        ([path, init]) =>
          path === '/api/plugins/marketplace/config/activations'
          && (init as RequestInit | undefined)?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it('hides package enable toggle for non-owners while keeping Manage in Skills', async () => {
    const installed = catalogPlugin({
      canInstall: false,
      packageInstall: {
        state: 'installed',
        recorded: ['wiki-query'],
        present: ['wiki-query'],
        missing: [],
      },
      packageActivation: { identity: 'skillwiki@llm-wiki', enabled: true, state: 'enabled' },
    });
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url === '/api/plugins/marketplace/capabilities') {
        return jsonResponse({
          supported: true,
          features: {},
          access: { isStudioOwner: false },
          registry: { revision: 7, digest: 'a'.repeat(64) },
        });
      }
      if (url.startsWith('/api/plugins/marketplace/catalog')) {
        return jsonResponse({
          plugins: [installed],
          sources: [],
          capabilities: { supported: true },
          access: { isStudioOwner: false },
          registry: { revision: 7, digest: 'a'.repeat(64) },
        });
      }
      if (url === '/api/plugins/marketplace/sources') return jsonResponse({ sources: [] });
      if (url.includes('/readme')) return jsonResponse({ markdown: '' });
      return jsonResponse({});
    });
    render(<PluginMarketplaceTab />);

    expect(await screen.findByRole('button', { name: 'Manage in Skills' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Toggle skill package skillwiki@llm-wiki/ })).not.toBeInTheDocument();
    // Package gate status still visible for inspection
    expect(screen.getByText(/Package gate/)).toBeInTheDocument();
  });
});
