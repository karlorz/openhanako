import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_DIGEST_HEX_LENGTH,
  MAX_MARKETPLACE_ID_LENGTH,
  MAX_PLUGIN_ID_LENGTH,
  assertMarketplaceId,
  assertPluginId,
  buildMarketplacePluginKey,
  buildMarketplaceStatePathSegments,
  buildPluginArtifactKey,
  buildPluginMarketplaceRef,
  buildSourceFingerprint,
  isMarketplaceId,
  isPluginId,
  marketplacePluginIdsEqual,
  parsePluginMarketplaceRef,
} from "../lib/plugin-marketplace-identity.ts";

describe("marketplace and plugin ID grammar", () => {
  it("accepts bounded ASCII identifiers", () => {
    expect(isMarketplaceId("oh-plugins-official")).toBe(true);
    expect(isMarketplaceId("team_plugins")).toBe(true);
    expect(isMarketplaceId("a")).toBe(true);
    expect(isPluginId("demo-plugin")).toBe(true);
    expect(isPluginId("x1")).toBe(true);
    expect(assertMarketplaceId("team-plugins")).toBe("team-plugins");
    expect(assertPluginId("my_plugin")).toBe("my_plugin");
  });

  it("rejects separators, path segments, whitespace, controls, and overlong IDs", () => {
    const invalid = [
      "",
      "has space",
      "has@at",
      "has:colon",
      "has/slash",
      "has\\backslash",
      ".",
      "..",
      ".hidden",
      "trailing.",
      "bad..dot",
      "emoji😀",
      "控制",
      "\nnewline",
      "a".repeat(MAX_MARKETPLACE_ID_LENGTH + 1),
    ];
    for (const value of invalid) {
      expect(isMarketplaceId(value)).toBe(false);
      expect(isPluginId(value)).toBe(false);
      expect(() => assertMarketplaceId(value)).toThrow(/marketplace id/i);
      expect(() => assertPluginId(value)).toThrow(/plugin id/i);
    }
  });

  it("rejects overlong plugin IDs independently of marketplace length", () => {
    expect(isPluginId("p".repeat(MAX_PLUGIN_ID_LENGTH))).toBe(true);
    expect(isPluginId("p".repeat(MAX_PLUGIN_ID_LENGTH + 1))).toBe(false);
  });
});

describe("pluginId@marketplaceId boundary parser", () => {
  it("parses a single trailing marketplace qualifier exactly", () => {
    expect(parsePluginMarketplaceRef("demo@oh-plugins-official")).toEqual({
      marketplaceId: "oh-plugins-official",
      pluginId: "demo",
    });
  });

  it("never truncates multiple @ separators or falls back to bare-name matching", () => {
    expect(() => parsePluginMarketplaceRef("a@b@c")).toThrow(/exactly one '@'/i);
    expect(() => parsePluginMarketplaceRef("demo@@official")).toThrow();
    expect(() => parsePluginMarketplaceRef("@official")).toThrow();
    expect(() => parsePluginMarketplaceRef("demo@")).toThrow();
    expect(() => parsePluginMarketplaceRef("demo")).toThrow(/requires marketplace qualifier/i);
    expect(() => parsePluginMarketplaceRef("demo@bad id")).toThrow(/marketplace id/i);
    expect(() => parsePluginMarketplaceRef("bad id@official")).toThrow(/plugin id/i);
  });

  it("round-trips qualified refs without ambiguity", () => {
    const ref = { marketplaceId: "team-plugins", pluginId: "demo" };
    const encoded = buildPluginMarketplaceRef(ref);
    expect(encoded).toBe("demo@team-plugins");
    expect(parsePluginMarketplaceRef(encoded)).toEqual(ref);
  });
});

describe("composite keys and exact matching", () => {
  it("builds distinct catalog/state/artifact keys for the same bare plugin ID from two sources", () => {
    const a = { marketplaceId: "oh-plugins-official", pluginId: "demo" };
    const b = { marketplaceId: "team-plugins", pluginId: "demo" };

    expect(buildMarketplacePluginKey(a)).toBe("oh-plugins-official:demo");
    expect(buildMarketplacePluginKey(b)).toBe("team-plugins:demo");
    expect(buildMarketplacePluginKey(a)).not.toBe(buildMarketplacePluginKey(b));

    expect(buildMarketplaceStatePathSegments(a)).toEqual(["oh-plugins-official", "demo"]);
    expect(buildMarketplaceStatePathSegments(b)).toEqual(["team-plugins", "demo"]);
    expect(buildMarketplaceStatePathSegments(a)).not.toEqual(buildMarketplaceStatePathSegments(b));

    const digest = "a".repeat(ARTIFACT_DIGEST_HEX_LENGTH);
    expect(buildPluginArtifactKey({ ...a, artifactDigest: digest })).toBe(
      `oh-plugins-official:demo:${digest}`,
    );
    expect(buildPluginArtifactKey({ ...b, artifactDigest: digest })).toBe(
      `team-plugins:demo:${digest}`,
    );
    expect(buildPluginArtifactKey({ ...a, artifactDigest: digest })).not.toBe(
      buildPluginArtifactKey({ ...b, artifactDigest: digest }),
    );
  });

  it("matches composite IDs exactly and never by bare plugin name alone", () => {
    const a = { marketplaceId: "oh-plugins-official", pluginId: "demo" };
    const b = { marketplaceId: "team-plugins", pluginId: "demo" };
    const c = { marketplaceId: "oh-plugins-official", pluginId: "demo" };

    expect(marketplacePluginIdsEqual(a, c)).toBe(true);
    expect(marketplacePluginIdsEqual(a, b)).toBe(false);
    expect(marketplacePluginIdsEqual(a, { marketplaceId: "oh-plugins-official", pluginId: "other" })).toBe(false);
  });

  it("rejects invalid artifact digests when building artifact keys", () => {
    expect(() =>
      buildPluginArtifactKey({
        marketplaceId: "team-plugins",
        pluginId: "demo",
        artifactDigest: "not-hex",
      }),
    ).toThrow(/artifact digest/i);
    expect(() =>
      buildPluginArtifactKey({
        marketplaceId: "team-plugins",
        pluginId: "demo",
        artifactDigest: "A".repeat(ARTIFACT_DIGEST_HEX_LENGTH),
      }),
    ).toThrow(/artifact digest/i);
  });
});

describe("canonical source fingerprint", () => {
  it("hashes the canonical source tuple and is stable for equivalent descriptors", () => {
    const urlA = {
      kind: "url" as const,
      id: "team-plugins",
      url: "https://example.com/marketplace.json",
    };
    const urlB = {
      kind: "url" as const,
      id: "team-plugins",
      url: "https://example.com/marketplace.json",
    };
    const git = {
      kind: "git" as const,
      id: "team-plugins",
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
      indexPath: "marketplace.json",
    };
    const local = {
      kind: "local" as const,
      id: "local-dev",
      path: "/var/hana/plugin-marketplaces-local/dev",
      indexPath: "marketplace.json",
    };

    const fpA = buildSourceFingerprint(urlA);
    const fpB = buildSourceFingerprint(urlB);
    expect(fpA).toBe(fpB);
    expect(fpA).toMatch(/^[a-f0-9]{64}$/);

    // Expected canonical form: kind + identity-bearing fields only, stable order.
    const expectedUrl = createHash("sha256")
      .update(JSON.stringify({
        kind: "url",
        id: "team-plugins",
        url: "https://example.com/marketplace.json",
      }))
      .digest("hex");
    expect(fpA).toBe(expectedUrl);

    const fpGit = buildSourceFingerprint(git);
    const expectedGit = createHash("sha256")
      .update(JSON.stringify({
        kind: "git",
        id: "team-plugins",
        gitUrl: "https://github.com/example/team-plugins.git",
        gitRef: "refs/heads/main",
        indexPath: "marketplace.json",
      }))
      .digest("hex");
    expect(fpGit).toBe(expectedGit);

    const fpLocal = buildSourceFingerprint(local);
    expect(fpLocal).toMatch(/^[a-f0-9]{64}$/);
    expect(fpLocal).not.toBe(fpA);
    expect(fpLocal).not.toBe(fpGit);
  });

  it("treats default indexPath as marketplace.json for fingerprint stability", () => {
    const withDefault = buildSourceFingerprint({
      kind: "git",
      id: "team-plugins",
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
    });
    const explicit = buildSourceFingerprint({
      kind: "git",
      id: "team-plugins",
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
      indexPath: "marketplace.json",
    });
    expect(withDefault).toBe(explicit);
  });

  it("changes fingerprint when source identity-bearing fields change", () => {
    const base = buildSourceFingerprint({
      kind: "url",
      id: "team-plugins",
      url: "https://example.com/marketplace.json",
    });
    const otherUrl = buildSourceFingerprint({
      kind: "url",
      id: "team-plugins",
      url: "https://example.com/other.json",
    });
    const otherId = buildSourceFingerprint({
      kind: "url",
      id: "other-plugins",
      url: "https://example.com/marketplace.json",
    });
    expect(otherUrl).not.toBe(base);
    expect(otherId).not.toBe(base);
  });
});
