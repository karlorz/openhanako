import { describe, expect, it } from 'vitest';
import type { SkillInfo } from '../../../store';
import {
  isMarketplaceSkillPreferenceWritable,
  selectMarketplaceSkillPackageSkills,
  summarizeMarketplaceSkillPackage,
} from '../marketplace-package';

function skill(name: string, overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name,
    enabled: true,
    ...overrides,
  };
}

describe('marketplace skill package membership', () => {
  it('uses provenance identity for membership and recorded names only for order', () => {
    const skills = [
      skill('same-name-local'),
      skill('other-package', {
        marketplacePackage: {
          identity: 'other@marketplace',
          skillName: 'other-package',
          explicitlyDisabled: false,
        },
      }),
      skill('target-second', {
        marketplacePackage: {
          identity: 'skillwiki@llm-wiki',
          skillName: 'target-second',
          explicitlyDisabled: false,
        },
      }),
      skill('target-first', {
        marketplacePackage: {
          identity: 'skillwiki@llm-wiki',
          skillName: 'target-first',
          explicitlyDisabled: false,
        },
      }),
      skill('target-extra', {
        marketplacePackage: {
          identity: 'skillwiki@llm-wiki',
          skillName: 'target-extra',
          explicitlyDisabled: false,
        },
      }),
    ];

    expect(
      selectMarketplaceSkillPackageSkills(
        'skillwiki@llm-wiki',
        ['target-first', 'missing-recorded-name', 'target-second'],
        skills,
      ).map((item) => item.name),
    ).toEqual(['target-first', 'target-second', 'target-extra']);
  });

  it('counts effective states and exposes only configurable writable members', () => {
    const skills = [
      skill('enabled', {
        active: true,
        marketplacePackage: {
          identity: 'skillwiki@llm-wiki',
          skillName: 'enabled',
          explicitlyDisabled: false,
        },
      }),
      skill('disabled-for-agent', {
        active: false,
        enabled: false,
        marketplacePackage: {
          identity: 'skillwiki@llm-wiki',
          skillName: 'disabled-for-agent',
          explicitlyDisabled: true,
        },
      }),
      skill('readonly', {
        readonly: true,
        marketplacePackage: {
          identity: 'skillwiki@llm-wiki',
          skillName: 'readonly',
          explicitlyDisabled: false,
        },
      }),
      skill('not-configurable', {
        configurable: false,
        marketplacePackage: {
          identity: 'skillwiki@llm-wiki',
          skillName: 'not-configurable',
          explicitlyDisabled: false,
        },
      }),
    ];

    const result = summarizeMarketplaceSkillPackage(
      'skillwiki@llm-wiki',
      ['enabled', 'disabled-for-agent', 'readonly', 'not-configurable'],
      skills,
    );

    expect(result.skills.map((item) => item.name)).toEqual([
      'enabled',
      'disabled-for-agent',
      'readonly',
      'not-configurable',
    ]);
    expect(result.enabledCount).toBe(3);
    expect(result.disabledCount).toBe(1);
    expect(result.configurableSkills.map((item) => item.name)).toEqual([
      'enabled',
      'disabled-for-agent',
    ]);
    expect(isMarketplaceSkillPreferenceWritable(skills[2])).toBe(false);
    expect(isMarketplaceSkillPreferenceWritable(skills[3])).toBe(false);
  });
});
