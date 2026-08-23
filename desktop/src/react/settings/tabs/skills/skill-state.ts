import type { SkillInfo } from '../../store';

/** Runtime state takes precedence over the preserved per-agent preference. */
export function effectiveSkillEnabled(skill: SkillInfo): boolean {
  return skill.active ?? skill.enabled;
}

/** Package-gated controls are read-only until Manage Plugins re-enables them. */
export function skillToggleDisabled(skill: SkillInfo): boolean {
  if (!skill.marketplacePackage) return false;
  return skill.marketplacePackage.packageEnabled === false
    || (skill.active === false && (
      skill.inactiveReason === 'marketplace-package-disabled'
      || skill.inactiveReason === 'marketplace-source-blocked'
    ));
}
