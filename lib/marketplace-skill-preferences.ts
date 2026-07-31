import {
  buildPluginMarketplaceRef,
  parseMarketplaceSkillRef,
  parsePluginMarketplaceRef,
} from "./plugin-marketplace-identity.ts";
import { sanitizeSkillName } from "./skills/skill-package-installer.ts";

/** Hana-managed per-agent preference for one installed marketplace package. */
export interface MarketplaceSkillOverride {
  disabled: string[];
}

/** Normalized `skills.marketplace_overrides` configuration. */
export type MarketplaceSkillOverrides = Record<string, MarketplaceSkillOverride>;

export interface MarketplaceSkillPreferenceDiagnostic {
  path: string;
  message: string;
}

export interface NormalizedMarketplaceSkillOverrides {
  overrides: MarketplaceSkillOverrides;
  diagnostics: MarketplaceSkillPreferenceDiagnostic[];
}

export interface MarketplaceSkillPreference {
  identity: string;
  skillName: string;
  explicitlyDisabled: boolean;
}

export interface MarketplaceSkillPackagePreferenceRef {
  identity: string;
  skillName: string;
}

export interface LegacyMarketplaceSkillMigrationAgent {
  id: string;
  config?: { skills?: { marketplace_overrides?: unknown } };
  updateConfig(partial: { skills: { marketplace_overrides: MarketplaceSkillOverrides } }): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addDiagnostic(
  diagnostics: MarketplaceSkillPreferenceDiagnostic[],
  path: string,
  message: string,
): void {
  diagnostics.push({ path, message });
}

function normalizedSkillName(value: unknown): string | null {
  return typeof value === "string" ? sanitizeSkillName(value) : null;
}

/**
 * Normalize the optional agent config map without allowing malformed user
 * edits to prevent Skills initialization. Valid tombstones are retained even
 * when their skill is currently not installed.
 */
export function normalizeMarketplaceSkillOverrides(raw: unknown): NormalizedMarketplaceSkillOverrides {
  const diagnostics: MarketplaceSkillPreferenceDiagnostic[] = [];
  const overrides: MarketplaceSkillOverrides = {};
  if (raw === undefined || raw === null) return { overrides, diagnostics };
  if (!isPlainObject(raw)) {
    addDiagnostic(diagnostics, "skills.marketplace_overrides", "expected an object");
    return { overrides, diagnostics };
  }

  for (const identity of Object.keys(raw).sort((a, b) => a.localeCompare(b))) {
    let canonicalIdentity: string;
    try {
      canonicalIdentity = buildPluginMarketplaceRef(parsePluginMarketplaceRef(identity));
    } catch {
      addDiagnostic(
        diagnostics,
        `skills.marketplace_overrides.${identity}`,
        "package identity must be source-qualified as pluginId@marketplaceId",
      );
      continue;
    }

    const entry = raw[identity];
    if (!isPlainObject(entry)) {
      addDiagnostic(
        diagnostics,
        `skills.marketplace_overrides.${identity}`,
        "package override must be an object",
      );
      continue;
    }
    if (!Array.isArray(entry.disabled)) {
      addDiagnostic(
        diagnostics,
        `skills.marketplace_overrides.${identity}.disabled`,
        "disabled must be an array of skill names",
      );
      continue;
    }

    const disabled = new Set<string>();
    for (const [index, value] of entry.disabled.entries()) {
      const skillName = normalizedSkillName(value);
      if (!skillName) {
        addDiagnostic(
          diagnostics,
          `skills.marketplace_overrides.${identity}.disabled[${index}]`,
          "skill name is invalid",
        );
        continue;
      }
      disabled.add(skillName);
    }

    // An empty entry has the same meaning as an absent entry. Keeping the
    // serialized map compact also makes enable toggles deterministic.
    if (disabled.size > 0) {
      overrides[canonicalIdentity] = { disabled: [...disabled].sort((a, b) => a.localeCompare(b)) };
    }
  }

  return { overrides, diagnostics };
}

/** Return true only for an explicit per-agent opt-out. */
export function isMarketplaceSkillDisabled(
  rawOverrides: unknown,
  identity: string,
  skillName: string,
): boolean {
  const { overrides } = normalizeMarketplaceSkillOverrides(rawOverrides);
  return marketplaceSkillPreferenceFromNormalized(overrides, identity, skillName).explicitlyDisabled;
}

/** Query a map that has already been normalized by the caller. */
export function marketplaceSkillPreferenceFromNormalized(
  overrides: MarketplaceSkillOverrides,
  identity: string,
  skillName: string,
): MarketplaceSkillPreference {
  let canonicalIdentity: string;
  try {
    canonicalIdentity = buildPluginMarketplaceRef(parsePluginMarketplaceRef(identity));
  } catch {
    return { identity, skillName, explicitlyDisabled: false };
  }
  const normalizedName = normalizedSkillName(skillName);
  return {
    identity,
    skillName,
    explicitlyDisabled: Boolean(normalizedName && overrides[canonicalIdentity]?.disabled.includes(normalizedName)),
  };
}

/**
 * Update one per-agent preference while preserving every valid sibling entry.
 * `enabled=false` records an opt-out; `enabled=true` removes only that opt-out.
 */
export function setMarketplaceSkillPreference(
  rawOverrides: unknown,
  identity: string,
  skillName: string,
  enabled: boolean,
): MarketplaceSkillOverrides {
  const canonicalIdentity = buildPluginMarketplaceRef(parsePluginMarketplaceRef(identity));
  const normalizedName = normalizedSkillName(skillName);
  if (!normalizedName) throw new Error(`Invalid marketplace skill name: ${String(skillName)}`);

  const { overrides } = normalizeMarketplaceSkillOverrides(rawOverrides);
  const next: MarketplaceSkillOverrides = structuredClone(overrides);
  const current = new Set(next[canonicalIdentity]?.disabled || []);
  if (enabled) current.delete(normalizedName);
  else current.add(normalizedName);

  if (current.size === 0) delete next[canonicalIdentity];
  else next[canonicalIdentity] = { disabled: [...current].sort((a, b) => a.localeCompare(b)) };
  return Object.fromEntries(Object.keys(next).sort((a, b) => a.localeCompare(b)).map((key) => [
    key,
    { disabled: [...next[key].disabled].sort((a, b) => a.localeCompare(b)) },
  ]));
}

/** Remove all persisted per-agent preferences for an uninstalled package. */
export function removeMarketplaceSkillPackagePreference(
  rawOverrides: unknown,
  identity: string,
  skillNames?: Iterable<string>,
): MarketplaceSkillOverrides | null {
  const canonicalIdentity = buildPluginMarketplaceRef(parsePluginMarketplaceRef(identity));
  const { overrides } = normalizeMarketplaceSkillOverrides(rawOverrides);
  const current = overrides[canonicalIdentity];
  if (!current) return null;
  const next = structuredClone(overrides);
  if (skillNames === undefined) {
    delete next[canonicalIdentity];
    return next;
  }

  const names = new Set(skillNames);
  const remaining = current.disabled.filter((name) => !names.has(name));
  if (remaining.length === current.disabled.length) return null;
  if (remaining.length === 0) delete next[canonicalIdentity];
  else next[canonicalIdentity] = { disabled: remaining };
  return next;
}

/** Metadata used by Skills API consumers for a known package-owned skill. */
export function marketplaceSkillPreference(
  rawOverrides: unknown,
  identity: string,
  skillName: string,
): MarketplaceSkillPreference {
  return marketplaceSkillPreferenceFromNormalized(
    normalizeMarketplaceSkillOverrides(rawOverrides).overrides,
    identity,
    skillName,
  );
}

/**
 * Adapt a legacy source-qualified skill activation key to the new package
 * preference identity. Membership checks belong to the caller; this helper
 * only performs strict identity parsing.
 */
export function packagePreferenceRefFromLegacySkillRef(
  value: unknown,
): MarketplaceSkillPackagePreferenceRef | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = parseMarketplaceSkillRef(value);
    return {
      identity: buildPluginMarketplaceRef(parsed),
      skillName: parsed.skillName,
    };
  } catch {
    return null;
  }
}

function isExplicitlyDisabledLegacyRecord(value: unknown): boolean {
  return value === false
    || (isPlainObject(value) && value.enabled === false);
}

/**
 * Migrate only known installed Claude/Hana package entries from the legacy
 * source-qualified activation map. Native marketplace records remain intact;
 * callers supply the installed membership map to prevent bare-name guesses.
 */
export function migrateLegacyMarketplaceSkillOverrides(options: {
  agents: Iterable<LegacyMarketplaceSkillMigrationAgent>;
  legacyByAgent?: unknown;
  membership: Map<string, { identity: string }>;
  onDiagnostic?: (diagnostic: MarketplaceSkillPreferenceDiagnostic) => void;
}): number {
  const legacyByAgent = options.legacyByAgent;
  if (!isPlainObject(legacyByAgent)) return 0;
  const agents = [...options.agents];
  let migrated = 0;

  for (const [agentId, entries] of Object.entries(legacyByAgent)) {
    const agent = agents.find((candidate) => candidate?.id === agentId);
    if (!agent || !isPlainObject(entries)) continue;
    let nextOverrides: MarketplaceSkillOverrides = normalizeMarketplaceSkillOverrides(
      agent.config?.skills?.marketplace_overrides,
    ).overrides;
    let changed = false;

    for (const [legacyRef, record] of Object.entries(entries)) {
      const ref = packagePreferenceRefFromLegacySkillRef(legacyRef);
      if (!ref) {
        options.onDiagnostic?.({
          path: `activations.agentSkillOverrides.${agentId}.${legacyRef}`,
          message: "legacy marketplace skill reference is malformed",
        });
        continue;
      }
      const membership = options.membership.get(ref.skillName);
      if (!membership || membership.identity !== ref.identity) continue;
      if (!isExplicitlyDisabledLegacyRecord(record)) continue;
      if (marketplaceSkillPreferenceFromNormalized(nextOverrides, ref.identity, ref.skillName).explicitlyDisabled) continue;
      nextOverrides = setMarketplaceSkillPreference(nextOverrides, ref.identity, ref.skillName, false);
      changed = true;
    }

    if (!changed) continue;
    try {
      agent.updateConfig({ skills: { marketplace_overrides: nextOverrides } });
      migrated += 1;
    } catch (error) {
      options.onDiagnostic?.({
        path: `agents.${agentId}.skills.marketplace_overrides`,
        message: `could not persist migrated preference: ${error?.message || error}`,
      });
    }
  }
  return migrated;
}
