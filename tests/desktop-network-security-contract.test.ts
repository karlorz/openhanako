import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();

const DESKTOP_HTMLS = [
  "desktop/src/browser-viewer.html",
  "desktop/src/index.html",
  "desktop/src/mobile.html",
  "desktop/src/onboarding.html",
  "desktop/src/quick-chat.html",
  "desktop/src/settings.html",
  "desktop/src/splash.html",
  "desktop/src/viewer-window.html",
];

describe("desktop network security contracts", () => {
  it("prevents renderer pages from leaking token-bearing URLs via Referer", () => {
    for (const rel of DESKTOP_HTMLS) {
      const html = fs.readFileSync(path.join(root, rel), "utf8");
      expect(html, rel).toMatch(/<meta\s+name=["']referrer["']\s+content=["']no-referrer["']\s*\/?>/i);
    }
  });

  it("sets Referrer-Policy on server responses before route handling", () => {
    const source = fs.readFileSync(path.join(root, "server", "index.ts"), "utf8");
    const middlewareIndex = source.indexOf('app.use("*"');
    const referrerIndex = source.indexOf('c.header("Referrer-Policy", "no-referrer")');
    const nextIndex = source.indexOf("await next();", middlewareIndex);

    expect(middlewareIndex).toBeGreaterThan(-1);
    expect(referrerIndex).toBeGreaterThan(middlewareIndex);
    expect(referrerIndex).toBeLessThan(nextIndex);
  });

  it("pins connect:probe to non-following fetches so redirects cannot expand its network boundary", () => {
    const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
    const probeModule = fs.readFileSync(
      path.join(root, "desktop", "src", "shared", "connect-probe.cjs"),
      "utf8",
    );
    // Registration stays in main; redirect/SSRF policy lives in the isolated module.
    expect(main).toContain('wrapIpcHandler("connect:probe"');
    expect(main).toContain("createConnectProbeHandler");
    expect(probeModule).toContain('redirect: "manual"');
    expect(probeModule).toMatch(/status\s*>=\s*300/);
    expect(probeModule).toMatch(/status\s*<\s*400/);
  });
});
