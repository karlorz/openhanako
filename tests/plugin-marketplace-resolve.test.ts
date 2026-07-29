import { describe, expect, it } from "vitest";
import {
  OFFICIAL_MARKETPLACE_ID,
  resolveMarketplacePlugin,
  type MarketplaceResolveSourceCoverage,
  type TaggedResolveRow,
} from "../lib/plugin-marketplace-resolve.ts";

function row(marketplaceId: string, pluginId: string): TaggedResolveRow {
  return {
    marketplaceId,
    id: pluginId,
    name: pluginId,
  };
}

function coverage(partial: Partial<MarketplaceResolveSourceCoverage> & { sourceId: string }): MarketplaceResolveSourceCoverage {
  return {
    authority: "custom",
    usable: true,
    ...partial,
  };
}

describe("resolveMarketplacePlugin", () => {
  it("resolves exact qualified requests and never falls back across sources", () => {
    const rows = [
      row(OFFICIAL_MARKETPLACE_ID, "demo"),
      row("team-plugins", "demo"),
    ];
    const sources = [
      coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: true }),
      coverage({ sourceId: "team-plugins", usable: true }),
    ];

    const hit = resolveMarketplacePlugin({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      rows,
      sources,
    });
    expect(hit).toEqual({
      ok: true,
      mode: "qualified",
      row: rows[1],
    });

    const miss = resolveMarketplacePlugin({
      pluginId: "demo",
      marketplaceId: "missing-source",
      rows,
      sources,
    });
    expect(miss).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // Qualified never falls back to official when team row is absent for another id.
    const noFallback = resolveMarketplacePlugin({
      pluginId: "other",
      marketplaceId: "team-plugins",
      rows,
      sources,
    });
    expect(noFallback).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("uses official-wins for fresh bare installs even if a custom source is unavailable", () => {
    const rows = [
      row(OFFICIAL_MARKETPLACE_ID, "demo"),
      row("team-plugins", "demo"),
    ];
    const sources = [
      coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: true }),
      coverage({ sourceId: "team-plugins", usable: false }),
    ];
    const result = resolveMarketplacePlugin({
      pluginId: "demo",
      rows,
      sources,
    });
    expect(result).toEqual({
      ok: true,
      mode: "official",
      row: rows[0],
    });
  });

  it("resolves a unique custom match when official has no row and coverage is complete", () => {
    const rows = [row("team-plugins", "demo")];
    const sources = [
      coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: true }),
      coverage({ sourceId: "team-plugins", usable: true }),
    ];
    const result = resolveMarketplacePlugin({
      pluginId: "demo",
      rows,
      sources,
    });
    expect(result).toEqual({
      ok: true,
      mode: "unique",
      row: rows[0],
    });
  });

  it("returns AMBIGUOUS when multiple non-official rows match and coverage is complete", () => {
    const rows = [
      row("team-plugins", "demo"),
      row("other-plugins", "demo"),
    ];
    const sources = [
      coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: true }),
      coverage({ sourceId: "team-plugins", usable: true }),
      coverage({ sourceId: "other-plugins", usable: true }),
    ];
    const result = resolveMarketplacePlugin({
      pluginId: "demo",
      rows,
      sources,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AMBIGUOUS");
      expect(result.candidates).toEqual([
        { marketplaceId: "other-plugins", pluginId: "demo" },
        { marketplaceId: "team-plugins", pluginId: "demo" },
      ]);
    }
  });

  it("returns INCOMPLETE instead of accidental uniqueness when a custom source is unavailable", () => {
    const rows = [row("team-plugins", "demo")];
    const sources = [
      coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: true }),
      coverage({ sourceId: "team-plugins", usable: true }),
      coverage({ sourceId: "offline-plugins", usable: false }),
    ];
    const result = resolveMarketplacePlugin({
      pluginId: "demo",
      rows,
      sources,
    });
    expect(result).toMatchObject({ ok: false, code: "INCOMPLETE" });
  });

  it("returns OFFICIAL_UNAVAILABLE for bare resolve when official has no usable snapshot", () => {
    const rows = [row("team-plugins", "demo")];
    const sources = [
      coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: false }),
      coverage({ sourceId: "team-plugins", usable: true }),
    ];
    const result = resolveMarketplacePlugin({
      pluginId: "demo",
      rows,
      sources,
    });
    expect(result).toMatchObject({ ok: false, code: "OFFICIAL_UNAVAILABLE" });

    // Qualified still works when official is down.
    const qualified = resolveMarketplacePlugin({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      rows,
      sources,
    });
    expect(qualified).toMatchObject({ ok: true, mode: "qualified" });
  });

  it("requires exact marketplace provenance for lifecycle operations", () => {
    const rows = [
      row(OFFICIAL_MARKETPLACE_ID, "demo"),
      row("team-plugins", "demo"),
    ];
    const sources = [
      coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: true }),
      coverage({ sourceId: "team-plugins", usable: true }),
    ];

    const lifecycle = resolveMarketplacePlugin({
      pluginId: "demo",
      marketplaceId: "team-plugins",
      rows,
      sources,
      operation: "update",
    });
    expect(lifecycle).toMatchObject({ ok: true, mode: "qualified" });

    const bareLifecycle = resolveMarketplacePlugin({
      pluginId: "demo",
      rows,
      sources,
      operation: "update",
    });
    expect(bareLifecycle).toMatchObject({ ok: false, code: "NOT_FOUND" });
    if (!bareLifecycle.ok) {
      expect(bareLifecycle.message).toMatch(/provenance|marketplaceId/i);
    }
  });

  it("ignores unusable source rows for matching and reports INCOMPLETE when coverage is partial", () => {
    // Rows from unusable sources must not participate in matching. When any
    // registered source is unusable and there is no official match, bare
    // resolution is INCOMPLETE rather than accidentally unique.
    const rows = [
      row("team-plugins", "demo"),
      row("stale-plugins", "demo"),
    ];
    const sources = [
      coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: true }),
      coverage({ sourceId: "team-plugins", usable: true }),
      coverage({ sourceId: "stale-plugins", usable: false }),
    ];
    const result = resolveMarketplacePlugin({
      pluginId: "demo",
      rows,
      sources,
    });
    expect(result).toMatchObject({ ok: false, code: "INCOMPLETE" });

    // With complete coverage and only the usable team row present, unique wins.
    const complete = resolveMarketplacePlugin({
      pluginId: "demo",
      rows: [rows[0]],
      sources: [
        coverage({ sourceId: OFFICIAL_MARKETPLACE_ID, authority: "official", usable: true }),
        coverage({ sourceId: "team-plugins", usable: true }),
      ],
    });
    expect(complete).toEqual({
      ok: true,
      mode: "unique",
      row: rows[0],
    });
  });
});
