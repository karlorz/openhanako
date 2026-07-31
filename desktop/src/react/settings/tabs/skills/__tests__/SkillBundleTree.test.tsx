/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { SkillBundleTree } from '../SkillBundleTree';
import type { SkillInfo } from '../../../store';

describe('SkillBundleTree', () => {
  afterEach(() => cleanup());

  it('keeps bundle children collapsed by default', () => {
    const skills: SkillInfo[] = [
      { name: 'writer', description: 'Write carefully', enabled: false, source: 'user' },
    ];

    render(
      <SkillBundleTree
        mode="manage"
        bundles={[{
          id: 'writing-bundle',
          name: 'Writing Bundle',
          skillNames: ['writer'],
          source: 'user',
        }]}
        skills={skills}
        nameHints={{}}
        emptyText="No skills"
      />,
    );

    expect(screen.getByText('Writing Bundle')).toBeTruthy();
    expect(screen.queryByText('writer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.skills.expandBundleAriaLabel' }));

    expect(screen.getByText('writer')).toBeTruthy();
  });

  it('marks highlighted skills and bundles for short install feedback', () => {
    const skills: SkillInfo[] = [
      { name: 'writer', description: 'Write carefully', enabled: false, source: 'user' },
      { name: 'reader', description: 'Read closely', enabled: false, source: 'user' },
    ];

    const { container } = render(
      <SkillBundleTree
        mode="manage"
        bundles={[{
          id: 'writing-bundle',
          name: 'Writing Bundle',
          skillNames: ['writer'],
          source: 'user',
        }]}
        skills={skills}
        nameHints={{}}
        emptyText="No skills"
        highlightedSkillName="reader"
        highlightedBundleId="writing-bundle"
      />,
    );

    expect(container.querySelector('[data-highlighted-skill="reader"]')).toBeTruthy();
    expect(container.querySelector('[data-highlighted-bundle="writing-bundle"]')).toBeTruthy();
  });

  it('can be controlled by a parent-owned expanded state', () => {
    const skills: SkillInfo[] = [
      { name: 'writer', description: 'Write carefully', enabled: false, source: 'user' },
    ];
    const onExpandedStateChange = vi.fn();

    render(
      <SkillBundleTree
        mode="manage"
        bundles={[{
          id: 'writing-bundle',
          name: 'Writing Bundle',
          skillNames: ['writer'],
          source: 'user',
        }]}
        skills={skills}
        nameHints={{}}
        emptyText="No skills"
        expandedState={{ 'writing-bundle': true }}
        onExpandedStateChange={onExpandedStateChange}
      />,
    );

    expect(screen.getByText('writer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.skills.collapseBundleAriaLabel' }));
    expect(onExpandedStateChange).toHaveBeenCalledWith({ 'writing-bundle': false });
  });

  it('shows package provenance and keeps an inactive package skill configurable', () => {
    const onToggleSkill = vi.fn();
    const { container } = render(
      <SkillBundleTree
        mode="agent"
        bundles={[]}
        skills={[{
          name: 'wiki-query',
          description: 'Query the wiki',
          enabled: true,
          active: false,
          inactiveReason: 'marketplace-package-disabled',
          managedBy: 'marketplace-skill-package',
          marketplacePackage: {
            identity: 'skillwiki@llm-wiki',
            skillName: 'wiki-query',
            explicitlyDisabled: false,
          },
        }]}
        nameHints={{}}
        emptyText="No skills"
        onToggleSkill={onToggleSkill}
      />,
    );

    expect(container.querySelector('[data-marketplace-package="skillwiki@llm-wiki"]')).toBeTruthy();
    expect(container.querySelector('[data-inactive-reason="marketplace-package-disabled"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.skills.toggleDisableNamed' }));
    expect(onToggleSkill).toHaveBeenCalledWith('wiki-query', false);
  });
});
