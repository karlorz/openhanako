import type { SkillInfo } from '../../store';
import { effectiveSkillEnabled } from './skill-state';

export interface ManagePluginsSkillPackageRow {
  kind: 'marketplace-skill-package';
  identity: string;
  pluginId: string;
  marketplaceId: string;
  name: string;
  version: string | null;
  description: string | null;
  packageState: 'installed' | 'partial' | 'stale-record';
  packageEnabled: boolean;
  packageGateRecorded: boolean;
  packageGateState: string;
  skillNames: string[];
  skillCount: number;
  missingSkillNames: string[];
  invalidSkillNames: string[];
  sourceStatus: 'ok' | 'disabled' | 'removed';
  installAdapter: 'skill-manager';
  installTarget: 'hana-skills';
  actions: {
    canToggle: boolean;
    canUninstall: boolean;
    canOpenSkills: boolean;
    canReinstall: boolean;
  };
}

export type MarketplaceSkillPackageStatus = 'enabled' | 'disabled' | 'partial' | 'stale';

export function marketplaceSkillPackageStatus(
  pkg: ManagePluginsSkillPackageRow,
): MarketplaceSkillPackageStatus {
  if (!pkg.packageEnabled) return 'disabled';
  if (pkg.packageState === 'partial') return 'partial';
  if (pkg.packageState === 'stale-record') return 'stale';
  return 'enabled';
}

export interface MarketplaceSkillPackageMembership {
  skills: SkillInfo[];
  configurableSkills: SkillInfo[];
  enabledCount: number;
  disabledCount: number;
}

/**
 * Select package members using the server-provided provenance identity.
 *
 * `skillNames` is used only to preserve the package's recorded order. It is
 * deliberately not used as a membership test: names can collide across local,
 * native, and multiple marketplace sources.
 */
export function selectMarketplaceSkillPackageSkills(
  packageIdentity: string,
  skillNames: readonly string[],
  agentSkills: readonly SkillInfo[],
): SkillInfo[] {
  const byName = new Map(agentSkills.map((skill) => [skill.name, skill]));
  const selected: SkillInfo[] = [];
  const selectedNames = new Set<string>();

  const addIfMember = (skill: SkillInfo | undefined) => {
    if (!skill || selectedNames.has(skill.name)) return;
    if (skill.marketplacePackage?.identity !== packageIdentity) return;
    selected.push(skill);
    selectedNames.add(skill.name);
  };

  for (const name of skillNames) addIfMember(byName.get(name));
  for (const skill of agentSkills) addIfMember(skill);
  return selected;
}

export function isMarketplaceSkillPreferenceWritable(skill: SkillInfo): boolean {
  return skill.configurable !== false && skill.readonly !== true;
}

export function summarizeMarketplaceSkillPackage(
  packageIdentity: string,
  skillNames: readonly string[],
  agentSkills: readonly SkillInfo[],
): MarketplaceSkillPackageMembership {
  const skills = selectMarketplaceSkillPackageSkills(packageIdentity, skillNames, agentSkills);
  const configurableSkills = skills.filter(isMarketplaceSkillPreferenceWritable);
  const enabledCount = skills.filter((skill) => effectiveSkillEnabled(skill)).length;
  return {
    skills,
    configurableSkills,
    enabledCount,
    disabledCount: skills.length - enabledCount,
  };
}
