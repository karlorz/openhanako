import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireGitMarketplaceSnapshot,
  assertPublicGitHttpsUrl,
  assertStrictGitRef,
  hashGitSourceIdentity,
  runGit,
} from "../lib/plugin-marketplace-git-cache.ts";
import { MarketplaceSnapshotStore } from "../lib/plugin-marketplace-snapshots.ts";

const tempDirs: string[] = [];
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-git-mkt-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("git marketplace policy", () => {
  it("accepts public https git urls and strict refs only", () => {
    expect(assertPublicGitHttpsUrl("https://github.com/example/repo.git").hostname).toBe("github.com");
    expect(() => assertPublicGitHttpsUrl("git@github.com:example/repo.git")).toThrow();
    expect(() => assertPublicGitHttpsUrl("http://github.com/example/repo.git")).toThrow();
    expect(() => assertPublicGitHttpsUrl("https://user:pass@github.com/example/repo.git")).toThrow();
    expect(assertStrictGitRef("refs/heads/main")).toBe("refs/heads/main");
    expect(assertStrictGitRef(undefined)).toBe("refs/heads/main");
    expect(() => assertStrictGitRef("main; rm -rf /")).toThrow();
    expect(() => assertStrictGitRef("../evil")).toThrow();
  });

  it("forbids git pull in runner", async () => {
    await expect(runGit("git", ["pull"], { timeoutMs: 1000 })).rejects.toThrow(/pull/i);
  });

  it("publishes snapshot via injected git exec without network", async () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const catalog = {
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

    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(dest, { recursive: true });
        return "";
      }
      if (args.includes("rev-parse")) return "0123456789abcdef0123456789abcdef01234567\n";
      if (args.includes("show")) return JSON.stringify(catalog);
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const snapshot = await acquireGitMarketplaceSnapshot(
      {
        id: "team-plugins",
        kind: "git",
        gitUrl: "https://github.com/example/team-plugins.git",
        gitRef: "refs/heads/main",
      },
      { store, hanakoHome: home, execGit: execGit as any },
    );
    expect(snapshot.plugins[0].id).toBe("demo");
    expect(snapshot.resolvedRevision).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(store.getStatus("team-plugins").state).toBe("ok");
    expect(execGit.mock.calls.some((c) => c[1].includes("pull"))).toBe(false);
  });

  it("keeps last-known-good when git acquisition fails after success", async () => {
    const home = makeHome();
    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const catalog = {
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
    let calls = 0;
    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        calls += 1;
        if (calls > 1) throw new Error("clone failed");
        const dest = args[args.length - 1];
        fs.mkdirSync(dest, { recursive: true });
        return "";
      }
      if (args.includes("rev-parse")) return "0123456789abcdef0123456789abcdef01234567\n";
      if (args.includes("show")) return JSON.stringify(catalog);
      throw new Error("unexpected");
    });
    const source = {
      id: "team-plugins",
      kind: "git" as const,
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
    };
    await acquireGitMarketplaceSnapshot(source, { store, hanakoHome: home, execGit: execGit as any });
    await expect(
      acquireGitMarketplaceSnapshot(source, { store, hanakoHome: home, execGit: execGit as any }),
    ).rejects.toThrow(/clone failed/i);
    expect(store.getStatus("team-plugins").state).toBe("stale");
  });

  it("hashes source identity tuples stably", () => {
    const a = hashGitSourceIdentity({
      id: "team-plugins",
      kind: "git",
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
    });
    const b = hashGitSourceIdentity({
      id: "team-plugins",
      kind: "git",
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
      indexPath: "marketplace.json",
    });
    expect(a).toBe(b);
  });
});
