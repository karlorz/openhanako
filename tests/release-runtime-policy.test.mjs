import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const policyPath = path.join(process.cwd(), "desktop", "src", "shared", "release-runtime-policy.cjs");
const tempDirs = [];

function makeResources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-runtime-policy-"));
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
  writeFile(resourcesPath, "app/desktop/dist-renderer/index.html", "<!doctype html>");
}

function makeSignedLayout(resourcesPath) {
  writeFile(resourcesPath, "seed/seed-train.json", "{}");
  writeFile(resourcesPath, "seed/seed-train.json.sig", "signature");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("release runtime policy", () => {
  it("returns dev without inspecting packaged resources", () => {
    const { resolvePackagedLayout } = require(policyPath);
    expect(resolvePackagedLayout({
      appIsPackaged: false,
      resourcesPath: "/does/not/exist",
      buildInfo: { releaseProfile: "signed" },
      rendererRoot: "/does/not/exist",
    })).toMatchObject({ mode: "dev" });
  });

  it("accepts the signed seed layout and rejects a mixed raw tree", () => {
    const { resolvePackagedLayout } = require(policyPath);
    const resourcesPath = makeResources();
    makeSignedLayout(resourcesPath);
    expect(resolvePackagedLayout({
      appIsPackaged: true,
      resourcesPath,
      buildInfo: { releaseProfile: "signed" },
      rendererRoot: path.join(resourcesPath, "app", "desktop", "dist-renderer"),
    })).toMatchObject({ mode: "signed" });

    makeRawLayout(resourcesPath);
    expect(() => resolvePackagedLayout({
      appIsPackaged: true,
      resourcesPath,
      buildInfo: { releaseProfile: "signed" },
      rendererRoot: path.join(resourcesPath, "app", "desktop", "dist-renderer"),
    })).toThrow(/mixed packaged layout/i);
  });

  it("accepts only a marked legacy raw layout with a bundled renderer", () => {
    const { resolvePackagedLayout } = require(policyPath);
    const resourcesPath = makeResources();
    const rendererRoot = path.join(resourcesPath, "app", "desktop", "dist-renderer");
    makeRawLayout(resourcesPath);
    expect(resolvePackagedLayout({
      appIsPackaged: true,
      resourcesPath,
      buildInfo: { releaseProfile: "legacy-raw", artifactUpdatesEnabled: false },
      rendererRoot,
    })).toMatchObject({ mode: "legacy-raw", serverRoot: path.join(resourcesPath, "server"), rendererRoot });

    expect(() => resolvePackagedLayout({
      appIsPackaged: true,
      resourcesPath,
      buildInfo: { releaseProfile: "signed" },
      rendererRoot,
    })).toThrow(/unmarked legacy raw layout/i);
  });

  it("rejects missing or incomplete packaged layouts with actionable errors", () => {
    const { resolvePackagedLayout } = require(policyPath);
    const resourcesPath = makeResources();
    expect(() => resolvePackagedLayout({
      appIsPackaged: true,
      resourcesPath,
      buildInfo: { releaseProfile: "signed" },
      rendererRoot: path.join(resourcesPath, "app", "desktop", "dist-renderer"),
    })).toThrow(/missing packaged artifact layout/i);

    makeRawLayout(resourcesPath);
    fs.rmSync(path.join(resourcesPath, "server", "bundle", "index.js"));
    expect(() => resolvePackagedLayout({
      appIsPackaged: true,
      resourcesPath,
      buildInfo: { releaseProfile: "legacy-raw" },
      rendererRoot: path.join(resourcesPath, "app", "desktop", "dist-renderer"),
    })).toThrow(/bundle\/index\.js/i);
  });
});

describe("artifact update availability", () => {
  it("enables updates only for signed builds that opt in", () => {
    const { artifactUpdateAvailability } = require(policyPath);
    expect(artifactUpdateAvailability({ releaseProfile: "signed", artifactUpdatesEnabled: true })).toEqual({
      enabled: true,
      reason: null,
    });
    expect(artifactUpdateAvailability({ releaseProfile: "signed", artifactUpdatesEnabled: false })).toMatchObject({
      enabled: false,
    });
  });

  it("disables artifact updates for legacy raw and development metadata", () => {
    const { artifactUpdateAvailability } = require(policyPath);
    expect(artifactUpdateAvailability({ releaseProfile: "legacy-raw" })).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/legacy-raw/i),
    });
    expect(artifactUpdateAvailability({ channel: "local", releaseProfile: "signed" })).toMatchObject({
      enabled: false,
      reason: expect.any(String),
    });
  });
});
