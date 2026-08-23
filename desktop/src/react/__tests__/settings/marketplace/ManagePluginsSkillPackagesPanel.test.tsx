/**
 * @vitest-environment jsdom
 *
 * ManagePluginsSkillPackagesPanel row contract: renders each installed
 * skill-package row (kind + status badges, identity, description, skill
 * count) and routes the row actions through the onOpen / onToggle /
 * onUninstall callbacks with the exact identity/row semantics the Manage
 * Plugins tab previously handled inline.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ManagePluginsSkillPackagesPanel } from '../../../settings/components/plugins/ManagePluginsSkillPackagesPanel';
import type { ManagePluginsSkillPackageRow } from '../../../settings/tabs/skills/marketplace-package';

function skillPackageRow(overrides: Partial<ManagePluginsSkillPackageRow> = {}): ManagePluginsSkillPackageRow {
  return {
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
    ...overrides,
  };
}

function panelMeta(overrides: Record<string, unknown> = {}) {
  return {
    registry: { revision: 7, digest: 'a'.repeat(64) },
    access: { isStudioOwner: true, isLocalOwner: true },
    activations: {},
    ...overrides,
  };
}

function renderPanel(options: {
  rows?: ManagePluginsSkillPackageRow[];
  meta?: ReturnType<typeof panelMeta>;
  busyIdentity?: string | null;
} = {}) {
  const onOpen = vi.fn();
  const onToggle = vi.fn();
  const onUninstall = vi.fn();
  render(
    <ManagePluginsSkillPackagesPanel
      rows={options.rows ?? [skillPackageRow()]}
      meta={options.meta ?? panelMeta()}
      onOpen={onOpen}
      onToggle={onToggle}
      onUninstall={onUninstall}
      busyIdentity={options.busyIdentity ?? null}
    />,
  );
  return { onOpen, onToggle, onUninstall };
}

describe('ManagePluginsSkillPackagesPanel', () => {
  beforeEach(() => {
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
        'settings.plugins.skillPackageOpenSkills': `Open skills for ${params?.name || ''}`.trim(),
        'settings.plugins.skillPackageOpenArea': `Open the ${params?.name || ''} skill package`.trim(),
        'settings.plugins.skillPackageSkillsCount': `${params?.count || '0'} skills`,
        'settings.plugins.skillPackageManageInSkills': 'Manage in Skills',
        'settings.plugins.skillPackageRemove': 'Remove',
        'settings.plugins.skillPackageEnable': 'Enable',
        'settings.plugins.skillPackageDisable': 'Disable',
        'settings.plugins.skillPackageLayerPackage': 'Package',
        'settings.plugins.skillPackageLayerAgentPreference': 'Agent preference',
        'settings.plugins.skillPackageLayerEffectiveAvailability': 'Effective availability',
        'settings.plugins.skillPackageLayerPreferencesPreserved': 'Preserved per Agent',
        'settings.plugins.skillPackageLayerAvailable': 'Available',
        'settings.plugins.skillPackageLayerUnavailable': 'Unavailable',
        'settings.plugins.skillPackageLayerPartial': 'Partially available',
        'settings.plugins.marketPackageGateEnabled': 'enabled',
        'settings.plugins.marketPackageGateDisabled': 'disabled',
        'settings.plugins.skillPackageDisabledPreservesPreferences': 'Disabled; preferences preserved.',
        'settings.plugins.skillPackageDefaultOn': 'Enabled by default.',
      };
      return labels[key] || key;
    }) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders each skill-package row with kind badge, status badge, and identity', () => {
    renderPanel({
      rows: [
        skillPackageRow(),
        skillPackageRow({
          identity: 'demo@llm-wiki',
          pluginId: 'demo',
          marketplaceId: 'llm-wiki',
          name: 'Demo',
          packageEnabled: false,
        }),
      ],
    });

    expect(screen.getByText('SkillWiki')).toBeInTheDocument();
    expect(screen.getByText('skillwiki@llm-wiki')).toBeInTheDocument();
    expect(screen.getByText('Demo')).toBeInTheDocument();
    expect(screen.getByText('demo@llm-wiki')).toBeInTheDocument();
    expect(screen.getAllByText('Hana skills')).toHaveLength(2);
    expect(screen.getByText('enabled')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
    expect(screen.getAllByText(/2 skills · wiki-query, wiki-write/)).toHaveLength(2);

    const openSkills = screen.getByRole('button', { name: 'Open skills for SkillWiki' });
    expect(openSkills).toHaveAttribute('title', 'Open skills for SkillWiki');
    expect(openSkills).toHaveTextContent('Manage in Skills');
    expect(openSkills.className).toMatch(/pv-add-form-btn/);
    expect(openSkills.className).toMatch(/plugin-labeled-action/);
    expect(openSkills.className).not.toMatch(/skill-card-delete/);
    expect(screen.getAllByText(/Package: enabled|Package: disabled/)).toHaveLength(2);
    expect(screen.getAllByText('Agent preference: Preserved per Agent')).toHaveLength(2);
    expect(screen.getByText('Effective availability: Available')).toBeInTheDocument();
    expect(screen.getByText('Effective availability: Unavailable')).toBeInTheDocument();
  });

  it('fires onOpen with the row identity from the open-skills button', () => {
    const { onOpen } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Open skills for SkillWiki' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('skillwiki@llm-wiki');
  });

  it('fires onOpen with the row identity from the open area and never claims a native status', () => {
    const { onOpen } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Open the SkillWiki skill package' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('skillwiki@llm-wiki');
    expect(screen.queryByText('loaded')).not.toBeInTheDocument();
  });

  it('fires onToggle with the row and the next gate state', () => {
    const { onToggle } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle package skillwiki@llm-wiki' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0][0]).toMatchObject({ identity: 'skillwiki@llm-wiki' });
    expect(onToggle.mock.calls[0][1]).toBe(false);
    const toggle = screen.getByRole('button', { name: 'Toggle package skillwiki@llm-wiki' });
    expect(toggle).toHaveTextContent('Disable');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('fires onUninstall with the row', () => {
    const { onUninstall } = renderPanel();

    const remove = screen.getByTitle(/Uninstall skillwiki@llm-wiki/);
    expect(remove).toHaveTextContent('Remove');
    fireEvent.click(remove);

    expect(onUninstall).toHaveBeenCalledTimes(1);
    expect(onUninstall.mock.calls[0][0]).toMatchObject({ identity: 'skillwiki@llm-wiki' });
  });

  it('locks the row toggle while its identity is busy', () => {
    renderPanel({ busyIdentity: 'skillwiki@llm-wiki' });

    const toggle = screen.getByRole('button', { name: 'Toggle package skillwiki@llm-wiki' });
    expect(toggle).toBeDisabled();
    expect(toggle.className).toMatch(/loading/);
  });

  it('hides owner actions for non-owners but still shows the inventory row', () => {
    renderPanel({
      meta: panelMeta({ access: { isStudioOwner: false, isLocalOwner: false } }),
    });

    expect(screen.getByText('SkillWiki')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Toggle package skillwiki@llm-wiki/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Uninstall skillwiki@llm-wiki/)).not.toBeInTheDocument();
  });
});
