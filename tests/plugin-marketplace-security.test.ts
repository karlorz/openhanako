import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPublicHttpsUrl,
  isDeniedIpAddress,
  resolveAndPinPublicHttpsUrl,
  safeFetchText,
  sanitizeAcquisitionError,
} from "../lib/plugin-marketplace-network-policy.ts";
import {
  assertContainedRegularFile,
  resolveContainedPath,
} from "../lib/plugin-marketplace-path-policy.ts";
import { acquireAndPublishSourceSnapshot } from "../lib/plugin-marketplace-adapters.ts";
import { MarketplaceSnapshotStore } from "../lib/plugin-marketplace-snapshots.ts";

const tempDirs: string[] = [];

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mkt-sec-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("network policy", () => {
  it("accepts credential-free public HTTPS URLs and rejects unsafe forms", () => {
    expect(assertPublicHttpsUrl("https://example.com/marketplace.json").href).toBe(
      "https://example.com/marketplace.json",
    );

    const rejected = [
      "http://example.com/x",
      "https://user:pass@example.com/x",
      "https://example.com/x?token=1",
      "https://example.com/x#frag",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "ftp://example.com/x",
      "https://example.com:22/x",
    ];
    for (const url of rejected) {
      expect(() => assertPublicHttpsUrl(url)).toThrow();
    }
  });

  it("denies private, reserved, and IPv4-mapped IPv6 addresses", () => {
    const denied = [
      "10.0.0.1",
      "172.16.5.5",
      "192.168.1.1",
      "127.0.0.1",
      "0.0.0.0",
      "169.254.1.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ];
    for (const ip of denied) {
      expect(isDeniedIpAddress(ip)).toBe(true);
    }
    expect(isDeniedIpAddress("8.8.8.8")).toBe(false);
    expect(isDeniedIpAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("pins validated public addresses and rejects mixed private DNS answers", async () => {
    const pinned = await resolveAndPinPublicHttpsUrl("https://example.com/marketplace.json", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(pinned.url.href).toContain("example.com");
    expect(pinned.pinnedAddresses).toEqual(["93.184.216.34"]);

    await expect(
      resolveAndPinPublicHttpsUrl("https://example.com/marketplace.json", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow(/private|reserved|denied/i);
  });

  it("fetches with redirect revalidation, hop limit, and body size limit", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (url.includes("start")) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://cdn.example.com/final.json" },
        });
      }
      if (url.includes("final")) {
        return new Response('{"schemaVersion":1,"plugins":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 404 });
    };

    const text = await safeFetchText("https://example.com/start.json", {
      fetchImpl,
      lookup: async (hostname) => {
        if (hostname === "example.com" || hostname === "cdn.example.com") {
          return [{ address: "93.184.216.34", family: 4 }];
        }
        return [{ address: "10.0.0.1", family: 4 }];
      },
      maxRedirects: 3,
      maxBytes: 1024,
    });
    expect(JSON.parse(text)).toEqual({ schemaVersion: 1, plugins: [] });
    expect(calls).toHaveLength(2);

    await expect(
      safeFetchText("https://example.com/start.json", {
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://example.com/start.json" },
          }),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        maxRedirects: 1,
      }),
    ).rejects.toThrow(/redirect/i);

    await expect(
      safeFetchText("https://example.com/big.json", {
        fetchImpl: async () => new Response("x".repeat(100), { status: 200 }),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        maxBytes: 10,
      }),
    ).rejects.toThrow(/limit|bytes|body/i);
  });

  it("sanitizes acquisition errors for remote principals", () => {
    const err = new Error("Failed reading /Users/karl/.hana/plugin-marketplace-cache/abc");
    const sanitized = sanitizeAcquisitionError(err, { forRemote: true });
    expect(sanitized.message).not.toContain("/Users/karl");
    expect(sanitized.code).toBeTruthy();
  });
});

describe("local path policy", () => {
  it("resolves paths under allowed roots and rejects traversal", () => {
    const root = makeDir();
    const allowed = path.join(root, "allowed");
    fs.mkdirSync(allowed, { recursive: true });
    const file = path.join(allowed, "marketplace.json");
    fs.writeFileSync(file, "{}", "utf8");

    const resolved = resolveContainedPath({
      rootDir: allowed,
      candidatePath: "marketplace.json",
    });
    expect(resolved).toBe(fs.realpathSync(file));

    expect(() =>
      resolveContainedPath({
        rootDir: allowed,
        candidatePath: "../escape.json",
      }),
    ).toThrow(/contain|escape|traversal/i);

    expect(() =>
      resolveContainedPath({
        rootDir: allowed,
        candidatePath: "/etc/passwd",
      }),
    ).toThrow();
  });

  it("requires a regular file within bounds", () => {
    const root = makeDir();
    const allowed = path.join(root, "allowed");
    fs.mkdirSync(path.join(allowed, "subdir"), { recursive: true });
    const file = path.join(allowed, "marketplace.json");
    fs.writeFileSync(file, '{"schemaVersion":1,"plugins":[]}', "utf8");

    expect(assertContainedRegularFile({
      rootDir: allowed,
      candidatePath: "marketplace.json",
      maxBytes: 1024,
    })).toBe(fs.realpathSync(file));

    expect(() =>
      assertContainedRegularFile({
        rootDir: allowed,
        candidatePath: "subdir",
        maxBytes: 1024,
      }),
    ).toThrow(/regular file/i);

    expect(() =>
      assertContainedRegularFile({
        rootDir: allowed,
        candidatePath: "marketplace.json",
        maxBytes: 5,
      }),
    ).toThrow(/size|bytes|limit/i);
  });

  it("rejects symlink escape when the platform supports it", () => {
    const root = makeDir();
    const allowed = path.join(root, "allowed");
    const outside = path.join(root, "outside");
    fs.mkdirSync(allowed, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const secret = path.join(outside, "secret.json");
    fs.writeFileSync(secret, "{}", "utf8");
    const link = path.join(allowed, "link.json");
    try {
      fs.symlinkSync(secret, link);
    } catch {
      // Some CI environments restrict symlinks; skip in that case.
      return;
    }
    expect(() =>
      assertContainedRegularFile({
        rootDir: allowed,
        candidatePath: "link.json",
        maxBytes: 1024,
      }),
    ).toThrow(/contain|escape|symlink/i);
  });
});

describe("URL and local snapshot adapters", () => {
  it("publishes a validated snapshot from a URL source via safeFetch", async () => {
    const home = makeDir();
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

    const snapshot = await acquireAndPublishSourceSnapshot(
      {
        id: "team-plugins",
        name: "Team",
        kind: "url",
        url: "https://example.com/marketplace.json",
      },
      {
        store,
        fetchOptions: {
          fetchImpl: async () =>
            new Response(JSON.stringify(catalog), { status: 200 }),
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        },
      },
    );
    expect(snapshot.plugins[0].id).toBe("demo");
    expect(store.getStatus("team-plugins").state).toBe("ok");
  });

  it("publishes a validated snapshot from a local source under allowed root", async () => {
    const home = makeDir();
    const allowed = path.join(home, "local-root");
    const sourceDir = path.join(allowed, "my-market");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "marketplace.json"),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [{
          schemaVersion: 1,
          id: "local-demo",
          name: "Local Demo",
          publisher: "Hana",
          version: "1.0.0",
          description: "Demo",
          repository: "https://example.com/demo",
          compatibility: {},
          trust: "restricted",
          permissions: [],
          contributions: [],
          distribution: { kind: "source", path: "plugins/local-demo" },
        }],
      }),
      "utf8",
    );

    const store = new MarketplaceSnapshotStore({ hanakoHome: home });
    const snapshot = await acquireAndPublishSourceSnapshot(
      {
        id: "local-dev",
        name: "Local Dev",
        kind: "local",
        path: "my-market",
      },
      {
        store,
        localAllowedRoot: allowed,
      },
    );
    expect(snapshot.plugins[0]).toMatchObject({
      id: "local-demo",
      marketplaceId: "local-dev",
      distribution: { kind: "source", path: "plugins/local-demo" },
    });
  });
});
