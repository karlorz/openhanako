/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceActions } from '../../../settings/hooks/useMarketplaceActions';
import type { MarketplacePayload, MarketplacePlugin } from '../../../settings/marketplace-types';

const mockHanaFetch = vi.fn();
const mockShowToast = vi.fn();
let mockStoreState: Record<string, any>;

vi.mock('../../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockHanaFetch(...args),
}));

vi.mock('../../../settings/store', () => ({
  useSettingsStore: (selector?: (state: any) => unknown) => {
    return selector ? selector(mockStoreState) : mockStoreState;
  },
}));

function fixturePayload(): MarketplacePayload {
  return {
    source: {},
    plugins: [],
    sources: [],
    warnings: [],
    capabilities: null,
    access: null,
    registry: null,
    configDiagnostics: null,
    compatibilityBindings: [],
  };
}

function fixturePlugin(): MarketplacePlugin {
  return {
    id: 'demo',
    name: 'demo',
    publisher: 'Hana',
    trust: 'restricted',
    marketplaceId: 'official',
    compositeKey: 'demo@official',
    sourceAuthority: 'official',
    installTarget: 'native-plugin',
    installAdapter: 'plugin-manager',
    installable: true,
    canInstall: true,
    active: false,
    installAction: 'install',
    compatible: true,
    confirmationLevel: 'typed-exact',
    warnings: [],
    packageInstall: { state: 'not-installed', recorded: [], present: [], missing: [], invalid: [] },
    marketplaceSkillActivations: [],
    nativeSettingsLifecycle: { supported: true, canInstall: true, canUninstall: false, reason: 'ok' },
  };
}

describe('useMarketplaceActions', () => {
  beforeEach(() => {
    mockHanaFetch.mockReset();
    mockShowToast.mockReset();
    mockStoreState = {
      set: vi.fn(),
      showToast: mockShowToast,
      agents: [],
      settingsAgentId: null,
      currentAgentId: null,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the native install plan/execute flow through useMarketplaceActions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ planToken: 'p', confirmationText: 'confirm', facts: {} }) })
      .mockResolvedValueOnce({ json: async () => ({ ok: true, name: 'demo' }) });
    mockHanaFetch.mockImplementation(fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { result } = renderHook(() => useMarketplaceActions({
      marketplace: fixturePayload(),
      reload: vi.fn(),
      selectedAgentId: null,
      updateMarketplacePlugin: vi.fn(),
    }));

    await act(async () => {
      await result.current.installPlugin(fixturePlugin());
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/plugins/marketplace/demo/native/install/plan', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/plugins/marketplace/demo/native/install/execute', expect.objectContaining({ method: 'POST' }));
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('settings.plugins.installSuccess'), 'success');
  });

  it('applies the optimistic package-gate patch before the PUT and rolls it back after a final stale write', async () => {
    const updatePlugin = vi.fn();
    let optimisticApplied = false;
    updatePlugin.mockImplementation(() => { optimisticApplied = true; });
    const putBodies: unknown[] = [];
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/config/activations' && init?.method === 'PUT') {
        // Optimistic patch must already be applied before the request resolves.
        expect(optimisticApplied).toBe(true);
        putBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ error: 'registry stale', code: 'PLUGIN_MARKETPLACE_REGISTRY_STALE' }, 409);
      }
      if (url === '/api/plugins/marketplace/config') {
        return jsonResponse({
          registry: { revision: 11, digest: 'c'.repeat(64) },
          configDiagnostics: { file: { activations: {} } },
        });
      }
      return jsonResponse({});
    });

    const { result } = renderHook(() => useMarketplaceActions({
      marketplace: gatePayload(),
      reload: vi.fn(),
      selectedAgentId: null,
      updateMarketplacePlugin: updatePlugin,
    }));

    await act(async () => {
      await result.current.toggleSkillPackageGate(installedSkillsPlugin(), true);
    });

    // Optimistic patch applied before the first PUT, rollback after the final stale write.
    expect(updatePlugin).toHaveBeenCalledTimes(2);
    expect(updatePlugin.mock.calls[0][0]).toBe('skillwiki@llm-wiki');
    const firstPatch = updatePlugin.mock.calls[0][1] as (p: MarketplacePlugin) => MarketplacePlugin;
    expect(firstPatch(installedSkillsPlugin()).packageActivation).toMatchObject({
      identity: 'skillwiki@llm-wiki',
      kind: 'marketplace-skill-package',
      enabled: true,
      state: 'enabled',
      recorded: true,
      requested: true,
      reason: null,
    });
    const rollbackPatch = updatePlugin.mock.calls[1][1] as (p: MarketplacePlugin) => MarketplacePlugin;
    expect(rollbackPatch(installedSkillsPlugin()).packageActivation).toMatchObject({
      enabled: false,
      state: 'disabled',
      recorded: true,
      requested: false,
    });
    expect(mockShowToast).toHaveBeenCalledWith('settings.plugins.marketplaceChangedRetry', 'error');
    // One stale retry keeps the exact PUT payload/preconditions on both writes.
    expect(putBodies).toHaveLength(2);
    expect(putBodies[0]).toEqual({
      expectedRevision: 7,
      expectedDigest: 'a'.repeat(64),
      activations: { marketplaceSkillPackages: { 'skillwiki@llm-wiki': { enabled: true } } },
    });
    expect(putBodies[1]).toMatchObject({ expectedRevision: 11, expectedDigest: 'c'.repeat(64) });
  });

  it('restores the optimistic package-gate patch after a failed write', async () => {
    const updatePlugin = vi.fn();
    mockHanaFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/plugins/marketplace/config/activations' && init?.method === 'PUT') {
        throw new Error('boom');
      }
      return jsonResponse({});
    });

    const { result } = renderHook(() => useMarketplaceActions({
      marketplace: gatePayload(),
      reload: vi.fn(),
      selectedAgentId: null,
      updateMarketplacePlugin: updatePlugin,
    }));

    await act(async () => {
      await result.current.toggleSkillPackageGate(installedSkillsPlugin(), true);
    });

    expect(updatePlugin).toHaveBeenCalledTimes(2);
    const rollbackPatch = updatePlugin.mock.calls[1][1] as (p: MarketplacePlugin) => MarketplacePlugin;
    expect(rollbackPatch(installedSkillsPlugin()).packageActivation).toMatchObject({
      enabled: false,
      state: 'disabled',
      requested: false,
    });
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('settings.saveFailed'), 'error');
  });
});

function jsonResponse(body: unknown, status?: number): Response {
  return { status, ok: status == null ? true : status >= 200 && status < 300, json: async () => body } as Response;
}

function gatePayload(): MarketplacePayload {
  return {
    source: {},
    plugins: [],
    sources: [],
    warnings: [],
    capabilities: null,
    access: { isStudioOwner: true, isLocalOwner: true },
    registry: { revision: 7, digest: 'a'.repeat(64) },
    configDiagnostics: { ok: true, degraded: false, file: { revision: 7, activations: {} }, diagnostics: [], summary: { revision: 7 } },
    compatibilityBindings: [],
  };
}

function installedSkillsPlugin(): MarketplacePlugin {
  return {
    id: 'skillwiki',
    name: 'skillwiki',
    publisher: 'llm-wiki',
    marketplaceId: 'llm-wiki',
    compositeKey: 'skillwiki@llm-wiki',
    sourceAuthority: 'custom',
    installTarget: 'hana-skills',
    installAdapter: 'skill-manager',
    installable: true,
    canInstall: false,
    active: false,
    installAction: 'reinstall',
    packageInstall: { state: 'installed', recorded: ['wiki-query'], present: ['wiki-query'], missing: [] },
    packageActivation: null,
    warnings: [],
    marketplaceSkillActivations: [],
    capabilityInventory: null,
    nativeSettingsLifecycle: null,
  };
}
