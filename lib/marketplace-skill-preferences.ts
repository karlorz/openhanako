import {
  buildMarketplaceSkillRef,
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

export type MarketplaceLegacySkillMigrations = Record<string, true>;

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
  config?: {
    skills?: {
      marketplace_overrides?: unknown;
      marketplace_legacy_skill_migrations?: unknown;
    };
  };
  updateConfig(partial: {
    skills: {
      marketplace_overrides: MarketplaceSkillOverrides;
      marketplace_legacy_skill_migrations: MarketplaceLegacySkillMigrations;
    };
  }): void;
}

/**
 * Result of a single legacy override migration pass. Config writes and legacy
 * record consumption are reported separately so callers and tests can assert
 * each independently: a config write that fails must not retire the legacy
 * record, and an already-migrated upgrade state retires the legacy record
 * without re-persisting config.
 */
export interface LegacyMarketplaceSkillMigrationResult {
  configWrites: number;
  retirementCandidates: Array<{ agentId: string; legacyRef: string }>;
}

export type LegacyMarketplaceSkillRecordState = "disabled" | "obsolete-migrated" | null;

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

export function normalizeMarketplaceLegacySkillMigrations(
  raw: unknown,
): MarketplaceLegacySkillMigrations {
  if (!isPlainObject(raw)) return {};
  const migrations: MarketplaceLegacySkillMigrations = {};
  for (const legacyRef of Object.keys(raw).sort((a, b) => a.localeCompare(b))) {
    if (raw[legacyRef] !== true) continue;
    try {
      const canonicalLegacyRef = buildMarketplaceSkillRef(parseMarketplaceSkillRef(legacyRef));
      migrations[canonicalLegacyRef] = true;
    } catch {
      // Invalid private metadata is never authority to change preferences.
    }
  }
  return migrations;
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

export function removeMarketplaceLegacySkillMigrationPackage(
  rawMigrations: unknown,
  identity: string,
): MarketplaceLegacySkillMigrations | null {
  const canonicalIdentity = buildPluginMarketplaceRef(parsePluginMarketplaceRef(identity));
  const migrations = normalizeMarketplaceLegacySkillMigrations(rawMigrations);
  const next: MarketplaceLegacySkillMigrations = {};
  let removed = false;
  for (const [legacyRef, value] of Object.entries(migrations)) {
    const ref = packagePreferenceRefFromLegacySkillRef(legacyRef);
    if (ref?.identity === canonicalIdentity) {
      removed = true;
      continue;
    }
    next[legacyRef] = value;
  }
  return removed ? next : null;
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

export function legacyMarketplaceSkillRecordState(
  value: unknown,
): LegacyMarketplaceSkillRecordState {
  if (value === false) return "disabled";
  if (!isPlainObject(value) || value.enabled !== false) return null;
  return isLegacyRecordAlreadyMigrated(value) ? "obsolete-migrated" : "disabled";
}

/** True only for the obsolete locally handed-off compatibility marker. */
function isLegacyRecordAlreadyMigrated(value: unknown): boolean {
  return isPlainObject(value) && value.enabled === false && value.migrated === true;
}

/**
 * Migrate known installed Claude/Hana package entries from legacy
 * source-qualified activation state. This helper changes agent configuration
 * only: it writes active preference state plus private completion metadata in
 * one operation and returns exact registry candidates for the service-owned
 * retirement batch.
 */
export function migrateLegacyMarketplaceSkillOverrides(options: {
  agents: Iterable<LegacyMarketplaceSkillMigrationAgent>;
  legacyByAgent?: unknown;
  membership: Map<string, { identity: string }>;
  onDiagnostic?: (diagnostic: MarketplaceSkillPreferenceDiagnostic) => void;
}): LegacyMarketplaceSkillMigrationResult {
  const legacyByAgent = options.legacyByAgent;
  const result: LegacyMarketplaceSkillMigrationResult = {
    configWrites: 0,
    retirementCandidates: [],
  };
  if (!isPlainObject(legacyByAgent)) return result;
  const agents = [...options.agents];

  for (const [agentId, entries] of Object.entries(legacyByAgent)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const agent = agents.find((candidate) => candidate?.id === agentId);
    if (!agent || !isPlainObject(entries)) continue;
    let nextOverrides: MarketplaceSkillOverrides = normalizeMarketplaceSkillOverrides(
      agent.config?.skills?.marketplace_overrides,
    ).overrides;
    const nextMigrations = normalizeMarketplaceLegacySkillMigrations(
      agent.config?.skills?.marketplace_legacy_skill_migrations,
    );
    let changed = false;
    const candidatesForAgent: string[] = [];

    for (const [legacyRef, record] of Object.entries(entries)
      .sort(([left], [right]) => left.localeCompare(right))) {
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

      const state = legacyMarketplaceSkillRecordState(record);
      if (!state) continue;

      const completionKnown = nextMigrations[legacyRef] === true;
      if (!completionKnown) {
        nextMigrations[legacyRef] = true;
        changed = true;
      }

      if (state === "disabled" && !completionKnown) {
        const alreadyDisabled = marketplaceSkillPreferenceFromNormalized(
          nextOverrides, ref.identity, ref.skillName,
        ).explicitlyDisabled;
        if (!alreadyDisabled) {
          nextOverrides = setMarketplaceSkillPreference(nextOverrides, ref.identity, ref.skillName, false);
          changed = true;
        }
      }

      candidatesForAgent.push(legacyRef);
    }

    if (candidatesForAgent.length === 0) continue;

    if (changed) {
      try {
        agent.updateConfig({
          skills: {
            marketplace_overrides: nextOverrides,
            marketplace_legacy_skill_migrations: normalizeMarketplaceLegacySkillMigrations(nextMigrations),
          },
        });
        result.configWrites += 1;
      } catch (error) {
        options.onDiagnostic?.({
          path: `agents.${agentId}.skills.marketplace_overrides`,
          message: `could not persist migrated preference: ${error?.message || error}`,
        });
        // Config persistence failed: do NOT retire any legacy records for this
        // agent. The migration can retry on the next pass. This preserves the
        // unconsumed records so they are still eligible for a future attempt.
        continue;
      }
    }

    for (const legacyRef of candidatesForAgent) {
      result.retirementCandidates.push({ agentId, legacyRef });
    }
  }

  return result;
}
