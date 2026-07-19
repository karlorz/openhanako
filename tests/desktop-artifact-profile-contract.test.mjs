import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const mainSource = () => fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");

describe("legacy raw desktop runtime contract", () => {
  it("uses the shared layout and update policies", () => {
    const source = mainSource();
    expect(source).toContain('require("./src/shared/release-runtime-policy.cjs")');
    expect(source).toContain('require("./src/shared/packaged-artifact-boot.cjs")');
    expect(source).toContain("resolvePackagedLayout({");
    expect(source).toContain("planPackagedArtifactBoot");
    expect(source).toContain("buildSignedPackagedBootResult");
    expect(source).toContain("artifactUpdateAvailability(readBuildInfo())");
  });

  it("keeps raw startup outside artifact sentinels and renderer retry state", () => {
    const source = mainSource();
    const helper = fs.readFileSync(
      path.join(root, "desktop", "src", "shared", "packaged-artifact-boot.cjs"),
      "utf8",
    );
    // Dual-profile decision is plan.kind === "legacy-raw" from packaged-artifact-boot.
    expect(source).toContain('plan.kind === "legacy-raw"');
    // artifactManaged flag lives in the pure helper (legacy-raw false / signed true).
    expect(helper).toContain("artifactManaged: false");
    expect(helper).toContain("artifactManaged: true");
    expect(source).toContain("artifactBootContext?.artifactManaged === true");
    expect(source).toContain("artifactBootContext.serverRendererRoot || _distRenderer");
  });

  it("gates all artifact OTA, train, repair, and repair-flag paths", () => {
    const source = mainSource();
    expect(source).toContain("function getArtifactUpdateAvailability()");
    expect(source).toContain("train-update-status");
    expect(source).toContain("train-update-check");
    expect(source).toContain("train-update-apply");
    expect(source).toContain("--repair-artifacts");
    expect(source).toContain("artifactAvailability.enabled");
  });

  it("preserves the explicit development artifact rehearsal path", () => {
    const source = mainSource();
    const start = source.indexOf("function getArtifactUpdateAvailability()");
    const end = source.indexOf("\n}\n", start) + 3;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, end)).toMatch(/if \(!app\.isPackaged\)[\s\S]*artifactOta\.hasDevOverrideConfigured\(\)/);
  });
});
