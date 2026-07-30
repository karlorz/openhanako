import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const helperPath = path.join(process.cwd(), "desktop", "src", "shared", "packaged-artifact-boot.cjs");
const policyPath = path.join(process.cwd(), "desktop", "src", "shared", "release-runtime-policy.cjs");
const tempDirs = [];

function makeResources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-packaged-boot-"));
  tempDirs.push(root);
  return root;
}

function writeFile(root, relativePath, content = "") {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function makeRawLayout(resourcesPath) {
  writeFile(resourcesPath, "server/hana-server");
  writeFile(resourcesPath, "server/bootstrap.js");
  writeFile(resourcesPath, "server/bundle/index.js");
  writeFile(resourcesPath, "server/node");
  writeFile(resourcesPath, "server/server-build-info.json", JSON.stringify({ gitSha: "a" }));
  writeFile(resourcesPath, "server/desktop/dist-renderer/mobile.html", "<!doctype html>");
  writeFile(resourcesPath, "app/desktop/dist-renderer/index.html", "<!doctype html>");
}

function makeSignedLayout(resourcesPath) {
  writeFile(resourcesPath, "seed/seed-train-darwin-arm64.json", "{}");
  writeFile(resourcesPath, "seed/seed-train-darwin-arm64.json.sig", "signature");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("planPackagedArtifactBoot (real helper)", () => {
  it("returns dev for non-packaged layout mode", () => {
    const { planPackagedArtifactBoot } = require(helperPath);
    expect(planPackagedArtifactBoot({ layout: { mode: "dev" } })).toEqual({
      kind: "dev",
      context: null,
      rendererState: null,
      layout: { mode: "dev" },
    });
  });

  it("builds a legacy-raw context without artifact management from resolvePackagedLayout", () => {
    const { resolvePackagedLayout } = require(policyPath);
    const { planPackagedArtifactBootFromResources } = require(helperPath);
    const resourcesPath = makeResources();
    makeRawLayout(resourcesPath);
    const rendererRoot = path.join(resourcesPath, "app", "desktop", "dist-renderer");
    const plan = planPackagedArtifactBootFromResources({
      appIsPackaged: true,
      resourcesPath,
      buildInfo: { releaseProfile: "legacy-raw", appVersion: "0.407.15" },
      rendererRoot,
      appVersion: "0.407.15",
      resolveLayout: resolvePackagedLayout,
    });
    expect(plan.kind).toBe("legacy-raw");
    expect(plan.context).toEqual({
      serverRoot: path.join(resourcesPath, "server"),
      serverRendererRoot: path.join(resourcesPath, "server", "desktop", "dist-renderer"),
      train: null,
      channel: null,
      artifactManaged: false,
      releaseProfile: "legacy-raw",
    });
    expect(plan.rendererState).toEqual({
      distRenderer: rendererRoot,
      rendererBootChannel: null,
      rendererBootTrain: null,
      artifactBootChannel: null,
      contentVersion: "0.407.15",
    });
  });

  it("selects signed continuation when seed layout is present", () => {
    const { resolvePackagedLayout } = require(policyPath);
    const { planPackagedArtifactBootFromResources } = require(helperPath);
    const resourcesPath = makeResources();
    makeSignedLayout(resourcesPath);
    const plan = planPackagedArtifactBootFromResources({
      appIsPackaged: true,
      resourcesPath,
      buildInfo: { releaseProfile: "signed" },
      rendererRoot: path.join(resourcesPath, "app", "desktop", "dist-renderer"),
      platformArch: "darwin-arm64",
      resolveLayout: resolvePackagedLayout,
    });
    expect(plan.kind).toBe("signed");
    expect(plan.context).toBeNull();
    expect(plan.layout).toMatchObject({ mode: "signed", seedRoot: path.join(resourcesPath, "seed") });
  });
});

describe("shouldRefreshSameVersionSeed", () => {
  const { shouldRefreshSameVersionSeed } = require(helperPath);

  it("enables refresh only for normalized local build metadata", () => {
    expect(shouldRefreshSameVersionSeed({ channel: "local" })).toBe(true);
    expect(shouldRefreshSameVersionSeed({ channel: "release" })).toBe(false);
    expect(shouldRefreshSameVersionSeed({ channel: "dev" })).toBe(false);
    expect(shouldRefreshSameVersionSeed(null)).toBe(false);
    expect(shouldRefreshSameVersionSeed()).toBe(false);
    expect(shouldRefreshSameVersionSeed({ channel: "LOCAL" })).toBe(false);
    expect(shouldRefreshSameVersionSeed({ channel: "unknown" })).toBe(false);
    expect(shouldRefreshSameVersionSeed({ channel: 42 })).toBe(false);
  });
});

describe("buildSignedPackagedBootResult (real helper)", () => {
  it("maps prepareArtifactBoot output into boot context and renderer state", () => {
    const { buildSignedPackagedBootResult } = require(helperPath);
    const result = buildSignedPackagedBootResult({
      boot: {
        server: {
          versionDir: "/home/artifacts/server/v1",
          train: 12,
          version: "0.412.7",
          quarantinedTrain: null,
        },
        renderer: {
          versionDir: "/home/artifacts/renderer/v1",
          train: 12,
          version: "0.412.7",
          quarantinedTrain: 11,
        },
      },
      bootChannel: "stable",
      rendererPointerChannel: (channel) => `${channel}.renderer`,
      previousContentVersion: "0.407.15",
    });
    expect(result.kind).toBe("signed");
    expect(result.context).toEqual({
      serverRoot: "/home/artifacts/server/v1",
      train: 12,
      channel: "stable",
      artifactManaged: true,
      releaseProfile: "signed",
    });
    expect(result.rendererState).toEqual({
      distRenderer: "/home/artifacts/renderer/v1",
      rendererBootChannel: "stable.renderer",
      rendererBootTrain: 12,
      artifactBootChannel: "stable",
      contentVersion: "0.412.7",
    });
    expect(result.notices.quarantine).toBe(true);
  });
});

describe("desktop main uses packaged-artifact-boot helper", () => {
  it("registers the helper and keeps connect-probe isolation separate", () => {
    const root = process.cwd();
    const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
    const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
    expect(main).toContain('require("./src/shared/packaged-artifact-boot.cjs")');
    expect(main).toContain("planPackagedArtifactBoot");
    expect(main).toContain("buildSignedPackagedBootResult");
    expect(main).toContain("shouldRefreshSameVersionSeed");
    expect(main).toContain("createConnectProbeHandler");
    expect(main).toContain('wrapIpcHandler("connect:probe"');
    // Probe policy stays out of packaging helper
    expect(main).not.toMatch(/createConnectProbeHandler[\s\S]{0,80}planPackagedArtifactBoot/);
    expect(preload).toContain('probeConnection: (payload) => ipcRenderer.invoke("connect:probe", payload)');
  });
});
