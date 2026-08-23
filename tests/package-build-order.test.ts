import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(import.meta.dirname, "..");

function packageScripts() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8")).scripts;
}

function expectClientBeforeServer(scriptName, command) {
  const clientIndex = command.indexOf("npm run build:client");
  const serverIndex = command.indexOf("npm run build:server");
  expect(clientIndex, `${scriptName} must build the renderer before server packaging`).toBeGreaterThanOrEqual(0);
  expect(serverIndex, `${scriptName} must build the server runtime`).toBeGreaterThanOrEqual(0);
  expect(clientIndex, `${scriptName} must copy a fresh mobile renderer bundle into the server runtime`).toBeLessThan(serverIndex);
}

function expectTextBefore(label, content, earlier, later) {
  const earlierIndex = content.indexOf(earlier);
  const laterIndex = content.indexOf(later);
  expect(earlierIndex, `${label} must include ${earlier}`).toBeGreaterThanOrEqual(0);
  expect(laterIndex, `${label} must include ${later}`).toBeGreaterThanOrEqual(0);
  expect(earlierIndex, `${label} must place ${earlier} before ${later}`).toBeLessThan(laterIndex);
}

describe("package build order", () => {
  it("builds renderer assets before the server runtime for packaged apps", () => {
    const scripts = packageScripts();

    expectClientBeforeServer("pack", scripts.pack);
    expectClientBeforeServer("dist", scripts.dist);
    expectClientBeforeServer("dist:win", scripts["dist:win"]);
    expectClientBeforeServer("dist:linux", scripts["dist:linux"]);
  });

  it("prepares raw macOS server runtime after build and before Electron Builder", () => {
    const scripts = packageScripts();
    for (const scriptName of ["pack", "dist"]) {
      const command = scripts[scriptName];
      const serverIndex = command.indexOf("npm run build:server");
      const prepareIndex = command.indexOf("npm run prepare:desktop-package");
      const builderIndex = command.indexOf("electron-builder");
      expect(prepareIndex, `${scriptName} must prepare the raw server runtime`).toBeGreaterThan(serverIndex);
      expect(prepareIndex, `${scriptName} must prepare the runtime before packaging`).toBeLessThan(builderIndex);
    }
  });

  it("writes local build metadata before ad-hoc signing during local macOS install", () => {
    const scripts = packageScripts();

    expectTextBefore(
      "install:local",
      scripts["install:local"],
      "node scripts/write-local-build-info.mjs",
      "node scripts/sign-local.cjs",
    );
  });

  it("builds renderer assets before the server runtime in the release workflow", () => {
    const workflow = fs.readFileSync(path.join(rootDir, ".github", "workflows", "build.yml"), "utf-8");

    expectTextBefore(
      "GitHub release workflow",
      workflow,
      "npm run build:client",
      "node scripts/build-server.mjs",
    );
  });

  it("packages the Windows standalone archive only after the server tree and sandbox helper exist", () => {
    const scripts = packageScripts();
    const distWin = scripts["dist:win"];
    expectTextBefore("dist:win", distWin, "npm run build:windows-sandbox-helper", "npm run pack:server:standalone");
    expectTextBefore("dist:win", distWin, "npm run build:server", "npm run pack:server:standalone");
    expectTextBefore("dist:win", distWin, "npm run pack:server:standalone", "npm run verify:standalone:server");
    expectTextBefore("dist:win", distWin, "npm run verify:standalone:server", "electron-builder --win nsis");

    const workflow = fs.readFileSync(path.join(rootDir, ".github", "workflows", "build.yml"), "utf-8");
    expectTextBefore(
      "GitHub release workflow",
      workflow,
      "node scripts/build-server.mjs",
      "node scripts/build-standalone-server-artifact.mjs",
    );
    expectTextBefore(
      "GitHub release workflow",
      workflow,
      "node scripts/build-windows-sandbox-helper.mjs",
      "node scripts/build-standalone-server-artifact.mjs",
    );
    expectTextBefore(
      "GitHub release workflow",
      workflow,
      "node scripts/verify-standalone-server-artifact.mjs",
      "npx electron-builder --win nsis",
    );
    expectTextBefore(
      "GitHub release workflow",
      workflow,
      "node scripts/build-standalone-server-artifact.mjs",
      "node scripts/verify-standalone-server-artifact.mjs",
    );
  });
});
