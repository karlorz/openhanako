/**
 * @vitest-environment jsdom
 *
 * Busy-state contract for MarketplacePluginInspector: while any marketplace
 * action owns the single busy slot, no visible mutation control may remain
 * enabled (a click would silently no-op on the hook's defensive guard).
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplacePluginInspector } from '../../../settings/components/marketplace/MarketplacePluginInspector';
import type { MarketplaceActions } from '../../../settings/hooks/useMarketplaceActions';
import type { MarketplacePayload, MarketplacePlugin } from '../../../settings/marketplace-types';

const mockSet = vi.fn();
let mockStoreState: Record<string, any>;

vi.mock('../../../settings/store', () => ({
  useSettingsStore: (selector?: (state: any) => unknown) => {
    return selector ? selector(mockStoreState) : mockStoreState;
  },
}));

function ownerPayload(): MarketplacePayload {
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

function skillsPlugin(): MarketplacePlugin {
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
    packageActivation: { identity: 'skillwiki@llm-wiki', kind: 'marketplace-skill-package', enabled: true, state: 'enabled' },
    warnings: [],
    marketplaceSkillActivations: [],
    capabilityInventory: null,
    nativeSettingsLifecycle: null,
  };
}

function nativeActivePlugin(): MarketplacePlugin {
  return {
    id: 'native-page',
    name: 'Native Page',
    publisher: 'Hana',
    marketplaceId: 'official',
    compositeKey: 'native-page@official',
    installTarget: 'native-plugin',
    installAdapter: 'plugin-manager',
    installable: false,
    canInstall: false,
    active: true,
    installAction: 'reinstall',
    packageInstall: { state: 'not-installed', recorded: [], present: [], missing: [] },
    nativeAgentPluginAccess: { identity: 'native-page@official', agentId: 'agent-a', enabled: false, state: 'disabled' },
    nativeSettingsLifecycle: { supported: true, canInstall: false, canUninstall: true, reason: 'installed' },
    warnings: [],
    marketplaceSkillActivations: [],
    capabilityInventory: null,
  };
}

function retainedPlugin(): MarketplacePlugin {
  return {
    id: 'native-page',
    name: 'Native Page',
    publisher: 'Hana',
    marketplaceId: 'official',
    compositeKey: 'native-page@official',
    installTarget: 'native-plugin',
    installAdapter: 'plugin-manager',
    installable: false,
    canInstall: true,
    active: false,
    retained: true,
    installAction: 'install',
    packageInstall: { state: 'not-installed', recorded: [], present: [], missing: [] },
    nativeSettingsLifecycle: { supported: true, canInstall: true, canUninstall: false, reason: 'retained non-installed' },
    warnings: [],
    marketplaceSkillActivations: [],
    capabilityInventory: null,
  };
}

function actions(busyKey: string | null): MarketplaceActions & Record<string, unknown> {
  return {
    installPlugin: vi.fn(),
    uninstallNativePlugin: vi.fn(),
    uninstallSkillsPackage: vi.fn(),
    toggleSkillPackageGate: vi.fn(),
    switchSource: vi.fn(),
    toggleNativeAgentAccess: vi.fn(),
    busyKey,
  };
}

describe('MarketplacePluginInspector busy semantics', () => {
  beforeEach(() => {
    mockSet.mockReset();
    mockStoreState = { set: mockSet };
    window.t = ((key: string, params?: Record<string, any>) => {
      const labels: Record<string, string> = {
        'settings.plugins.skillPackageToggle': 'Toggle skill package {identity}',
        'settings.plugins.skillPackageManageInSkills': 'Manage in Skills',
        'settings.plugins.enableAgentAccess': 'Enable Agent Access',
        'settings.plugins.disableAgentAccess': 'Disable Agent Access',
        'settings.plugins.marketSwitchSource': 'Switch source',
        'settings.plugins.marketPackageGateTitle': 'Package enable (global skill-manager gate)',
        'settings.plugins.marketUninstallSkills': 'Uninstall skills',
        'settings.plugins.marketUninstall': 'Uninstall',
        'settings.plugins.marketInstall': 'Install',
      };
      const template = labels[key];
      if (template === undefined) return key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
    }) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('disables skills-package uninstall and the gate toggle while another action owns the busy slot', () => {
    const act = actions('other-plugin@src');
    render(
      <MarketplacePluginInspector
        plugin={skillsPlugin()}
        marketplace={ownerPayload()}
        actions={act}
        selectedAgentId={null}
      />,
    );

    const uninstall = screen.getByRole('button', { name: 'Uninstall skills' });
    const toggle = screen.getByRole('button', { name: 'Toggle skill package skillwiki@llm-wiki' });
    expect(uninstall).toBeDisabled();
    expect(toggle).toBeDisabled();
    // Non-mutation navigation stays available.
    expect(screen.getByRole('button', { name: 'Manage in Skills' })).toBeEnabled();

    // Disabled controls must not silently swallow a click.
    fireEvent.click(uninstall);
    fireEvent.click(toggle);
    expect(act.uninstallSkillsPackage).not.toHaveBeenCalled();
    expect(act.toggleSkillPackageGate).not.toHaveBeenCalled();
  });

  it('disables native uninstall and Agent Plugin Access while any action is busy', () => {
    const act = actions('other-plugin@src');
    render(
      <MarketplacePluginInspector
        plugin={nativeActivePlugin()}
        marketplace={ownerPayload()}
        actions={act}
        selectedAgentId="agent-a"
      />,
    );

    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enable Agent Access' })).toBeDisabled();
  });

  it('disables source switch and install while any action is busy', () => {
    const act = actions('other-plugin@src');
    render(
      <MarketplacePluginInspector
        plugin={retainedPlugin()}
        marketplace={ownerPayload()}
        actions={act}
        selectedAgentId={null}
      />,
    );

    expect(screen.getByRole('button', { name: 'Switch source' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
  });

  it('keeps the same-row loading class on the package toggle', () => {
    render(
      <MarketplacePluginInspector
        plugin={skillsPlugin()}
        marketplace={ownerPayload()}
        actions={actions('skillwiki@llm-wiki')}
        selectedAgentId={null}
      />,
    );

    const toggle = screen.getByRole('button', { name: 'Toggle skill package skillwiki@llm-wiki' });
    expect(toggle.className).toMatch(/loading/);
    expect(toggle).toBeDisabled();
  });
});
