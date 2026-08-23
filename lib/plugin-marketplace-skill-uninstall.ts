import type { PluginMarketplaceService } from "./plugin-marketplace-service.ts";
import { buildPluginMarketplaceRef } from "./plugin-marketplace-identity.ts";
import { removeSkillsFromBundles } from "./skill-bundles/store.ts";
import { removeAgentSkillReferences } from "./skills/remove-skill-references.ts";
import { refreshMarketplaceSkillRuntime } from "./plugin-marketplace-skill-runtime.ts";

export async function uninstallMarketplaceSkillPackage(options: {
  engine: any;
  service: PluginMarketplaceService;
  pluginId: string;
  marketplaceId: string;
  userSkillsDir: string;
  isStudioOwner: boolean;
  expectedRevision?: number;
  expectedDigest?: string;
  emitSkillsChanged?: () => void;
}) {
  const result = options.service.uninstallClaudePluginSkills(
    options.pluginId,
    options.marketplaceId,
    {
      userSkillsDir: options.userSkillsDir,
      isStudioOwner: options.isStudioOwner,
      expectedRevision: options.expectedRevision,
      expectedDigest: options.expectedDigest,
    },
  );
  const handled = [...result.deleted, ...result.alreadyMissing];
  const marketplacePackageIdentity = result.complete
    ? buildPluginMarketplaceRef({
      pluginId: options.pluginId,
      marketplaceId: options.marketplaceId,
    })
    : undefined;
  const referenceCleanup = options.engine.agentsDir
    ? removeAgentSkillReferences(options.engine.agentsDir, handled, {
        // A complete uninstall removes the package-owned preference state and
        // completion ledger. A partial uninstall deliberately passes no
        // package identity, retaining both maps until package removal is real.
        marketplacePackageIdentity,
        agents: options.engine.agents?.values?.(),
      })
    : { updatedAgents: [], failedAgents: [] };

  let bundleCleanupError: string | null = null;
  if (options.engine.hanakoHome && handled.length > 0) {
    try {
      removeSkillsFromBundles(options.engine, handled);
    } catch (err: any) {
      bundleCleanupError = err?.message || String(err);
    }
  }

  const { reloadError } = await refreshMarketplaceSkillRuntime(options.engine, {
    emitSkillsChanged: options.emitSkillsChanged,
  });

  const ok = result.complete
    && !result.activationCleanupError
    && referenceCleanup.failedAgents.length === 0
    && !bundleCleanupError
    && !reloadError;
  return {
    ok,
    ...result,
    referenceCleanup,
    bundleCleanupError,
    reloadError,
  };
}
