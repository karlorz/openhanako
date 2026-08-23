import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(process.cwd(), "scripts", "build-server.mjs"),
  "utf8",
);

describe("build-server runtime-only mode", () => {
  it("resolves an explicit build mode before the final seed-pack step", () => {
    expect(source).toContain("resolveServerBuildMode");
    expect(source).toContain("const serverBuildMode");
    expect(source).toMatch(/if\s*\(serverBuildMode\s*===\s*SERVER_BUILD_SEED\)/);
  });

  it("keeps server provenance and wrappers outside the optional seed branch", () => {
    const infoIndex = source.indexOf("server-build-info.json created");
    const wrapperIndex = source.indexOf("wrapper created");
    const seedBranchIndex = source.indexOf("serverBuildMode === SERVER_BUILD_SEED");
    expect(infoIndex).toBeGreaterThanOrEqual(0);
    expect(wrapperIndex).toBeGreaterThanOrEqual(0);
    expect(seedBranchIndex).toBeGreaterThan(infoIndex);
    expect(seedBranchIndex).toBeGreaterThan(wrapperIndex);
  });
});
