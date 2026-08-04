import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireGitMarketplaceSnapshot,
  assertPublicGitHttpsUrl,
  assertStrictGitRef,
  hashGitSourceIdentity,
  materializeGitMarketplacePackage,
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

  it("materializes packages into a stable bounded cache and cleans failed staging", async () => {
    const home = makeHome();
    const source = {
      id: "team-plugins",
      kind: "git" as const,
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
    };
    let cloneCalls = 0;
    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        cloneCalls += 1;
        const dest = args[args.length - 1];
        fs.mkdirSync(path.join(dest, "packages", "skills", "demo"), { recursive: true });
        fs.writeFileSync(path.join(dest, "packages", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n", "utf8");
        return "";
      }
      if (args.includes("sparse-checkout")) return "";
      if (args.includes("rev-parse")) return `${String(cloneCalls).repeat(40).slice(0, 40)}\n`;
      if (args.includes("checkout")) return "";
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const first = await materializeGitMarketplacePackage(source, {
      hanakoHome: home,
      packagePath: "packages/skills",
      execGit: execGit as any,
    });
    const second = await materializeGitMarketplacePackage(source, {
      hanakoHome: home,
      packagePath: "packages/skills",
      execGit: execGit as any,
    });

    expect(first.repoRoot).toBe(second.repoRoot);
    expect(first.resolvedRevision).toBe(second.resolvedRevision);
    expect(cloneCalls).toBe(1);
    expect(fs.existsSync(path.join(second.packageRoot, "demo", "SKILL.md"))).toBe(true);
    const cacheRoot = path.join(home, "plugin-marketplace-git", "team-plugins", "packages");
    const cacheEntries = fs.readdirSync(cacheRoot).filter((name) => !name.startsWith("."));
    expect(cacheEntries).toHaveLength(1);

    const failingGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(dest, { recursive: true });
        throw new Error("clone failed");
      }
      return "";
    });
    await expect(
      materializeGitMarketplacePackage({
        ...source,
        id: "other-team",
      }, {
        hanakoHome: home,
        packagePath: "packages/skills",
        execGit: failingGit as any,
      }),
    ).rejects.toThrow(/clone failed/i);
    const failedRoot = path.join(home, "plugin-marketplace-git", "other-team", "packages");
    expect(fs.existsSync(failedRoot)
      ? fs.readdirSync(failedRoot).filter((name) => name.startsWith(".stage-"))
      : []).toEqual([]);
  });

  it("pins materialization to expectedRevision when branch HEAD differs", async () => {
    const home = makeHome();
    const source = {
      id: "team-plugins",
      kind: "git" as const,
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
    };
    const snapshotRev = "a".repeat(40);
    const headRev = "b".repeat(40);
    let fetchCalled = false;
    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(path.join(dest, "packages", "skills", "demo"), { recursive: true });
        fs.writeFileSync(path.join(dest, "packages", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n", "utf8");
        return "";
      }
      if (args.includes("sparse-checkout")) return "";
      if (args.includes("rev-parse")) {
        // First call (after clone) returns HEAD; second call (after fetch+checkout) returns pinned rev
        return fetchCalled ? `${snapshotRev}\n` : `${headRev}\n`;
      }
      if (args.includes("fetch")) {
        fetchCalled = true;
        return "";
      }
      if (args.includes("checkout")) return "";
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await materializeGitMarketplacePackage(source, {
      hanakoHome: home,
      packagePath: "packages/skills",
      execGit: execGit as any,
      expectedRevision: snapshotRev,
    });

    expect(result.resolvedRevision).toBe(snapshotRev);
    expect(fetchCalled).toBe(true);
    expect(execGit.mock.calls.some((c) => c[1].includes("fetch"))).toBe(true);
    expect(execGit.mock.calls.some((c) => c[1].includes("checkout") && c[1].includes(snapshotRev))).toBe(true);
  });

  it("skips fetch when expectedRevision matches HEAD", async () => {
    const home = makeHome();
    const source = {
      id: "team-plugins",
      kind: "git" as const,
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
    };
    const rev = "c".repeat(40);
    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(path.join(dest, "packages", "skills", "demo"), { recursive: true });
        fs.writeFileSync(path.join(dest, "packages", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n", "utf8");
        return "";
      }
      if (args.includes("sparse-checkout")) return "";
      if (args.includes("rev-parse")) return `${rev}\n`;
      if (args.includes("fetch")) return "";
      if (args.includes("checkout")) return "";
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    const result = await materializeGitMarketplacePackage(source, {
      hanakoHome: home,
      packagePath: "packages/skills",
      execGit: execGit as any,
      expectedRevision: rev,
    });

    expect(result.resolvedRevision).toBe(rev);
    expect(execGit.mock.calls.some((c) => c[1].includes("fetch"))).toBe(false);
  });

  it("misses warm cache when expectedRevision differs from cached marker and pins the requested rev", async () => {
    const home = makeHome();
    const source = {
      id: "team-plugins",
      kind: "git" as const,
      gitUrl: "https://github.com/example/team-plugins.git",
      gitRef: "refs/heads/main",
    };
    const revA = "a".repeat(40);
    const revB = "b".repeat(40);
    let cloneCalls = 0;
    let fetchCalled = false;
    const execGit = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "clone") {
        cloneCalls += 1;
        const dest = args[args.length - 1];
        fs.mkdirSync(path.join(dest, "packages", "skills", "demo"), { recursive: true });
        fs.writeFileSync(path.join(dest, "packages", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n", "utf8");
        return "";
      }
      if (args.includes("sparse-checkout")) return "";
      if (args.includes("rev-parse")) {
        // After clone for second materialize: branch HEAD may be revA; after pin, HEAD is revB.
        return fetchCalled ? `${revB}\n` : `${revA}\n`;
      }
      if (args.includes("fetch")) {
        fetchCalled = true;
        return "";
      }
      if (args.includes("checkout")) return "";
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });

    // Seed cache at rev A (no expectedRevision → whatever HEAD is).
    const first = await materializeGitMarketplacePackage(source, {
      hanakoHome: home,
      packagePath: "packages/skills",
      execGit: execGit as any,
    });
    expect(first.resolvedRevision).toBe(revA);
    expect(cloneCalls).toBe(1);

    // Warm-cache hit with matching expectedRevision must reuse (no second clone).
    const same = await materializeGitMarketplacePackage(source, {
      hanakoHome: home,
      packagePath: "packages/skills",
      execGit: execGit as any,
      expectedRevision: revA,
    });
    expect(same.resolvedRevision).toBe(revA);
    expect(cloneCalls).toBe(1);

    // Mismatched expectedRevision must not silently return rev A.
    fetchCalled = false;
    const second = await materializeGitMarketplacePackage(source, {
      hanakoHome: home,
      packagePath: "packages/skills",
      execGit: execGit as any,
      expectedRevision: revB,
    });
    expect(second.resolvedRevision).toBe(revB);
    expect(cloneCalls).toBe(2);
    expect(fetchCalled).toBe(true);
    expect(execGit.mock.calls.some((c) => c[1].includes("fetch") && c[1].includes(revB))).toBe(true);
    expect(execGit.mock.calls.some((c) => c[1].includes("checkout") && c[1].includes(revB))).toBe(true);
  });
});
