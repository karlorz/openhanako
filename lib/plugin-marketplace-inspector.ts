export type MarketplacePackageDestination = "native-plugin" | "hana-skills" | "unsupported";
export type MarketplaceInstallAdapter = "plugin-manager" | "skill-manager" | "none";
export type MarketplaceConfirmationLevel = "inline" | "capability-review" | "typed-exact";

export interface MarketplaceCapabilityInventory {
  skills: string[];
  nativePluginContributions: string[];
  agentFacing: string[];
  serverImpact: string[];
  /** Filled after package materialize; empty at catalog list time. */
  unsupportedClaudeComponents: string[];
}

export interface MarketplacePackageInspection {
  destination: MarketplacePackageDestination;
  installAdapter: MarketplaceInstallAdapter;
  installable: boolean;
  capabilityInventory: MarketplaceCapabilityInventory;
  warnings: string[];
  confirmationLevel: MarketplaceConfirmationLevel;
}

export interface MarketplaceInstallPlan {
  action: "install";
  destination: MarketplacePackageDestination;
  installAdapter: MarketplaceInstallAdapter;
  confirmationLevel: MarketplaceConfirmationLevel;
  warnings: string[];
  installable: boolean;
}

const AGENT_FACING_CONTRIBUTIONS = new Set([
  "tools",
  "commands",
  "skills",
  "agents",
  "pages",
  "widgets",
  "settingsTabs",
  "cards",
]);

const SERVER_IMPACTING_CONTRIBUTIONS = new Set([
  "routes",
  "providers",
  "extensions",
  "lifecycle",
]);

const DESTINATION_ADAPTER: Record<MarketplacePackageDestination, MarketplaceInstallAdapter> = {
  "native-plugin": "plugin-manager",
  "hana-skills": "skill-manager",
  unsupported: "none",
};

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean))];
}

function emptyCapabilityInventory(
  overrides: Partial<MarketplaceCapabilityInventory> = {},
): MarketplaceCapabilityInventory {
  return {
    skills: [],
    nativePluginContributions: [],
    agentFacing: [],
    serverImpact: [],
    unsupportedClaudeComponents: [],
    ...overrides,
  };
}

function inspectionFor(
  destination: MarketplacePackageDestination,
  options: {
    installable: boolean;
    warnings: string[];
    confirmationLevel: MarketplaceConfirmationLevel;
    capabilityInventory?: MarketplaceCapabilityInventory;
  },
): MarketplacePackageInspection {
  return {
    destination,
    installAdapter: DESTINATION_ADAPTER[destination],
    installable: options.installable,
    capabilityInventory: options.capabilityInventory || emptyCapabilityInventory(),
    warnings: options.warnings,
    confirmationLevel: options.confirmationLevel,
  };
}

function inspectNativePackage(plugin: any): MarketplacePackageInspection {
  const contributions = uniqueStrings(plugin?.contributions);
  const serverImpact = contributions.filter((item) => SERVER_IMPACTING_CONTRIBUTIONS.has(item));
  const agentFacing = contributions.filter((item) => AGENT_FACING_CONTRIBUTIONS.has(item));
  const warnings: string[] = [];
  if (plugin?.trust === "full-access") {
    warnings.push("native plugin requests full-access review");
  }
  if (serverImpact.length > 0) {
    warnings.push(`native plugin has server-impacting contributions: ${serverImpact.join(", ")}`);
  }
  return inspectionFor("native-plugin", {
    installable: true,
    warnings,
    confirmationLevel: warnings.length > 0 ? "typed-exact" : "capability-review",
    capabilityInventory: emptyCapabilityInventory({
      nativePluginContributions: contributions,
      agentFacing,
      serverImpact,
    }),
  });
}

/**
 * Catalog-time Claude classification uses source eligibility only.
 * Unsupported component/dependency warnings require package files and are produced by
 * inspectClaudePackageWarnings during materialize/install.
 */
function inspectClaudePackage(plugin: any, installMeta: Record<string, unknown>): MarketplacePackageInspection {
  const sourceKind = typeof installMeta.sourceKind === "string" ? installMeta.sourceKind : "unsupported";
  // Trust catalog canInstall when present; still require relative source for v1 skills-lane.
  const canInstall = installMeta.canInstall === true && sourceKind === "relative";
  const warnings = canInstall
    ? []
    : [`Claude package source kind is not installable in Hana v1: ${sourceKind}`];
  return inspectionFor(canInstall ? "hana-skills" : "unsupported", {
    installable: canInstall,
    warnings,
    confirmationLevel: canInstall ? "inline" : "capability-review",
    capabilityInventory: emptyCapabilityInventory({
      // Skill names are unknown until package materialize; list package id as a coarse label.
      skills: canInstall ? [String(plugin?.id || plugin?.name || "unknown")] : [],
      agentFacing: canInstall ? ["skills"] : [],
    }),
  });
}

export function inspectMarketplacePackage(plugin: any): MarketplacePackageInspection {
  const installMeta = plugin?.install && typeof plugin.install === "object"
    ? plugin.install as Record<string, unknown>
    : {};
  if (installMeta.catalogFormat === "claude") {
    return inspectClaudePackage(plugin, installMeta);
  }
  const distribution = plugin?.distribution && typeof plugin.distribution === "object"
    ? plugin.distribution
    : null;
  if (distribution?.kind === "release" && distribution?.packageUrl) {
    return inspectNativePackage(plugin);
  }
  return inspectionFor("unsupported", {
    installable: false,
    warnings: ["marketplace package has no supported Hana install adapter"],
    confirmationLevel: "inline",
    capabilityInventory: emptyCapabilityInventory({
      nativePluginContributions: uniqueStrings(plugin?.contributions),
    }),
  });
}

export function createMarketplaceInstallPlan(inspection: MarketplacePackageInspection): MarketplaceInstallPlan {
  return {
    action: "install",
    destination: inspection.destination,
    installAdapter: inspection.installAdapter,
    confirmationLevel: inspection.confirmationLevel,
    warnings: inspection.warnings.slice(),
    installable: inspection.installable,
  };
}
