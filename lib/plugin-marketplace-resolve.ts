import {
  assertMarketplaceId,
  assertPluginId,
  type MarketplacePluginId,
} from "./plugin-marketplace-identity.ts";
import { OFFICIAL_MARKETPLACE_ID as OFFICIAL_ID } from "./plugin-marketplace-sources.ts";

export const OFFICIAL_MARKETPLACE_ID = OFFICIAL_ID;

export type MarketplaceResolveMode = "qualified" | "official" | "unique";

export type MarketplaceResolveErrorCode =
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "INCOMPLETE"
  | "OFFICIAL_UNAVAILABLE";

export type MarketplaceLifecycleOperation =
  | "install"
  | "update"
  | "reinstall"
  | "uninstall"
  | "readme"
  | "switch"
  | "remove-artifact";

export interface TaggedResolveRow {
  marketplaceId: string;
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface MarketplaceResolveSourceCoverage {
  sourceId: string;
  authority: "official" | "custom" | "legacy";
  /** True when the source has a usable current or stale validated snapshot. */
  usable: boolean;
}

export type MarketplaceResolution =
  | { ok: true; row: TaggedResolveRow; mode: MarketplaceResolveMode }
  | {
      ok: false;
      code: MarketplaceResolveErrorCode;
      candidates?: MarketplacePluginId[];
      message?: string;
    };

export interface ResolveMarketplacePluginInput {
  pluginId: string;
  marketplaceId?: string | null;
  rows: TaggedResolveRow[];
  sources: MarketplaceResolveSourceCoverage[];
  /**
   * Fresh bare install uses official-wins / unique / ambiguous / incomplete rules.
   * Lifecycle ops (update/reinstall/uninstall/readme/switch/remove-artifact) require
   * exact marketplace provenance and never re-run bare resolution.
   */
  operation?: MarketplaceLifecycleOperation | "fresh-install";
}

/**
 * Pure marketplace plugin resolver. No network or persistence side effects.
 */
export function resolveMarketplacePlugin(input: ResolveMarketplacePluginInput): MarketplaceResolution {
  const pluginId = assertPluginId(input.pluginId);
  const operation = input.operation || "fresh-install";
  const lifecycle = operation !== "fresh-install" && operation !== "install";

  const usableSourceIds = new Set(
    (input.sources || [])
      .filter((s) => s && s.usable)
      .map((s) => s.sourceId),
  );

  const officialCoverage = (input.sources || []).find(
    (s) => s.sourceId === OFFICIAL_MARKETPLACE_ID || s.authority === "official",
  );
  const officialUsable = Boolean(officialCoverage?.usable);

  const usableRows = (input.rows || []).filter(
    (row) => row && row.id === pluginId && usableSourceIds.has(row.marketplaceId),
  );

  const marketplaceId = input.marketplaceId == null || input.marketplaceId === ""
    ? null
    : assertMarketplaceId(input.marketplaceId);

  if (lifecycle && !marketplaceId) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Lifecycle operations require exact marketplaceId provenance",
    };
  }

  if (marketplaceId) {
    const match = usableRows.find((row) => row.marketplaceId === marketplaceId) || null;
    if (!match) {
      return { ok: false, code: "NOT_FOUND" };
    }
    return { ok: true, mode: "qualified", row: match };
  }

  // Bare resolution — official must be usable for precedence decisions.
  if (!officialUsable) {
    return {
      ok: false,
      code: "OFFICIAL_UNAVAILABLE",
      message: "Bare resolution requires a usable official marketplace snapshot",
    };
  }

  const officialRow = usableRows.find((row) => row.marketplaceId === OFFICIAL_MARKETPLACE_ID) || null;
  if (officialRow) {
    return { ok: true, mode: "official", row: officialRow };
  }

  // Without an official match, bare resolution needs complete coverage of all
  // registered sources to prove uniqueness.
  const anyUnusable = (input.sources || []).some((s) => s && !s.usable);
  if (anyUnusable) {
    return {
      ok: false,
      code: "INCOMPLETE",
      message: "One or more marketplace sources are unavailable; pin marketplaceId",
      candidates: candidatesFrom(usableRows),
    };
  }

  if (usableRows.length === 0) {
    return { ok: false, code: "NOT_FOUND" };
  }
  if (usableRows.length === 1) {
    return { ok: true, mode: "unique", row: usableRows[0] };
  }

  return {
    ok: false,
    code: "AMBIGUOUS",
    candidates: candidatesFrom(usableRows),
    message: "Multiple marketplace sources provide this plugin id",
  };
}

function candidatesFrom(rows: TaggedResolveRow[]): MarketplacePluginId[] {
  return rows
    .map((row) => ({
      marketplaceId: row.marketplaceId,
      pluginId: row.id,
    }))
    .sort((a, b) => {
      const byMarket = a.marketplaceId.localeCompare(b.marketplaceId);
      if (byMarket !== 0) return byMarket;
      return a.pluginId.localeCompare(b.pluginId);
    });
}
