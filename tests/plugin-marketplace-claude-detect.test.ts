import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isClaudeMarketplaceCatalog,
  listMarketplaceIndexCandidates,
  normalizeGitMarketplaceUrl,
  parseMarketplaceCatalogAuto,
  CLAUDE_MARKETPLACE_INDEX_PATH,
  DEFAULT_MARKETPLACE_INDEX_PATH,
} from "../lib/plugin-marketplace-detect.ts";
import { parseMarketplaceCatalogStrict } from "../lib/plugin-marketplace-schema.ts";
import { acquireGitMarketplaceSnapshot } from "../lib/plugin-marketplace-git-cache.ts";
import { MarketplaceSnapshotStore } from "../lib/plugin-marketplace-snapshots.ts";
import { PluginMarketplaceService } from "../lib/plugin-marketplace-service.ts";
import { acquireAndPublishSourceSnapshot } from "../lib/plugin-marketplace-adapters.ts";

const LLM_WIKI_CLAUDE_CATALOG = {
  name: "llm-wiki",
  owner: {
    name: "karlorz",
    url: "https://github.com/karlorz",
  },
  metadata: {
    description: "Single-plugin marketplace for skillwiki — project-aware Karpathy-style knowledge base for Claude Code.",
    version: "0.10.22",
  },
  plugins: [
    {
      name: "skillwiki",
      description: "19 prompt-only skills (wiki-*, proj-*, using-skillwiki) backed by the deterministic skillwiki CLI.",
      version: "0.10.22",
      source: "./packages/skills",
      strict: true,
      author: {
        name: "karlorz",
        url: "https://github.com/karlorz",
      },
      homepage: "https://github.com/karlorz/llm-wiki",
      repository: "https://github.com/karlorz/llm-wiki",
      license: "MIT",
      keywords: ["knowledge-base", "wiki", "obsidian", "claude-code", "skills", "karpathy"],
    },
    {
      name: "vault-sync",
      description: "6 skills for cross-platform vault sync.",
      version: "0.10.22",
      source: "./packages/vault-sync",
      strict: true,
      author: {
        name: "karlorz",
        url: "https://github.com/karlorz",
      },
      homepage: "https://github.com/karlorz/llm-wiki",
      repository: "https://github.com/karlorz/llm-wiki",
      license: "MIT",
      keywords: ["vault", "sync", "rclone"],
    },
  ],
};

const HANA_CATALOG = {
  schemaVersion: 1,
  plugins: [{
    schemaVersion: 1,
    id: "demo",
    name: "Demo",
    publisher: "Hana",
    version: "1.0.0",
    description: "Demo",
    repository: "https://example.com/demo",
    compatibility: {},
    trust: "restricted",
    permissions: [],
    contributions: [],
    distribution: {
      kind: "release",
      packageUrl: "https://example.com/demo.zip",
      sha256: "a".repeat(64),
    },
  }],
};

const tempDirs: string[] = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-claude-mkt-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("normalizeGitMarketplaceUrl", () => {
  it("normalizes bare GitHub repo URLs with and without .git", () => {
    const a = normalizeGitMarketplaceUrl("https://github.com/karlorz/llm-wiki");
    expect(a.gitUrl).toBe("https://github.com/karlorz/llm-wiki.git");
    expect(a.suggestedId).toBe("llm-wiki");
    expect(a.suggestedIndexPath).toBeUndefined();

    const b = normalizeGitMarketplaceUrl("https://github.com/karlorz/llm-wiki.git");
    expect(b.gitUrl).toBe("https://github.com/karlorz/llm-wiki.git");
    expect(b.suggestedId).toBe("llm-wiki");
  });

  it("extracts ref and Claude index path from /tree/<ref>/.claude-plugin URLs", () => {
    const n = normalizeGitMarketplaceUrl(
      "https://github.com/karlorz/llm-wiki/tree/main/.claude-plugin",
    );
    expect(n.gitUrl).toBe("https://github.com/karlorz/llm-wiki.git");
    expect(n.gitRef).toBe("refs/heads/main");
    expect(n.suggestedIndexPath).toBe(CLAUDE_MARKETPLACE_INDEX_PATH);
    expect(n.suggestedId).toBe("llm-wiki");
  });

  it("extracts index file from blob path pointing at marketplace.json", () => {
    const n = normalizeGitMarketplaceUrl(
      "https://github.com/karlorz/llm-wiki/blob/main/.claude-plugin/marketplace.json",
    );
    expect(n.gitUrl).toBe("https://github.com/karlorz/llm-wiki.git");
    expect(n.gitRef).toBe("refs/heads/main");
    expect(n.suggestedIndexPath).toBe(CLAUDE_MARKETPLACE_INDEX_PATH);
  });
});

describe("listMarketplaceIndexCandidates", () => {
  it("tries default marketplace.json then Claude path when only Claude index exists", () => {
    const candidates = listMarketplaceIndexCandidates(undefined);
    expect(candidates[0]).toBe(DEFAULT_MARKETPLACE_INDEX_PATH);
    expect(candidates).toContain(CLAUDE_MARKETPLACE_INDEX_PATH);
  });

  it("keeps an explicit non-default indexPath first", () => {
    const candidates = listMarketplaceIndexCandidates(".claude-plugin/marketplace.json");
    expect(candidates[0]).toBe(CLAUDE_MARKETPLACE_INDEX_PATH);
  });
});

describe("Claude marketplace catalog parse", () => {
  it("detects Claude-shaped catalog and maps skillwiki + vault-sync to tagged rows", () => {
    expect(isClaudeMarketplaceCatalog(LLM_WIKI_CLAUDE_CATALOG)).toBe(true);
    expect(isClaudeMarketplaceCatalog(HANA_CATALOG)).toBe(false);

    const parsed = parseMarketplaceCatalogAuto(JSON.stringify(LLM_WIKI_CLAUDE_CATALOG), {
      marketplaceId: "llm-wiki",
      sourceKind: "git",
    });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.plugins).toHaveLength(2);
    const ids = parsed.plugins.map((p) => p.id).sort();
    expect(ids).toEqual(["skillwiki", "vault-sync"]);
    const skillwiki = parsed.plugins.find((p) => p.id === "skillwiki")!;
    expect(skillwiki.marketplaceId).toBe("llm-wiki");
    expect(skillwiki.name).toBe("skillwiki");
    expect(skillwiki.publisher).toBe("karlorz");
    expect(skillwiki.version).toBe("0.10.22");
    expect(skillwiki.license).toBe("MIT");
    // Not a Hana release zip; skills-lane install when relative
    expect(skillwiki.distribution).toBeNull();
    expect(skillwiki.install).toMatchObject({
      catalogFormat: "claude",
      source: "packages/skills",
      sourceKind: "relative",
      installTarget: "hana-skills",
      canInstall: true,
    });
  });

  it("marks object sources non-installable in v1", () => {
    const catalog = {
      name: "sample",
      owner: { name: "org" },
      plugins: [{
        name: "remote-plugin",
        source: {
          source: "git-subdir",
          url: "https://github.com/example/plugins.git",
          path: "plugins/foo",
          ref: "main",
        },
      }],
    };
    const parsed = parseMarketplaceCatalogAuto(JSON.stringify(catalog), {
      marketplaceId: "sample",
      sourceKind: "git",
    });
    expect(parsed.plugins[0].install).toMatchObject({
      catalogFormat: "claude",
      sourceKind: "git-subdir",
      canInstall: false,
      installTarget: "unsupported",
    });
  });

  it("keeps Hana schemaVersion:1 catalogs on the strict path", () => {
    const strict = parseMarketplaceCatalogStrict(HANA_CATALOG, {
      marketplaceId: "team",
      sourceKind: "url",
    });
    const auto = parseMarketplaceCatalogAuto(JSON.stringify(HANA_CATALOG), {
      marketplaceId: "team",
      sourceKind: "url",
    });
    expect(auto.plugins[0].id).toBe("demo");
    expect(auto.plugins[0].distribution).toEqual(strict.plugins[0].distribution);
    expect(auto.catalogSha256).toBe(strict.catalogSha256);
  });
});

describe("git acquire with Claude auto-detect", () => {
  it("loads Claude catalog when only .claude-plugin/marketplace.json exists", async () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const claudeText = JSON.stringify(LLM_WIKI_CLAUDE_CATALOG);
    const hanaText = JSON.stringify(HANA_CATALOG);

    const blobs = new Map<string, string>([
      [".claude-plugin/marketplace.json", claudeText],
      // root marketplace.json intentionally absent
    ]);

    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(dest, { recursive: true });
        return "";
      }
      if (args.includes("rev-parse")) return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      if (args.includes("show")) {
        const spec = args[args.length - 1] as string;
        const blobPath = spec.replace(/^HEAD:/, "");
        if (blobs.has(blobPath)) return blobs.get(blobPath)!;
        throw new Error(`path not in tree: ${blobPath}`);
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const snapshot = await acquireGitMarketplaceSnapshot(
      {
        id: "llm-wiki",
        kind: "git",
        gitUrl: "https://github.com/karlorz/llm-wiki",
        gitRef: "refs/heads/main",
        // no indexPath — must auto-detect Claude path
      },
      { store, hanakoHome: home, execGit: execGit as any },
    );

    expect(snapshot.plugins.map((p) => p.id).sort()).toEqual(["skillwiki", "vault-sync"]);
    expect(store.getStatus("llm-wiki").state).toBe("ok");
    // Ensure show was attempted for default then Claude path
    const showPaths = execGit.mock.calls
      .filter((c) => c[1].includes("show"))
      .map((c) => String(c[1][c[1].length - 1]).replace(/^HEAD:/, ""));
    expect(showPaths).toContain("marketplace.json");
    expect(showPaths).toContain(CLAUDE_MARKETPLACE_INDEX_PATH);

    // Control: Hana root catalog still preferred when present
    blobs.set("marketplace.json", hanaText);
    const home2 = makeHome();
    const store2 = new MarketplaceSnapshotStore({ hanakoHome: home2 });
    const snap2 = await acquireGitMarketplaceSnapshot(
      {
        id: "team-plugins",
        kind: "git",
        gitUrl: "https://github.com/example/team-plugins.git",
        gitRef: "refs/heads/main",
      },
      { store: store2, hanakoHome: home2, execGit: execGit as any },
    );
    expect(snap2.plugins.map((p) => p.id)).toEqual(["demo"]);
  });

  it("normalizes tree URLs before clone", async () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const claudeText = JSON.stringify(LLM_WIKI_CLAUDE_CATALOG);
    let clonedUrl = "";
    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        clonedUrl = args[args.length - 2] as string;
        fs.mkdirSync(args[args.length - 1] as string, { recursive: true });
        return "";
      }
      if (args.includes("rev-parse")) return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
      if (args.includes("show")) {
        const blobPath = String(args[args.length - 1]).replace(/^HEAD:/, "");
        if (blobPath === CLAUDE_MARKETPLACE_INDEX_PATH) return claudeText;
        throw new Error("missing");
      }
      throw new Error("unexpected");
    });

    await acquireGitMarketplaceSnapshot(
      {
        id: "llm-wiki",
        kind: "git",
        gitUrl: "https://github.com/karlorz/llm-wiki/tree/main/.claude-plugin",
      },
      { store, hanakoHome: home, execGit: execGit as any },
    );
    expect(clonedUrl).toBe("https://github.com/karlorz/llm-wiki.git");
    expect(store.getStatus("llm-wiki").state).toBe("ok");
  });
});

describe("service addSource git Claude path", () => {
  it("addSource publishes snapshot with skillwiki and vault-sync without manual indexPath", async () => {
    const home = makeHome();
    const claudeText = JSON.stringify(LLM_WIKI_CLAUDE_CATALOG);
    const svc = new PluginMarketplaceService({ hanakoHome: home, env: {} });

    // Inject via dynamic import path used by service — monkey-patch module function
    const gitCache = await import("../lib/plugin-marketplace-git-cache.ts");
    const original = gitCache.acquireGitMarketplaceSnapshot;
    const spy = vi.spyOn(gitCache, "acquireGitMarketplaceSnapshot").mockImplementation(
      async (source, options) => {
        // Drive real acquire with mocked execGit (shipped path)
        return original(source, {
          ...options,
          execGit: async (_bin: string, args: string[]) => {
            if (args[0] === "clone") {
              fs.mkdirSync(args[args.length - 1] as string, { recursive: true });
              return "";
            }
            if (args.includes("rev-parse")) return "cccccccccccccccccccccccccccccccccccccccc\n";
            if (args.includes("show")) {
              const blobPath = String(args[args.length - 1]).replace(/^HEAD:/, "");
              if (blobPath === "marketplace.json") throw new Error("missing");
              if (blobPath === CLAUDE_MARKETPLACE_INDEX_PATH) return claudeText;
              throw new Error("missing");
            }
            throw new Error(`unexpected ${args.join(" ")}`);
          },
        });
      },
    );

    try {
      await svc.addSource(
        {
          id: "llm-wiki",
          name: "llm-wiki",
          kind: "git",
          gitUrl: "https://github.com/karlorz/llm-wiki",
        },
        { isStudioOwner: true },
      );
      const status = svc.snapshots.getStatus("llm-wiki");
      expect(status.state).toBe("ok");
      const rows = svc.listCatalogRows();
      const ids = rows.plugins
        .filter((p) => p.marketplaceId === "llm-wiki")
        .map((p) => p.pluginId)
        .sort();
      expect(ids).toEqual(["skillwiki", "vault-sync"]);
      expect(rows.sources.some((s) => s.id === "llm-wiki" && s.kind === "git")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("local acquire Claude index auto-detect", () => {
  it("finds .claude-plugin/marketplace.json under a local source root", async () => {
    const home = makeHome();
    const allowed = path.join(home, "plugin-marketplaces-local");
    const sourceDir = path.join(allowed, "llm-wiki-src");
    fs.mkdirSync(path.join(sourceDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify(LLM_WIKI_CLAUDE_CATALOG),
      "utf8",
    );
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const snap = await acquireAndPublishSourceSnapshot(
      {
        id: "llm-wiki-local",
        name: "local",
        kind: "local",
        path: sourceDir,
      },
      { store, localAllowedRoot: allowed },
    );
    expect(snap.plugins.map((p) => p.id).sort()).toEqual(["skillwiki", "vault-sync"]);
  });
});
