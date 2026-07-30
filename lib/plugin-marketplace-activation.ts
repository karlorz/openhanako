import {
  buildMarketplaceSkillRef,
  buildPluginMarketplaceRef,
  parseMarketplaceSkillRef,
  parsePluginMarketplaceRef,
  type MarketplaceSkillId,
} from "./plugin-marketplace-identity.ts";
import type {
  EffectiveMarketplaceSource,
  MarketplaceControlPlaneActivations,
} from "./plugin-marketplace-sources.ts";

export type MarketplaceActivationState =
  | "enabled"
  | "disabled"
  | "blocked-by-source"
  | "desired-not-installed";

export interface EffectiveActivationResult {
  identity: string;
  kind: "runtime-plugin" | "marketplace-skill";
  enabled: boolean;
  state: MarketplaceActivationState;
  marketplaceId: string;
  pluginId: string;
  skillName?: string;
  reason: string | null;
  requested: boolean;
}

export type NativeAgentPluginContribution =
  | "tools"
  | "commands"
  | "chatCards"
  | "pages"
  | "widgets";

export interface NativeAgentPluginAccessResult {
  identity: string;
  agentId: string;
  enabled: boolean;
  state: MarketplaceActivationState;
  marketplaceId: string;
  pluginId: string;
  allowedContributions: NativeAgentPluginContribution[];
  requestedContributions: NativeAgentPluginContribution[];
  serverGlobalContributions: string[];
  warnings: string[];
  reason: string | null;
}

const AGENT_FACING_ALIASES = new Map<string, NativeAgentPluginContribution>([
  ["tools", "tools"],
  ["tool", "tools"],
  ["commands", "commands"],
  ["command", "commands"],
  ["cards", "chatCards"],
  ["card", "chatCards"],
  ["chatCards", "chatCards"],
  ["chat-cards", "chatCards"],
  ["chat_cards", "chatCards"],
  ["pages", "pages"],
  ["page", "pages"],
  ["widgets", "widgets"],
  ["widget", "widgets"],
]);

const SERVER_GLOBAL_CONTRIBUTIONS = new Set([
  "routes",
  "providers",
  "extensions",
  "lifecycle",
  "background",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordEnabled(record: unknown): boolean {
  if (record === undefined) return false;
  if (record === true) return true;
  if (record === false || record === null) return false;
  if (!isPlainObject(record)) return false;
  return record.enabled === true;
}

function normalizeContribution(value: unknown): NativeAgentPluginContribution | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return AGENT_FACING_ALIASES.get(value.trim()) || null;
}

function normalizeContributions(values: unknown): NativeAgentPluginContribution[] {
  if (!Array.isArray(values)) return [];
  const out: NativeAgentPluginContribution[] = [];
  for (const value of values) {
    const normalized = normalizeContribution(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function sourceEnabledMap(sources: EffectiveMarketplaceSource[]): Map<string, boolean> {
  return new Map((sources || []).map((source) => [source.id, source.enabled !== false]));
}

function sourceState(
  marketplaceId: string,
  sources: Map<string, boolean>,
): { blocked: boolean; reason: string | null } {
  if (!sources.has(marketplaceId)) {
    return { blocked: true, reason: `marketplace source is not registered: ${marketplaceId}` };
  }
  if (sources.get(marketplaceId) === false) {
    return { blocked: true, reason: `marketplace source is disabled: ${marketplaceId}` };
  }
  return { blocked: false, reason: null };
}

export function computeRuntimePluginActivation(options: {
  identity: string;
  activations?: MarketplaceControlPlaneActivations;
  sources: EffectiveMarketplaceSource[];
  installedRuntimePluginRefs?: Iterable<string>;
}): EffectiveActivationResult {
  const parsed = parsePluginMarketplaceRef(options.identity);
  const identity = buildPluginMarketplaceRef(parsed);
  const requested = recordEnabled(options.activations?.runtimePlugins?.[identity]);
  const source = sourceState(parsed.marketplaceId, sourceEnabledMap(options.sources));
  if (source.blocked) {
    return {
      identity,
      kind: "runtime-plugin",
      enabled: false,
      state: "blocked-by-source",
      marketplaceId: parsed.marketplaceId,
      pluginId: parsed.pluginId,
      reason: source.reason,
      requested,
    };
  }
  if (!new Set(options.installedRuntimePluginRefs || []).has(identity)) {
    return {
      identity,
      kind: "runtime-plugin",
      enabled: false,
      state: requested ? "desired-not-installed" : "disabled",
      marketplaceId: parsed.marketplaceId,
      pluginId: parsed.pluginId,
      reason: requested
        ? "runtime plugin artifact is not installed"
        : "runtime plugin activation is disabled and artifact is not installed",
      requested,
    };
  }
  return {
    identity,
    kind: "runtime-plugin",
    enabled: requested,
    state: requested ? "enabled" : "disabled",
    marketplaceId: parsed.marketplaceId,
    pluginId: parsed.pluginId,
    reason: requested ? null : "runtime plugin activation is disabled",
    requested,
  };
}

export function computeMarketplaceSkillActivation(options: {
  identity: string | MarketplaceSkillId;
  agentId?: string | null;
  activations?: MarketplaceControlPlaneActivations;
  sources: EffectiveMarketplaceSource[];
  installedMarketplaceSkillRefs?: Iterable<string>;
}): EffectiveActivationResult {
  const parsed = typeof options.identity === "string"
    ? parseMarketplaceSkillRef(options.identity)
    : options.identity;
  const identity = buildMarketplaceSkillRef(parsed);
  const globalRequested = recordEnabled(options.activations?.marketplaceSkills?.[identity]);
  const agentOverride = options.agentId
    ? options.activations?.agentSkillOverrides?.[options.agentId]?.[identity]
    : undefined;
  const requested = agentOverride === undefined ? globalRequested : recordEnabled(agentOverride);
  const source = sourceState(parsed.marketplaceId, sourceEnabledMap(options.sources));
  if (source.blocked) {
    return {
      identity,
      kind: "marketplace-skill",
      enabled: false,
      state: "blocked-by-source",
      marketplaceId: parsed.marketplaceId,
      pluginId: parsed.pluginId,
      skillName: parsed.skillName,
      reason: source.reason,
      requested,
    };
  }
  if (!new Set(options.installedMarketplaceSkillRefs || []).has(identity)) {
    return {
      identity,
      kind: "marketplace-skill",
      enabled: false,
      state: requested ? "desired-not-installed" : "disabled",
      marketplaceId: parsed.marketplaceId,
      pluginId: parsed.pluginId,
      skillName: parsed.skillName,
      reason: requested
        ? "marketplace skill artifact is not installed"
        : "marketplace skill activation is disabled and artifact is not installed",
      requested,
    };
  }
  return {
    identity,
    kind: "marketplace-skill",
    enabled: requested,
    state: requested ? "enabled" : "disabled",
    marketplaceId: parsed.marketplaceId,
    pluginId: parsed.pluginId,
    skillName: parsed.skillName,
    reason: requested ? null : "marketplace skill activation is disabled",
    requested,
  };
}

export function computeNativeAgentPluginAccess(options: {
  identity: string;
  agentId: string;
  activations?: MarketplaceControlPlaneActivations;
  sources: EffectiveMarketplaceSource[];
  installedRuntimePluginRefs?: Iterable<string>;
  nativeContributions?: Iterable<string>;
}): NativeAgentPluginAccessResult {
  const parsed = parsePluginMarketplaceRef(options.identity);
  const identity = buildPluginMarketplaceRef(parsed);
  const accessRecord = options.activations?.agentPluginAccess?.[options.agentId]?.[identity];
  const requested = recordEnabled(accessRecord);
  const requestedContributions = normalizeContributions(isPlainObject(accessRecord) ? accessRecord.contributions : []);
  const source = sourceState(parsed.marketplaceId, sourceEnabledMap(options.sources));
  const contributions = [...(options.nativeContributions || [])].filter((value) => typeof value === "string");
  const agentFacingFromPackage = normalizeContributions(contributions);
  const allowedContributions = requestedContributions.length > 0
    ? requestedContributions.filter((item) => agentFacingFromPackage.includes(item))
    : agentFacingFromPackage;
  const serverGlobalContributions = contributions.filter((item) => SERVER_GLOBAL_CONTRIBUTIONS.has(item));
  const warnings = serverGlobalContributions.length > 0
    ? [`server-global native contributions remain owner-reviewed and are not sandboxed by Agent Plugin Access: ${serverGlobalContributions.join(", ")}`]
    : [];

  if (source.blocked) {
    return {
      identity,
      agentId: options.agentId,
      enabled: false,
      state: "blocked-by-source",
      marketplaceId: parsed.marketplaceId,
      pluginId: parsed.pluginId,
      allowedContributions: [],
      requestedContributions,
      serverGlobalContributions,
      warnings,
      reason: source.reason,
    };
  }
  if (!new Set(options.installedRuntimePluginRefs || []).has(identity)) {
    return {
      identity,
      agentId: options.agentId,
      enabled: false,
      state: requested ? "desired-not-installed" : "disabled",
      marketplaceId: parsed.marketplaceId,
      pluginId: parsed.pluginId,
      allowedContributions: [],
      requestedContributions,
      serverGlobalContributions,
      warnings,
      reason: requested
        ? "native runtime plugin artifact is not installed"
        : "native Agent Plugin Access is disabled and artifact is not installed",
    };
  }
  return {
    identity,
    agentId: options.agentId,
    enabled: requested,
    state: requested ? "enabled" : "disabled",
    marketplaceId: parsed.marketplaceId,
    pluginId: parsed.pluginId,
    allowedContributions: requested ? allowedContributions : [],
    requestedContributions,
    serverGlobalContributions,
    warnings,
    reason: requested ? null : "native Agent Plugin Access is disabled for this Agent",
  };
}
