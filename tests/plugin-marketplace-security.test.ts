import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpsUrl,
  canonicalizeIpAddress,
  isDeniedIpAddress,
  pinnedLookupFor,
  resolveAndPinPublicHttpsUrl,
  safeFetchText,
  safeFetchBytes,
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
      "https://[::1]/x",
      "https://[fc00::1]/x",
      "https://[fe80::1]/x",
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

  it("rejects hex and dotted IPv4-mapped IPv6 private, loopback, and link-local literals", () => {
    // Probe values recorded in the review: hex mapped forms must be denied.
    expect(isDeniedIpAddress("::ffff:0a00:0001")).toBe(true);   // 10.0.0.1
    expect(isDeniedIpAddress("::ffff:7f00:1")).toBe(true);      // 127.0.0.1
    expect(isDeniedIpAddress("::ffff:a9fe:a9fe")).toBe(true);   // 169.254.169.254
    expect(isDeniedIpAddress("::ffff:10.0.0.1")).toBe(true);    // dotted mapped
    expect(isDeniedIpAddress("::ffff:0808:0808")).toBe(false);  // 8.8.8.8 public
    expect(isDeniedIpAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("rejects NAT64, IPv4-compatible, ULA, link-local, multicast, and unspecified IPv6 forms", () => {
    for (const bad of [
      "64:ff9b::1", "64:ff9b:1::2", "2001:20::3", "2001:21::4", // NAT64 well-known
      "::10.0.0.1", "::a00:1",                                  // IPv4-compatible
      "fd00::1", "fc00::2",                                     // ULA
      "fe80::1", "febf::1",                                     // link-local
      "ff00::1", "ff02::1",                                     // multicast
      "::", "::1",                                              // unspecified / loopback
    ]) {
      expect(isDeniedIpAddress(bad), bad).toBe(true);
    }
    expect(isDeniedIpAddress("2001:4860:4860::8888")).toBe(false); // public
    expect(isDeniedIpAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("canonicalizes compressed and expanded forms to one stable representation", () => {
    expect(canonicalizeIpAddress("2001:db8::1")).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(canonicalizeIpAddress("2001:0db8:0:0:0:0:0:1")).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(canonicalizeIpAddress("::ffff:0a00:0001")).toBe("10.0.0.1");
    expect(canonicalizeIpAddress("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(() => canonicalizeIpAddress("not-an-ip")).toThrow();
  });

  it("rejects literal private/mapped hosts inside assertPublicHttpsUrl before any DNS", () => {
    expect(() => assertPublicHttpsUrl("https://[::ffff:0a00:0001]/catalog.json")).toThrow(/not allowed/);
    expect(() => assertPublicHttpsUrl("https://[64:ff9b::1]/catalog.json")).toThrow(/not allowed/);
    expect(assertPublicHttpsUrl("https://[2606:4700:4700::1111]/catalog.json").hostname).toBe("[2606:4700:4700::1111]");
  });

  it("rejects mixed DNS answers where any canonicalized answer is non-public", async () => {
    await expect(resolveAndPinPublicHttpsUrl("https://example.org/catalog.json", {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:0a00:0001", family: 6 },
      ],
    })).rejects.toThrow(/private or reserved/);
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

  it("binds the fetch to the validated addresses via a pinned dispatcher (no fresh DNS at connect)", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => new Response("ok", { status: 200 }));
    const createDispatcher = vi.fn((pinned: string[], hostname: string) => ({ pinned, hostname }));
    const body = await safeFetchText("https://example.org/catalog.json", {
      fetchImpl,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      createDispatcher,
    });
    expect(body).toBe("ok");
    expect(createDispatcher).toHaveBeenCalledWith(["93.184.216.34"], "example.org");
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe("https://example.org/catalog.json"); // hostname preserved → SNI + Host intact
    expect(init.dispatcher).toEqual({ pinned: ["93.184.216.34"], hostname: "example.org" });
  });

  it("re-pins and revalidates each redirect hop with a fresh dispatcher", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.example.org/catalog.json" } }))
      .mockResolvedValueOnce(new Response("final", { status: 200 }));
    const createDispatcher = vi.fn((_pinned: string[], _hostname: string) => ({ kind: "pinned" }));
    const body = await safeFetchText("https://example.org/catalog.json", {
      fetchImpl,
      lookup: async (hostname: string) =>
        hostname === "example.org"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "2606:4700:4700::1111", family: 6 }],
      createDispatcher,
    });
    expect(body).toBe("final");
    expect(createDispatcher).toHaveBeenNthCalledWith(1, ["93.184.216.34"], "example.org");
    expect(createDispatcher).toHaveBeenNthCalledWith(2, ["2606:4700:4700::1111"], "cdn.example.org");
  });

  it("aborts the fetch when a redirect target fails re-pinning", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://private-hop.example.org/catalog.json" } }));
    await expect(safeFetchText("https://example.org/catalog.json", {
      fetchImpl,
      lookup: async (hostname: string) =>
        hostname === "example.org"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "10.0.0.1", family: 4 }],
    })).rejects.toThrow(/private or reserved/);
  });

  it("builds a lookup that returns only the validated pinned addresses", () => {
    const lookup = pinnedLookupFor(["93.184.216.34", "2606:4700:4700::1111"]);
    const callback = vi.fn();
    lookup("ignored.example.org", { family: 0 }, callback as any);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("fetches bounded release bytes and verifies the exact sha256", async () => {
    const body = Buffer.from("verified plugin release");
    const expectedSha256 = (await import("crypto")).createHash("sha256").update(body).digest("hex");
    const result = await safeFetchBytes("https://example.com/plugin.zip?release=1", {
      fetchImpl: async () => new Response(body, { status: 200 }),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      expectedSha256,
      maxBytes: 1024,
      allowQuery: true,
    });
    expect(result.body).toEqual(body);
    expect(result.sha256).toBe(expectedSha256);

    await expect(safeFetchBytes("https://example.com/plugin.zip", {
      fetchImpl: async () => new Response(body, { status: 200 }),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      expectedSha256: "0".repeat(64),
    })).rejects.toThrow("Plugin release sha256 mismatch");
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
