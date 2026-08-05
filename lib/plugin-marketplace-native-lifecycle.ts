import crypto from "crypto";
import fs from "fs";
import { inspectMarketplacePackage } from "./plugin-marketplace-inspector.ts";
import type { PluginMarketplaceService } from "./plugin-marketplace-service.ts";
import type { PluginTrustStore } from "./plugin-trust-store.ts";

const PLAN_SCHEMA_VERSION = 1;
const DEFAULT_PLAN_TTL_MS = 5 * 60_000;

type NativeAction = "install" | "uninstall" | "source-switch";

interface NativePlanFacts {
  schemaVersion: 1;
  action: NativeAction;
  identity: string;
  pluginId: string;
  marketplaceId: string;
  version: string;
  packageUrl: string;
  packageSha256: string;
  registryRevision: number;
  registryDigest: string;
  catalogSha256: string;
  sourceFingerprint: string;
  resolvedRevision: string | null;
  trust: string;
  contributions: string[];
  confirmationText: string;
  retainedArtifactPath: string | null;
  activeMarketplaceId: string | null;
  activeArtifactDigest: string | null;
  artifactDigest: string | null;
}

interface SignedPlanEnvelope {
  facts: NativePlanFacts;
  expiresAt: number;
  nonce: string;
}

function lifecycleError(message: string, status: number, code: string) {
  const err = new Error(message) as Error & { status: number; code: string };
  err.status = status;
  err.code = code;
  return err;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class PluginMarketplaceNativeLifecycle {
  private readonly service: PluginMarketplaceService;
  private readonly trustStore: PluginTrustStore;
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  private readonly consumed = new Map<string, number>();

  constructor(options: {
    service: PluginMarketplaceService;
    trustStore: PluginTrustStore;
    secret?: Buffer | string;
    ttlMs?: number;
  }) {
    this.service = options.service;
    this.trustStore = options.trustStore;
    this.secret = Buffer.isBuffer(options.secret)
      ? options.secret
      : Buffer.from(options.secret || crypto.randomBytes(32));
    this.ttlMs = options.ttlMs ?? DEFAULT_PLAN_TTL_MS;
  }

  planInstall(input: {
    pluginId: string;
    marketplaceId: string;
    isStudioOwner: boolean;
    expectedRevision?: number;
    expectedDigest?: string;
  }) {
    const facts = this.buildFacts("install", input);
    return this.planPayload(facts);
  }

  planUninstall(input: {
    pluginId: string;
    marketplaceId: string;
    isStudioOwner: boolean;
    expectedRevision?: number;
    expectedDigest?: string;
  }) {
    const facts = this.buildFacts("uninstall", input);
    if (facts.activeMarketplaceId !== facts.marketplaceId || facts.activeArtifactDigest !== facts.packageSha256) {
      throw lifecycleError(
        "The exact Marketplace-native identity is not actively installed",
        409,
        "PLUGIN_MARKETPLACE_ACTIVE_POINTER_MISMATCH",
      );
    }
    return this.planPayload(facts);
  }

  async executeInstall<T>(input: {
    planToken: string;
    confirmation: string;
    isStudioOwner: boolean;
  }, executor: (facts: NativePlanFacts) => Promise<T>): Promise<{ plan: NativePlanFacts; result: T }> {
    const facts = this.consumeAndValidate("install", input);
    const priorGrant = this.trustStore.getGrant(facts.marketplaceId, facts.pluginId, facts.packageSha256);
    if (facts.trust === "full-access") {
      this.trustStore.grant({
        marketplaceId: facts.marketplaceId,
        pluginId: facts.pluginId,
        artifactDigest: facts.packageSha256,
        grantedCapabilities: ["full-access"],
      });
    }
    try {
      return { plan: facts, result: await executor(facts) };
    } catch (err) {
      if (facts.trust === "full-access" && !priorGrant) {
        this.trustStore.revoke(facts.marketplaceId, facts.pluginId, facts.packageSha256);
      }
      throw err;
    }
  }

  async executeUninstall<T>(input: {
    planToken: string;
    confirmation: string;
    isStudioOwner: boolean;
  }, executor: (facts: NativePlanFacts) => Promise<T>): Promise<{ plan: NativePlanFacts; result: T }> {
    const facts = this.consumeAndValidate("uninstall", input);
    const result = await executor(facts);
    this.trustStore.revoke(facts.marketplaceId, facts.pluginId, facts.packageSha256);
    return { plan: facts, result };
  }

  planSourceSwitch(input: {
    pluginId: string;
    marketplaceId: string;
    artifactDigest?: string;
    isStudioOwner: boolean;
    expectedRevision?: number;
    expectedDigest?: string;
  }) {
    const facts = this.buildFacts("source-switch", input);
    return this.planPayload(facts);
  }

  async executeSourceSwitch<T>(input: {
    planToken: string;
    confirmation: string;
    isStudioOwner: boolean;
  }, executor: (facts: NativePlanFacts) => Promise<T>): Promise<{ plan: NativePlanFacts; result: T }> {
    const facts = this.consumeAndValidate("source-switch", input);
    return { plan: facts, result: await executor(facts) };
  }

  private buildFacts(action: NativeAction, input: {
    pluginId: string;
    marketplaceId: string;
    artifactDigest?: string;
    isStudioOwner: boolean;
    expectedRevision?: number;
    expectedDigest?: string;
  }): NativePlanFacts {
    if (!input.isStudioOwner) {
      throw lifecycleError("studio.owner required for native Marketplace lifecycle", 403, "PLUGIN_MARKETPLACE_NATIVE_OWNER_REQUIRED");
    }
    if (!Number.isInteger(input.expectedRevision) || !input.expectedDigest) {
      throw lifecycleError("Marketplace registry revision and digest are required", 409, "PLUGIN_MARKETPLACE_PRECONDITION_REQUIRED");
    }
    this.service.assertRegistryWritePrecondition({
      expectedRevision: input.expectedRevision,
      expectedDigest: input.expectedDigest,
    });
    this.service.assertRegistryUsableForAcquisition();
    const plugin = this.service.getCatalogPlugin(input.pluginId, input.marketplaceId);
    if (!plugin) throw lifecycleError("Marketplace plugin not found", 404, "PLUGIN_MARKETPLACE_NOT_FOUND");
    const inspection = inspectMarketplacePackage(plugin);
    const dist: any = plugin.distribution;
    if (action !== "source-switch") {
      if (inspection.destination !== "native-plugin" || dist?.kind !== "release" || !dist.packageUrl || !dist.sha256) {
        throw lifecycleError("Package is not a supported native Marketplace release", 409, "PLUGIN_MARKETPLACE_NATIVE_UNSUPPORTED");
      }
      if (!/^[a-f0-9]{64}$/.test(dist.sha256)) {
        throw lifecycleError("Plugin release sha256 must be 64 lowercase hex characters", 400, "PLUGIN_MARKETPLACE_SOURCE_INVALID");
      }
    }
    const registry = this.service.getRegistryStatus();
    const snapshot = this.service.snapshots.getStatus(input.marketplaceId);
    const current = snapshot.state === "ok" || snapshot.state === "stale" || snapshot.state === "refreshing"
      ? snapshot.current
      : null;
    if (!current) throw lifecycleError("Marketplace snapshot is unavailable", 409, "PLUGIN_MARKETPLACE_SOURCE_INVALID");
    const install = this.service.records.get(plugin.id);
    const retained = install?.retained?.[input.marketplaceId] || {};
    let artifactDigest: string | null = null;
    if (action === "source-switch") {
      const candidates = Object.keys(retained);
      if (candidates.length === 0) {
        throw lifecycleError("No retained artifact for the target marketplace", 409, "PLUGIN_MARKETPLACE_SOURCE_INVALID");
      }
      if (input.artifactDigest) {
        if (!candidates.includes(input.artifactDigest)) {
          throw lifecycleError("Requested artifact digest is not retained", 409, "PLUGIN_MARKETPLACE_SOURCE_INVALID");
        }
        artifactDigest = input.artifactDigest;
      } else {
        const sorted = candidates.sort((a, b) =>
          String(retained[b]?.lastActivatedAt || retained[b]?.retainedAt)
            .localeCompare(String(retained[a]?.lastActivatedAt || retained[a]?.retainedAt)),
        );
        artifactDigest = sorted[0];
      }
      const artifactPath = this.service.artifacts.get(input.marketplaceId, plugin.id, artifactDigest)?.artifactPath;
      if (!artifactPath || !fs.existsSync(artifactPath)) {
        throw lifecycleError("Retained artifact is missing on disk", 409, "PLUGIN_MARKETPLACE_SOURCE_INVALID");
      }
    }
    const activeRetained = action === "uninstall"
      ? install?.activeMarketplaceId === input.marketplaceId && install.activeArtifactDigest
        ? install.retained?.[input.marketplaceId]?.[install.activeArtifactDigest]
        : null
      : action === "source-switch" && artifactDigest
        ? install?.retained?.[input.marketplaceId]?.[artifactDigest]
        : null;
    const packageSha256 = action === "uninstall"
      ? activeRetained?.packageSha256 || install?.activeArtifactDigest || dist.sha256
      : action === "source-switch"
        ? activeRetained?.packageSha256 || artifactDigest || dist.sha256 || null
        : dist.sha256;
    const retainedArtifact = this.service.artifacts.get(input.marketplaceId, plugin.id, packageSha256);
    const retainedArtifactPath = retainedArtifact?.artifactPath && fs.existsSync(retainedArtifact.artifactPath)
      ? retainedArtifact.artifactPath
      : null;
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      action,
      identity: `${plugin.id}@${input.marketplaceId}`,
      pluginId: plugin.id,
      marketplaceId: input.marketplaceId,
      version: activeRetained?.version || plugin.version || "0.0.0",
      packageUrl: activeRetained?.packageUrl || dist.packageUrl || null,
      packageSha256,
      registryRevision: registry.revision,
      registryDigest: registry.digest,
      catalogSha256: activeRetained?.catalogSha256 || current.catalogSha256,
      sourceFingerprint: activeRetained?.sourceFingerprint || current.sourceFingerprint,
      resolvedRevision: activeRetained?.resolvedRevision || current.resolvedRevision || null,
      trust: plugin.trust || "restricted",
      contributions: Array.isArray(plugin.contributions) ? [...plugin.contributions].sort() : [],
      confirmationText: action === "source-switch"
        ? `${plugin.id}@${input.marketplaceId} source switch`
        : `${plugin.id}@${input.marketplaceId}`,
      retainedArtifactPath,
      activeMarketplaceId: install?.activeMarketplaceId || null,
      activeArtifactDigest: install?.activeArtifactDigest || null,
      artifactDigest,
    };
  }

  private planPayload(facts: NativePlanFacts) {
    this.pruneConsumedPlans();
    const envelope: SignedPlanEnvelope = {
      facts,
      expiresAt: Date.now() + this.ttlMs,
      nonce: crypto.randomUUID(),
    };
    const encoded = Buffer.from(stable(envelope)).toString("base64url");
    const signature = crypto.createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      action: facts.action,
      identity: facts.identity,
      confirmationText: facts.confirmationText,
      expiresAt: new Date(envelope.expiresAt).toISOString(),
      facts,
      planToken: `${encoded}.${signature}`,
    };
  }

  private consumeAndValidate(action: NativeAction, input: {
    planToken: string;
    confirmation: string;
    isStudioOwner: boolean;
  }): NativePlanFacts {
    if (!input.isStudioOwner) throw lifecycleError("studio.owner required", 403, "PLUGIN_MARKETPLACE_NATIVE_OWNER_REQUIRED");
    this.pruneConsumedPlans();
    if (!input.planToken || this.consumed.has(input.planToken)) {
      throw lifecycleError("Native lifecycle plan token is missing or already used", 409, "PLUGIN_MARKETPLACE_PLAN_INVALID");
    }
    const [encoded, signature] = input.planToken.split(".");
    const expected = crypto.createHmac("sha256", this.secret).update(encoded || "").digest("base64url");
    if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw lifecycleError("Native lifecycle plan token is invalid", 409, "PLUGIN_MARKETPLACE_PLAN_INVALID");
    }
    let envelope: SignedPlanEnvelope;
    try { envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
    catch { throw lifecycleError("Native lifecycle plan token is invalid", 409, "PLUGIN_MARKETPLACE_PLAN_INVALID"); }
    if (envelope.expiresAt <= Date.now() || envelope.facts.action !== action) {
      throw lifecycleError("Native lifecycle plan is expired or has the wrong action", 409, "PLUGIN_MARKETPLACE_PLAN_STALE");
    }
    if (input.confirmation !== envelope.facts.confirmationText) {
      throw lifecycleError("Typed confirmation does not match the exact Marketplace identity", 409, "PLUGIN_MARKETPLACE_CONFIRMATION_MISMATCH");
    }
    const current = this.buildFacts(action, {
      pluginId: envelope.facts.pluginId,
      marketplaceId: envelope.facts.marketplaceId,
      isStudioOwner: true,
      expectedRevision: envelope.facts.registryRevision,
      expectedDigest: envelope.facts.registryDigest,
      artifactDigest: envelope.facts.artifactDigest ?? undefined,
    });
    if (stable(current) !== stable(envelope.facts)) {
      throw lifecycleError("Native lifecycle plan is stale", 409, "PLUGIN_MARKETPLACE_PLAN_STALE");
    }
    if (action === "uninstall" && (current.activeMarketplaceId !== current.marketplaceId || current.activeArtifactDigest !== current.packageSha256)) {
      throw lifecycleError("Active Marketplace identity changed", 409, "PLUGIN_MARKETPLACE_ACTIVE_POINTER_MISMATCH");
    }
    this.consumed.set(input.planToken, envelope.expiresAt);
    return current;
  }

  private pruneConsumedPlans() {
    const now = Date.now();
    for (const [token, expiresAt] of this.consumed) {
      if (expiresAt <= now) this.consumed.delete(token);
    }
  }
}
