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
    }));

    await act(async () => {
      await result.current.installPlugin(fixturePlugin());
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/plugins/marketplace/demo/native/install/plan', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/plugins/marketplace/demo/native/install/execute', expect.objectContaining({ method: 'POST' }));
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('settings.plugins.installSuccess'), 'success');
  });
});
