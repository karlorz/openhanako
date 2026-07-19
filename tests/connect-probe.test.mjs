import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createConnectProbeHandler } = require("../desktop/src/shared/connect-probe.cjs");

function fileSender() {
  return { senderFrame: { url: "file:///Applications/HanaAgent.app/Contents/Resources/app/index.html" } };
}

describe("createConnectProbeHandler", () => {
  it("rejects missing baseUrl and credential", async () => {
    const handler = createConnectProbeHandler({ fetchImpl: vi.fn() });
    await expect(handler(fileSender(), {})).resolves.toEqual({ ok: false, error: "baseUrl required" });
    await expect(handler(fileSender(), { baseUrl: "http://192.168.1.9:14500" }))
      .resolves.toEqual({ ok: false, error: "credential required" });
  });

  it("rejects non-http(s) schemes and non-file senders", async () => {
    const handler = createConnectProbeHandler({ fetchImpl: vi.fn() });
    await expect(handler(fileSender(), { baseUrl: "ftp://evil", credential: "k" }))
      .resolves.toEqual({ ok: false, error: "baseUrl must be http(s)" });
    await expect(handler(
      { senderFrame: { url: "https://evil.example/" } },
      { baseUrl: "http://192.168.1.9:14500", credential: "k" },
    )).resolves.toEqual({ ok: false, error: "forbidden sender" });
  });

  it("blocks redirects and returns identity on success via the real handler", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(init.redirect).toBe("manual");
      if (String(url).endsWith("/api/web-auth/login")) {
        return { ok: true, status: 200 };
      }
      if (String(url).endsWith("/api/server/identity")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ serverId: "srv", connectionKind: "lan" }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    });
    const handler = createConnectProbeHandler({ fetchImpl });
    await expect(handler(fileSender(), {
      baseUrl: "http://100.125.173.118:14500/",
      credential: "hana_dev_key",
    })).resolves.toEqual({
      ok: true,
      identity: { serverId: "srv", connectionKind: "lan" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("blocks login redirects so net.fetch cannot expand the network boundary", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 302 }));
    const handler = createConnectProbeHandler({ fetchImpl });
    await expect(handler(fileSender(), {
      baseUrl: "http://100.125.173.118:14500",
      credential: "hana_dev_key",
    })).resolves.toEqual({ ok: false, error: "login redirect blocked" });
  });
});

describe("desktop main registers isolated connect:probe", () => {
  it("registers connect:probe through createConnectProbeHandler and keeps preload exposure", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "..");
    const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
    const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
    const moduleSource = fs.readFileSync(
      path.join(root, "desktop", "src", "shared", "connect-probe.cjs"),
      "utf8",
    );

    expect(main).toContain('createConnectProbeHandler');
    expect(main).toContain('wrapIpcHandler("connect:probe"');
    expect(main).toContain("connect-probe.cjs");
    // Implementation body lives in the isolated module, not inline in main.
    expect(moduleSource).toContain('redirect: "manual"');
    expect(moduleSource).toContain("forbidden sender");
    expect(preload).toContain('probeConnection: (payload) => ipcRenderer.invoke("connect:probe", payload)');
  });
});
