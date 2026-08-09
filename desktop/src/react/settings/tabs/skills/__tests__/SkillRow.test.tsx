/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillRow } from '../SkillRow';

describe('SkillRow marketplace availability layers', () => {
  beforeEach(() => {
    window.t = ((key: string, params?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'settings.skills.marketplacePackageSource': `Marketplace package ${params?.identity || ''}`.trim(),
        'settings.skills.marketplacePackageBadge': 'Marketplace package',
        'settings.skills.toggleDisable': 'Disable',
        'settings.skills.toggleEnable': 'Enable',
        'settings.skills.toggleDisableNamed': `Disable ${params?.name || ''}`.trim(),
        'settings.skills.toggleEnableNamed': `Enable ${params?.name || ''}`.trim(),
        'settings.skills.marketplaceInactivePackage': 'Package unavailable',
        'settings.plugins.skillPackageLayerPackage': 'Package',
        'settings.plugins.skillPackageLayerAgentPreference': 'Agent preference',
        'settings.plugins.skillPackageLayerEffectiveAvailability': 'Effective availability',
        'settings.plugins.skillPackageLayerAvailable': 'available',
        'settings.plugins.skillPackageLayerUnavailable': 'unavailable',
        'settings.plugins.skillPackageEnable': 'Enable',
        'settings.plugins.skillPackageDisable': 'Disable',
        'settings.plugins.marketPackageGateEnabled': 'enabled',
        'settings.plugins.marketPackageGateDisabled': 'disabled',
      };
      return labels[key] || key;
    }) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the package, Agent preference, and effective availability layers with a labeled pressed control', () => {
    const onToggle = vi.fn();
    render(
      <SkillRow
        skill={{
          name: 'wiki-query',
          description: 'Query the project wiki',
          enabled: true,
          active: true,
          marketplacePackage: {
            identity: 'skillwiki@llm-wiki',
            skillName: 'wiki-query',
            explicitlyDisabled: false,
            packageEnabled: true,
          },
        }}
        deletable={false}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByText('Package: enabled')).toBeInTheDocument();
    expect(screen.getByText('Agent preference: enabled')).toBeInTheDocument();
    expect(screen.getByText('Effective availability: available')).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Disable wiki-query' });
    expect(toggle).toHaveTextContent('Disable');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle.className).toMatch(/plugin-labeled-action/);

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('wiki-query', false);
  });

  it('preserves the compact switch treatment for ordinary non-Marketplace skills', () => {
    render(
      <SkillRow
        skill={{ name: 'local-skill', description: 'Local skill', enabled: true }}
        deletable={false}
        onToggle={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('button', { name: 'Disable local-skill' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle.className).toContain('hana-toggle');
    expect(toggle).toBeEmptyDOMElement();
    expect(screen.queryByText('Package')).not.toBeInTheDocument();
  });
});
