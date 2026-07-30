import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  assertMarketplaceId,
  buildPluginMarketplaceRef,
  parsePluginMarketplaceRef,
} from "./plugin-marketplace-identity.ts";
import type {
  MarketplaceSourceDescriptor,
  PluginMarketplaceSourceRegistry,
} from "./plugin-marketplace-sources.ts";

export const CLAUDE_COMPATIBILITY_SCHEMA_VERSION = 1 as const;
export const CLAUDE_COMPATIBILITY_BRIDGE_VERSION = "claude-compatibility-bridge.v1" as const;

export type ClaudeCompatibilityMode = "live" | "mirror" | "snapshot";
export type ClaudeCompatibilityInputRole =
  | "user-settings"
  | "project-settings"
  | "project-local-settings"
  | "known-marketplaces"
  | "installed-plugins"
  | "marketplace-manifest"
  | "plugin-manifest";

export interface ClaudeCompatibilityInput {
  role: ClaudeCompatibilityInputRole;
  path: string;
}

export interface ClaudeCompatibilityBinding {
  id: string;
  mode: ClaudeCompatibilityMode;
  enabled: boolean;
  inputs: ClaudeCompatibilityInput[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ClaudeCompatibilityWarning {
  code: string;
  category:
    | "secret"
    | "environment"
    | "hook"
    | "mcp"
    | "lsp"
    | "command"
    | "binary"
    | "lifecycle"
    | "monitor"
    | "session-start"
    | "permission"
    | "unsupported"
    | "invalid";
  role: ClaudeCompatibilityInputRole;
  message: string;
}

export interface ClaudeVirtualSource {
  id: string;
  identity: `claude:${string}:${string}`;
  name: string;
  descriptor: MarketplaceSourceDescriptor;
  promoted: false;
}

export interface ClaudeCompatibilityPackage {
  identity: string;
  pluginId: string;
  marketplaceId: string;
  installed: boolean;
  desiredEnabled: boolean;
  state: "enabled" | "disabled" | "desired-not-installed" | "installed-default";
  version: string | null;
  classification: "hana-skills" | "unsupported";
}

export interface ClaudeCompatibilityNormalizedState {
  schemaVersion: typeof CLAUDE_COMPATIBILITY_SCHEMA_VERSION;
  bindingId: string;
  mode: ClaudeCompatibilityMode;
  digest: string;
  generatedAt: string;
  provenance: Array<{ role: ClaudeCompatibilityInputRole; path: string; digest: string }>;
  virtualSources: ClaudeVirtualSource[];
  packages: ClaudeCompatibilityPackage[];
  desiredPlugins: Record<string, boolean>;
  warnings: ClaudeCompatibilityWarning[];
  precedence: readonly [
    "hana-safety-policy",
    "hana-config-override",
    "hana-agent-override",
    "claude-project-local",
    "claude-project",
    "claude-user",
    "existing-default",
  ];
}

export interface ClaudeCompatibilityStatus {
  binding: ClaudeCompatibilityBinding;
  state: ClaudeCompatibilityNormalizedState | null;
  lastKnownGood: boolean;
  diagnostic: null | {
    code: string;
    message: string;
    firstFailureAt: string;
    graceExpired: boolean;
  };
  pendingBoundary: "next-agent-snapshot" | null;
  refreshCount: number;
}

export interface ClaudeCompatibilityFsOps {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string, encoding: BufferEncoding): string;
  mkdirSync(dirPath: string, options?: { recursive?: boolean }): void;
  writeFileSync(filePath: string, data: string, encoding?: BufferEncoding): void;
  renameSync(from: string, to: string): void;
}

const PRECEDENCE = [
  "hana-safety-policy",
  "hana-config-override",
  "hana-agent-override",
  "claude-project-local",
  "claude-project",
  "claude-user",
  "existing-default",
] as const;

const INPUT_ROLES = new Set<ClaudeCompatibilityInputRole>([
  "user-settings",
  "project-settings",
  "project-local-settings",
  "known-marketplaces",
  "installed-plugins",
  "marketplace-manifest",
  "plugin-manifest",
]);

const UNSUPPORTED_KEYS: Array<{ test: RegExp; category: ClaudeCompatibilityWarning["category"]; label: string }> = [
  { test: /^(?:env|environment|apiKey|token|secret|password|credential|cookie|headers?)$/i, category: "secret", label: "secret or environment data" },
  { test: /^hooks?$/i, category: "hook", label: "Claude hooks" },
  { test: /^(?:mcp|mcpServers)$/i, category: "mcp", label: "MCP configuration" },
  { test: /^lsp$/i, category: "lsp", label: "LSP configuration" },
  { test: /^(?:commands?|agents?)$/i, category: "command", label: "arbitrary Claude commands or agents" },
  { test: /^(?:bin|binaries|executables?)$/i, category: "binary", label: "package binaries" },
  { test: /^(?:scripts?|lifecycle|postinstall|preinstall)$/i, category: "lifecycle", label: "lifecycle scripts" },
  { test: /^(?:monitor|monitors|watchers?)$/i, category: "monitor", label: "monitor behavior" },
  { test: /^SessionStart$/i, category: "session-start", label: "SessionStart behavior" },
  { test: /^(?:permissions?|allowedTools|deny|allow)$/i, category: "permission", label: "Claude permission policy" },
];

function defaultFsOps(): ClaudeCompatibilityFsOps {
  return {
    existsSync: fs.existsSync.bind(fs),
    readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
    mkdirSync: (dirPath, options) => { fs.mkdirSync(dirPath, options); },
    writeFileSync: (filePath, data, encoding) => { fs.writeFileSync(filePath, data, encoding); },
    renameSync: fs.renameSync.bind(fs),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeNow(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

function assertBindingId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error("Claude compatibility binding id must be a bounded identifier");
  }
  return value;
}

function assertAbsoluteAuthorizedPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new Error("Claude compatibility inputs must use explicit absolute paths");
  }
  return path.resolve(value);
}

export function validateClaudeCompatibilityBinding(value: unknown): ClaudeCompatibilityBinding {
  if (!isRecord(value)) throw new Error("Claude compatibility binding must be an object");
  const allowed = new Set(["id", "mode", "enabled", "inputs", "createdAt", "updatedAt"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported Claude compatibility binding field: ${key}`);
  }
  const id = assertBindingId(value.id);
  if (value.mode !== "live" && value.mode !== "mirror" && value.mode !== "snapshot") {
    throw new Error(`Unsupported Claude compatibility binding mode: ${String(value.mode)}`);
  }
  if (!Array.isArray(value.inputs) || value.inputs.length === 0 || value.inputs.length > 64) {
    throw new Error("Claude compatibility binding requires 1-64 explicit inputs");
  }
  const seen = new Set<string>();
  const inputs = value.inputs.map((raw) => {
    if (!isRecord(raw)) throw new Error("Claude compatibility input must be an object");
    if (Object.keys(raw).some((key) => key !== "role" && key !== "path")) {
      throw new Error("Claude compatibility input supports role and path only");
    }
    if (!INPUT_ROLES.has(raw.role as ClaudeCompatibilityInputRole)) {
      throw new Error(`Unsupported Claude compatibility input role: ${String(raw.role)}`);
    }
    const filePath = assertAbsoluteAuthorizedPath(raw.path);
    const key = `${raw.role}:${filePath}`;
    if (seen.has(key)) throw new Error(`Duplicate Claude compatibility input: ${key}`);
    seen.add(key);
    return { role: raw.role as ClaudeCompatibilityInputRole, path: filePath };
  });
  return {
    id,
    mode: value.mode,
    enabled: value.enabled !== false,
    inputs,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

export function validateClaudeCompatibilityBindings(value: unknown): ClaudeCompatibilityBinding[] {
  if (!Array.isArray(value)) throw new Error("claudeCompatibility.bindings must be an array");
  const bindings = value.map(validateClaudeCompatibilityBinding);
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (ids.has(binding.id)) throw new Error(`Duplicate Claude compatibility binding id: ${binding.id}`);
    ids.add(binding.id);
  }
  return bindings;
}

function readJsonInput(input: ClaudeCompatibilityInput, fsOps: ClaudeCompatibilityFsOps) {
  if (!fsOps.existsSync(input.path)) {
    throw new Error(`Authorized Claude compatibility input is absent: ${input.role}`);
  }
  const raw = fsOps.readFileSync(input.path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Authorized Claude compatibility input is malformed JSON: ${input.role}`);
  }
  if (!isRecord(parsed)) throw new Error(`Authorized Claude compatibility input must contain an object: ${input.role}`);
  return { parsed, raw, digest: sha256(raw) };
}

function collectUnsupportedKeys(
  value: unknown,
  role: ClaudeCompatibilityInputRole,
  warnings: ClaudeCompatibilityWarning[],
  depth = 0,
) {
  if (depth > 8 || !isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const unsupported = UNSUPPORTED_KEYS.find((candidate) => candidate.test.test(key));
    if (unsupported) {
      warnings.push({
        code: `CLAUDE_COMPAT_UNSUPPORTED_${unsupported.category.toUpperCase().replace(/-/g, "_")}`,
        category: unsupported.category,
        role,
        message: `${unsupported.label} is excluded from Hana compatibility state.`,
      });
      continue;
    }
    if (isRecord(child)) collectUnsupportedKeys(child, role, warnings, depth + 1);
  }
}

function normalizeGithubRepo(repo: string): string | null {
  const trimmed = repo.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed.replace(/\.git$/i, "")}.git`;
  }
  return null;
}

function descriptorFromClaudeSource(id: string, raw: unknown): MarketplaceSourceDescriptor | null {
  const marketplaceId = assertMarketplaceId(id);
  const record = typeof raw === "string" ? { source: raw } : isRecord(raw) ? raw : null;
  if (!record) return null;
  const source = isRecord(record.source) ? record.source : record;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : marketplaceId;
  const repoValue = typeof source.repo === "string" ? source.repo : typeof source.repository === "string" ? source.repository : null;
  const githubUrl = repoValue ? normalizeGithubRepo(repoValue) : null;
  const gitUrl = githubUrl
    || (typeof source.url === "string" && /^https:\/\//i.test(source.url) ? source.url : null)
    || (typeof source.gitUrl === "string" && /^https:\/\//i.test(source.gitUrl) ? source.gitUrl : null);
  if (gitUrl) {
    const gitRef = typeof source.ref === "string" && source.ref.trim() ? source.ref.trim() : undefined;
    const indexPath = typeof source.path === "string" && source.path.trim() ? source.path.trim() : ".claude-plugin/marketplace.json";
    return { id: marketplaceId, name, kind: "git", gitUrl, ...(gitRef ? { gitRef } : {}), indexPath };
  }
  if (typeof source.path === "string" && path.isAbsolute(source.path)) {
    return { id: marketplaceId, name, kind: "local", path: path.resolve(source.path), indexPath: ".claude-plugin/marketplace.json" };
  }
  return null;
}

function marketplaceEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) return [];
  const nested = isRecord(value.marketplaces)
    ? value.marketplaces
    : isRecord(value.knownMarketplaces)
      ? value.knownMarketplaces
      : value;
  return Object.entries(nested);
}

function enabledPluginEntries(value: unknown): Array<[string, boolean]> {
  if (!isRecord(value) || !isRecord(value.enabledPlugins)) return [];
  return Object.entries(value.enabledPlugins)
    .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean");
}

function installedPluginEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) return [];
  const plugins = isRecord(value.plugins) ? value.plugins : value;
  return Object.entries(plugins);
}

function versionFromInstalled(value: unknown): string | null {
  if (isRecord(value) && typeof value.version === "string") return value.version;
  if (Array.isArray(value)) {
    const match = value.find((item) => isRecord(item) && typeof item.version === "string") as Record<string, unknown> | undefined;
    return match ? String(match.version) : null;
  }
  return null;
}

function safeQualifiedPluginIdentity(value: string): string | null {
  try {
    const parsed = parsePluginMarketplaceRef(value);
    return buildPluginMarketplaceRef(parsed);
  } catch {
    return null;
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unrecognized content: ${key}`);
  }
}

function assertBridgeDescriptor(value: unknown) {
  if (!isRecord(value)) throw new Error("Bridge virtual source descriptor must be an object");
  if (value.kind === "git") {
    assertOnlyKeys(value, ["id", "name", "kind", "gitUrl", "gitRef", "indexPath", "enabled"], "Bridge git source descriptor");
    if (typeof value.gitUrl !== "string" || !/^https:\/\//i.test(value.gitUrl)) throw new Error("Bridge git source must use public HTTPS");
  } else if (value.kind === "local") {
    assertOnlyKeys(value, ["id", "name", "kind", "path", "indexPath", "enabled"], "Bridge local source descriptor");
    if (typeof value.path !== "string" || !path.isAbsolute(value.path)) throw new Error("Bridge local source path must be explicit");
  } else if (value.kind === "url") {
    assertOnlyKeys(value, ["id", "name", "kind", "url", "enabled"], "Bridge URL source descriptor");
    if (typeof value.url !== "string" || !/^https:\/\//i.test(value.url)) throw new Error("Bridge URL source must use public HTTPS");
  } else {
    throw new Error("Bridge virtual source descriptor kind is unsupported");
  }
  assertMarketplaceId(value.id);
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Bridge source name is required");
}

export function parseClaudeCompatibilityBinding(
  rawBinding: unknown,
  options: {
    fsOps?: ClaudeCompatibilityFsOps;
    now?: () => Date;
    hanaConfigOverrides?: Record<string, boolean>;
    hanaAgentOverrides?: Record<string, boolean>;
    safetyPolicy?: (identity: string, desired: boolean) => boolean;
  } = {},
): ClaudeCompatibilityNormalizedState {
  const binding = validateClaudeCompatibilityBinding(rawBinding);
  const fsOps = options.fsOps || defaultFsOps();
  const warnings: ClaudeCompatibilityWarning[] = [];
  const virtualSources = new Map<string, ClaudeVirtualSource>();
  const installed = new Map<string, { version: string | null }>();
  const layers: Array<Map<string, boolean>> = [new Map(), new Map(), new Map()];
  const provenance: ClaudeCompatibilityNormalizedState["provenance"] = [];
  const digestParts: string[] = [];

  for (const input of binding.inputs) {
    const { parsed, digest } = readJsonInput(input, fsOps);
    provenance.push({ role: input.role, path: input.path, digest });
    digestParts.push(`${input.role}:${input.path}:${digest}`);
    collectUnsupportedKeys(parsed, input.role, warnings);

    if (input.role === "user-settings" || input.role === "project-settings" || input.role === "project-local-settings") {
      const layerIndex = input.role === "user-settings" ? 0 : input.role === "project-settings" ? 1 : 2;
      for (const [identity, enabled] of enabledPluginEntries(parsed)) {
        const qualified = safeQualifiedPluginIdentity(identity);
        if (!qualified) {
          warnings.push({
            code: "CLAUDE_COMPAT_BARE_OR_INVALID_PLUGIN_IDENTITY",
            category: "invalid",
            role: input.role,
            message: "An enabledPlugins entry was excluded because it was not exactly source-qualified.",
          });
          continue;
        }
        layers[layerIndex].set(qualified, enabled);
      }
      const extras = isRecord(parsed.extraKnownMarketplaces) ? parsed.extraKnownMarketplaces : {};
      for (const [id, rawSource] of Object.entries(extras)) {
        try {
          const descriptor = descriptorFromClaudeSource(id, rawSource);
          if (!descriptor) {
            warnings.push({
              code: "CLAUDE_COMPAT_SOURCE_UNSUPPORTED",
              category: "unsupported",
              role: input.role,
              message: "A Claude marketplace source was excluded because its source form is unsupported.",
            });
            continue;
          }
          virtualSources.set(descriptor.id, {
            id: descriptor.id,
            identity: `claude:${binding.id}:${descriptor.id}`,
            name: descriptor.name,
            descriptor,
            promoted: false,
          });
        } catch {
          warnings.push({
            code: "CLAUDE_COMPAT_SOURCE_INVALID",
            category: "invalid",
            role: input.role,
            message: "A Claude marketplace source was excluded because its exact identity was invalid.",
          });
        }
      }
    }

    if (input.role === "known-marketplaces" || input.role === "marketplace-manifest") {
      for (const [id, rawSource] of marketplaceEntries(parsed)) {
        try {
          const descriptor = descriptorFromClaudeSource(id, rawSource);
          if (!descriptor) continue;
          virtualSources.set(descriptor.id, {
            id: descriptor.id,
            identity: `claude:${binding.id}:${descriptor.id}`,
            name: descriptor.name,
            descriptor,
            promoted: false,
          });
        } catch {
          warnings.push({
            code: "CLAUDE_COMPAT_SOURCE_INVALID",
            category: "invalid",
            role: input.role,
            message: "A Claude marketplace source was excluded because its exact identity was invalid.",
          });
        }
      }
    }

    if (input.role === "installed-plugins") {
      for (const [identity, facts] of installedPluginEntries(parsed)) {
        const qualified = safeQualifiedPluginIdentity(identity);
        if (!qualified) continue;
        installed.set(qualified, { version: versionFromInstalled(facts) });
      }
    }
  }

  const desired = new Map<string, boolean>();
  for (const layer of layers) for (const [identity, enabled] of layer) desired.set(identity, enabled);
  for (const [identity, enabled] of Object.entries(options.hanaAgentOverrides || {})) {
    const qualified = safeQualifiedPluginIdentity(identity);
    if (qualified) desired.set(qualified, enabled);
  }
  for (const [identity, enabled] of Object.entries(options.hanaConfigOverrides || {})) {
    const qualified = safeQualifiedPluginIdentity(identity);
    if (qualified) desired.set(qualified, enabled);
  }
  for (const [identity, enabled] of desired) {
    desired.set(identity, options.safetyPolicy ? options.safetyPolicy(identity, enabled) : enabled);
  }

  const identities = new Set([...desired.keys(), ...installed.keys()]);
  const packages: ClaudeCompatibilityPackage[] = [...identities].sort().map((identity) => {
    const parsed = parsePluginMarketplaceRef(identity);
    const installedFacts = installed.get(identity);
    const installedPresent = Boolean(installedFacts);
    const desiredEnabled = desired.get(identity) ?? false;
    return {
      identity,
      pluginId: parsed.pluginId,
      marketplaceId: parsed.marketplaceId,
      installed: installedPresent,
      desiredEnabled,
      state: desiredEnabled && !installedPresent
        ? "desired-not-installed"
        : desiredEnabled
          ? "enabled"
          : installedPresent && !desired.has(identity)
            ? "installed-default"
            : "disabled",
      version: installedFacts?.version || null,
      classification: "hana-skills",
    };
  });

  const desiredPlugins = Object.fromEntries([...desired.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const normalizedWithoutDigest = {
    schemaVersion: CLAUDE_COMPATIBILITY_SCHEMA_VERSION,
    bindingId: binding.id,
    mode: binding.mode,
    provenance,
    virtualSources: [...virtualSources.values()].sort((a, b) => a.id.localeCompare(b.id)),
    packages,
    desiredPlugins,
    warnings: warnings.sort((a, b) => `${a.code}:${a.role}`.localeCompare(`${b.code}:${b.role}`)),
    precedence: PRECEDENCE,
  };
  return {
    ...normalizedWithoutDigest,
    digest: sha256(`${digestParts.sort().join("|")}|${stableJson(normalizedWithoutDigest)}`),
    generatedAt: safeNow(options.now),
  };
}

function sanitizedBridgeState(value: unknown): ClaudeCompatibilityNormalizedState {
  if (!isRecord(value)) throw new Error("Bridge state must be an object");
  const allowed = new Set([
    "schemaVersion", "bindingId", "mode", "digest", "generatedAt", "provenance",
    "virtualSources", "packages", "desiredPlugins", "warnings", "precedence",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Bridge state contains unrecognized content: ${key}`);
  }
  const serialized = stableJson(value);
  if (/(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]+|-----BEGIN|(?:password|token|api[_-]?key)\s*[:=])/i.test(serialized)) {
    throw new Error("Bridge state contains secret-bearing or executable Claude content");
  }
  if (value.schemaVersion !== CLAUDE_COMPATIBILITY_SCHEMA_VERSION) {
    throw new Error("Bridge state schema version mismatch");
  }
  if (!Array.isArray(value.virtualSources) || !Array.isArray(value.packages) || !Array.isArray(value.warnings)) {
    throw new Error("Bridge state is incomplete");
  }
  if (!Array.isArray(value.provenance) || !Array.isArray(value.precedence)) throw new Error("Bridge provenance and precedence are required");
  for (const entry of value.provenance) {
    if (!isRecord(entry)) throw new Error("Bridge provenance entry must be an object");
    assertOnlyKeys(entry, ["role", "path", "digest"], "Bridge provenance entry");
    if (!INPUT_ROLES.has(entry.role as ClaudeCompatibilityInputRole)) throw new Error("Bridge provenance role is invalid");
    if (typeof entry.path !== "string" || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest)) {
      throw new Error("Bridge provenance entry is invalid");
    }
  }
  for (const source of value.virtualSources) {
    if (!isRecord(source)) throw new Error("Bridge virtual source must be an object");
    assertOnlyKeys(source, ["id", "identity", "name", "descriptor", "promoted"], "Bridge virtual source");
    assertMarketplaceId(source.id);
    if (source.promoted !== false || source.identity !== `claude:${String(value.bindingId)}:${String(source.id)}`) {
      throw new Error("Bridge virtual source identity is invalid");
    }
    assertBridgeDescriptor(source.descriptor);
  }
  for (const pkg of value.packages) {
    if (!isRecord(pkg)) throw new Error("Bridge package must be an object");
    assertOnlyKeys(pkg, ["identity", "pluginId", "marketplaceId", "installed", "desiredEnabled", "state", "version", "classification"], "Bridge package");
    if (typeof pkg.identity !== "string" || !safeQualifiedPluginIdentity(pkg.identity)) throw new Error("Bridge package identity is invalid");
    const parsed = parsePluginMarketplaceRef(pkg.identity);
    if (pkg.pluginId !== parsed.pluginId || pkg.marketplaceId !== parsed.marketplaceId) throw new Error("Bridge package identity fields disagree");
    if (typeof pkg.installed !== "boolean" || typeof pkg.desiredEnabled !== "boolean") throw new Error("Bridge package state flags are invalid");
    if (!["enabled", "disabled", "desired-not-installed", "installed-default"].includes(String(pkg.state))) throw new Error("Bridge package state is invalid");
    if (pkg.classification !== "hana-skills" && pkg.classification !== "unsupported") throw new Error("Bridge package classification is invalid");
  }
  for (const warning of value.warnings) {
    if (!isRecord(warning)) throw new Error("Bridge warning must be an object");
    assertOnlyKeys(warning, ["code", "category", "role", "message"], "Bridge warning");
    if (typeof warning.code !== "string" || typeof warning.message !== "string" || warning.message.length > 512) {
      throw new Error("Bridge warning is invalid");
    }
    if (!INPUT_ROLES.has(warning.role as ClaudeCompatibilityInputRole)) throw new Error("Bridge warning role is invalid");
  }
  if (!isRecord(value.desiredPlugins)) throw new Error("Bridge desired state must be source-qualified");
  for (const [identity, enabled] of Object.entries(value.desiredPlugins)) {
    if (!safeQualifiedPluginIdentity(identity) || typeof enabled !== "boolean") {
      throw new Error("Bridge desired state must use exact source-qualified boolean entries");
    }
  }
  if (stableJson(value.precedence) !== stableJson(PRECEDENCE)) throw new Error("Bridge precedence contract mismatch");
  if (typeof value.bindingId !== "string" || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new Error("Bridge binding identity or digest is invalid");
  }
  if (value.mode !== "live" && value.mode !== "mirror" && value.mode !== "snapshot") throw new Error("Bridge binding mode is invalid");
  if (typeof value.generatedAt !== "string") throw new Error("Bridge generation timestamp is invalid");
  return structuredClone(value) as unknown as ClaudeCompatibilityNormalizedState;
}

export interface ClaudeCompatibilityBridgeEnvelope {
  version: typeof CLAUDE_COMPATIBILITY_BRIDGE_VERSION;
  serverBindingId: string;
  serverId: string;
  deviceId: string;
  sessionId: string;
  createdAt: string;
  state: ClaudeCompatibilityNormalizedState;
}

export function validateClaudeCompatibilityBridgeEnvelope(
  value: unknown,
  expected: { serverId: string; serverBindingId: string; deviceId?: string; sessionId?: string },
): ClaudeCompatibilityBridgeEnvelope {
  if (!isRecord(value)) throw new Error("Claude compatibility bridge envelope must be an object");
  const allowed = new Set(["version", "serverBindingId", "serverId", "deviceId", "sessionId", "createdAt", "state"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Bridge envelope contains unrecognized content: ${key}`);
  }
  if (value.version !== CLAUDE_COMPATIBILITY_BRIDGE_VERSION) throw new Error("Claude compatibility bridge version mismatch");
  if (value.serverId !== expected.serverId || value.serverBindingId !== expected.serverBindingId) {
    throw new Error("Claude compatibility bridge targets a stale or different server binding");
  }
  if (expected.deviceId && value.deviceId !== expected.deviceId) throw new Error("Claude compatibility bridge device mismatch");
  if (expected.sessionId && value.sessionId !== expected.sessionId) throw new Error("Claude compatibility bridge session mismatch");
  for (const key of ["deviceId", "sessionId", "createdAt"] as const) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`Claude compatibility bridge ${key} is required`);
  }
  return {
    version: CLAUDE_COMPATIBILITY_BRIDGE_VERSION,
    serverBindingId: assertBindingId(value.serverBindingId),
    serverId: String(value.serverId),
    deviceId: String(value.deviceId),
    sessionId: String(value.sessionId),
    createdAt: String(value.createdAt),
    state: sanitizedBridgeState(value.state),
  };
}

interface BindingRuntimeRecord {
  state: ClaudeCompatibilityNormalizedState | null;
  lastKnownGood: ClaudeCompatibilityNormalizedState | null;
  failureStartedAt: number | null;
  diagnostic: ClaudeCompatibilityStatus["diagnostic"];
  pendingBoundary: ClaudeCompatibilityStatus["pendingBoundary"];
  refreshCount: number;
  lastInputDigest: string | null;
}

export class ClaudeCompatibilityBindingService {
  declare _hanakoHome: string;
  declare _registry: PluginMarketplaceSourceRegistry;
  declare _fs: ClaudeCompatibilityFsOps;
  declare _now: () => Date;
  declare _graceMs: number;
  declare _debounceMs: number;
  declare _runtime: Map<string, BindingRuntimeRecord>;
  declare _timers: Map<string, ReturnType<typeof setTimeout>>;

  constructor(options: {
    hanakoHome: string;
    registry: PluginMarketplaceSourceRegistry;
    fsOps?: ClaudeCompatibilityFsOps;
    now?: () => Date;
    graceMs?: number;
    debounceMs?: number;
  }) {
    this._hanakoHome = options.hanakoHome;
    this._registry = options.registry;
    this._fs = options.fsOps || defaultFsOps();
    this._now = options.now || (() => new Date());
    this._graceMs = options.graceMs ?? 750;
    this._debounceMs = options.debounceMs ?? 100;
    this._runtime = new Map();
    this._timers = new Map();
  }

  listBindings(options: { redactPaths?: boolean } = {}): ClaudeCompatibilityStatus[] {
    return this._registry.getClaudeCompatibilityBindings().map((binding) => this._statusFromBinding(binding, options));
  }

  getStatus(bindingId: string, options: { redactPaths?: boolean } = {}): ClaudeCompatibilityStatus {
    const binding = this._getBinding(bindingId);
    return this._statusFromBinding(binding, options);
  }

  _statusFromBinding(
    binding: ClaudeCompatibilityBinding,
    options: { redactPaths?: boolean } = {},
  ): ClaudeCompatibilityStatus {
    const runtime = this._runtime.get(binding.id) || this._emptyRuntime();
    const visibleBinding = options.redactPaths
      ? { ...binding, inputs: binding.inputs.map((input) => ({ ...input, path: "[server-local path redacted]" })) }
      : binding;
    return {
      binding: visibleBinding,
      state: runtime.state ? this._redactState(runtime.state, options.redactPaths) : null,
      lastKnownGood: Boolean(runtime.lastKnownGood && runtime.diagnostic),
      diagnostic: runtime.diagnostic,
      pendingBoundary: runtime.pendingBoundary,
      refreshCount: runtime.refreshCount,
    };
  }

  planMutation(input: {
    action: "link" | "refresh" | "disable" | "remove" | "snapshot-import" | "promote";
    binding?: unknown;
    bindingId?: string;
    virtualSourceId?: string;
  }) {
    const registry = this._registry.getStatus();
    const facts: Record<string, unknown> = {
      action: input.action,
      revision: registry.revision,
      digest: registry.digest,
    };
    if (input.action === "link") facts.binding = validateClaudeCompatibilityBinding(input.binding);
    else {
      const bindingId = assertBindingId(input.bindingId);
      facts.bindingId = bindingId;
      if (input.action === "promote") {
        const sourceId = assertMarketplaceId(input.virtualSourceId);
        const state = this.refresh(bindingId).state;
        const source = state?.virtualSources.find((candidate) => candidate.id === sourceId);
        if (!source) throw new Error(`Virtual Claude compatibility source not found: ${sourceId}`);
        facts.virtualSourceId = sourceId;
        facts.sourceDescriptor = source.descriptor;
        facts.compatibilityDigest = state.digest;
      }
    }
    return {
      ...facts,
      planToken: sha256(stableJson(facts)),
      expiresAt: new Date(this._now().getTime() + 5 * 60_000).toISOString(),
    };
  }

  executeMutation(input: {
    action: "link" | "refresh" | "disable" | "remove" | "snapshot-import" | "promote";
    planToken: string;
    isStudioOwner?: boolean;
    binding?: unknown;
    bindingId?: string;
    virtualSourceId?: string;
  }) {
    if (!input.isStudioOwner) {
      const err = new Error("studio.owner required to mutate Claude compatibility bindings") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_FORBIDDEN";
      err.status = 403;
      throw err;
    }
    const plan = this.planMutation(input);
    if (!input.planToken || input.planToken !== plan.planToken) {
      const err = new Error("Claude compatibility plan is stale; preview the action again") as Error & { code: string; status: number };
      err.code = "PLUGIN_MARKETPLACE_CLAUDE_COMPAT_PLAN_STALE";
      err.status = 409;
      throw err;
    }
    if (input.action === "link") {
      const binding = validateClaudeCompatibilityBinding(input.binding);
      const bindings = this._registry.getClaudeCompatibilityBindings();
      if (bindings.some((candidate) => candidate.id === binding.id)) throw new Error(`Claude compatibility binding already exists: ${binding.id}`);
      this._registry.setClaudeCompatibilityBindings([...bindings, { ...binding, createdAt: safeNow(this._now), updatedAt: safeNow(this._now) }]);
      return this.refresh(binding.id);
    }
    const bindingId = assertBindingId(input.bindingId);
    if (input.action === "refresh" || input.action === "snapshot-import") return this.refresh(bindingId, { forceSnapshot: input.action === "snapshot-import" });
    if (input.action === "disable") {
      const bindings = this._registry.getClaudeCompatibilityBindings();
      this._registry.setClaudeCompatibilityBindings(bindings.map((binding) => binding.id === bindingId
        ? { ...binding, enabled: false, updatedAt: safeNow(this._now) }
        : binding));
      return this.getStatus(bindingId);
    }
    if (input.action === "remove") {
      const bindings = this._registry.getClaudeCompatibilityBindings();
      this._registry.setClaudeCompatibilityBindings(bindings.filter((binding) => binding.id !== bindingId));
      this._runtime.delete(bindingId);
      return { removed: true, bindingId };
    }
    const sourceId = assertMarketplaceId(input.virtualSourceId);
    const sourceDescriptor = (plan as Record<string, unknown>).sourceDescriptor as MarketplaceSourceDescriptor | undefined;
    if (!sourceDescriptor) throw new Error(`Virtual Claude compatibility source not found: ${sourceId}`);
    const result = this._registry.addSource(sourceDescriptor);
    return { promoted: true, bindingId, virtualSourceId: sourceId, source: result.source, revision: result.revision };
  }

  refresh(bindingId: string, options: { forceSnapshot?: boolean } = {}): ClaudeCompatibilityStatus {
    const binding = this._getBinding(bindingId);
    const runtime = this._runtime.get(binding.id) || this._emptyRuntime();
    if (!binding.enabled) return this._statusFromBinding(binding);
    if (binding.mode === "snapshot" && runtime.state && !options.forceSnapshot) return this._statusFromBinding(binding);
    try {
      const state = parseClaudeCompatibilityBinding(binding, { fsOps: this._fs, now: this._now });
      if (runtime.lastInputDigest === state.digest && runtime.state) {
        runtime.failureStartedAt = null;
        runtime.diagnostic = null;
        this._runtime.set(binding.id, runtime);
        return this._statusFromBinding(binding);
      }
      runtime.state = state;
      runtime.lastKnownGood = state;
      runtime.lastInputDigest = state.digest;
      runtime.failureStartedAt = null;
      runtime.diagnostic = null;
      runtime.pendingBoundary = "next-agent-snapshot";
      runtime.refreshCount += 1;
      this._runtime.set(binding.id, runtime);
      if (binding.mode === "mirror" || binding.mode === "snapshot") this._persistDerivedState(binding, state);
      return this._statusFromBinding(binding);
    } catch (err: any) {
      const nowMs = this._now().getTime();
      runtime.failureStartedAt ??= nowMs;
      const graceExpired = nowMs - runtime.failureStartedAt >= this._graceMs;
      runtime.state = runtime.lastKnownGood;
      runtime.diagnostic = {
        code: graceExpired ? "CLAUDE_COMPAT_INPUT_INVALID" : "CLAUDE_COMPAT_INPUT_GRACE",
        message: err?.message || String(err),
        firstFailureAt: new Date(runtime.failureStartedAt).toISOString(),
        graceExpired,
      };
      this._runtime.set(binding.id, runtime);
      return this._statusFromBinding(binding);
    }
  }

  scheduleRefresh(bindingId: string): void {
    const existing = this._timers.get(bindingId);
    if (existing) clearTimeout(existing);
    this._timers.set(bindingId, setTimeout(() => {
      this._timers.delete(bindingId);
      this.refresh(bindingId);
    }, this._debounceMs));
  }

  pollLiveBindings(): ClaudeCompatibilityStatus[] {
    const output: ClaudeCompatibilityStatus[] = [];
    for (const binding of this._registry.getClaudeCompatibilityBindings()) {
      if (binding.enabled && (binding.mode === "live" || binding.mode === "mirror")) output.push(this.refresh(binding.id));
    }
    return output;
  }

  acknowledgeAgentSnapshot(bindingId: string) {
    const runtime = this._runtime.get(assertBindingId(bindingId));
    if (runtime) runtime.pendingBoundary = null;
  }

  validateBridgeEnvelope(value: unknown, expected: Parameters<typeof validateClaudeCompatibilityBridgeEnvelope>[1]) {
    return validateClaudeCompatibilityBridgeEnvelope(value, expected);
  }

  _persistDerivedState(binding: ClaudeCompatibilityBinding, state: ClaudeCompatibilityNormalizedState) {
    const dir = path.join(this._hanakoHome, "claude-compatibility", binding.mode);
    this._fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${binding.id}.json`);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    this._fs.writeFileSync(tmp, payload, "utf8");
    this._fs.renameSync(tmp, target);
  }

  _getBinding(bindingId: unknown): ClaudeCompatibilityBinding {
    const id = assertBindingId(bindingId);
    const binding = this._registry.getClaudeCompatibilityBindings().find((candidate) => candidate.id === id);
    if (!binding) throw new Error(`Claude compatibility binding not found: ${id}`);
    return binding;
  }

  _emptyRuntime(): BindingRuntimeRecord {
    return {
      state: null,
      lastKnownGood: null,
      failureStartedAt: null,
      diagnostic: null,
      pendingBoundary: null,
      refreshCount: 0,
      lastInputDigest: null,
    };
  }

  _redactState(state: ClaudeCompatibilityNormalizedState, redact = false) {
    if (!redact) return structuredClone(state);
    return {
      ...structuredClone(state),
      provenance: state.provenance.map((entry) => ({ ...entry, path: "[server-local path redacted]" })),
      virtualSources: state.virtualSources.map((source) => ({
        ...source,
        descriptor: source.descriptor.kind === "local"
          ? { ...source.descriptor, path: "[server-local path redacted]" }
          : source.descriptor,
      })),
    };
  }
}
