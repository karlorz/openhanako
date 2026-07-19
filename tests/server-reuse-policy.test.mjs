import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const policyPath = path.join(process.cwd(), "desktop", "src", "shared", "server-reuse-policy.cjs");
const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

describe("server reuse build identity policy", () => {
  it("rejects a same-version server from a different fork release tag", () => {
    const { compareExpectedRuntimeBuild } = require(policyPath);
    expect(compareExpectedRuntimeBuild(
      { appVersion: "0.407.15", releaseTag: "v0.407.15-karlorz.2" },
      { runtimeVersion: "0.407.15", releaseTag: "v0.407.15-karlorz.1" },
    )).toMatchObject({ matches: false, reason: expect.stringMatching(/release tag mismatch/i) });
  });

  it("rejects a matching tag with a different full source SHA", () => {
    const { compareExpectedRuntimeBuild } = require(policyPath);
    expect(compareExpectedRuntimeBuild(
      { releaseTag: "v0.407.15-karlorz.1", gitSha: SHA_A },
      { releaseTag: "v0.407.15-karlorz.1", gitSha: SHA_B },
    )).toMatchObject({ matches: false, reason: expect.stringMatching(/git sha mismatch/i) });
  });

  it("rejects missing runtime evidence when the desktop has exact metadata", () => {
    const { compareExpectedRuntimeBuild } = require(policyPath);
    expect(compareExpectedRuntimeBuild({ releaseTag: "v0.407.15-karlorz.1" }, null))
      .toMatchObject({ matches: false, reason: expect.stringMatching(/missing.*release tag/i) });
    expect(compareExpectedRuntimeBuild({ gitSha: SHA_A }, {}))
      .toMatchObject({ matches: false, reason: expect.stringMatching(/missing.*git sha/i) });
  });

  it("accepts exact release tag and SHA matches", () => {
    const { compareExpectedRuntimeBuild } = require(policyPath);
    expect(compareExpectedRuntimeBuild(
      { releaseTag: "v0.407.15-karlorz.1", gitSha: SHA_A.toUpperCase() },
      { releaseTag: "v0.407.15-karlorz.1", gitSha: SHA_A },
    )).toEqual({ matches: true, reason: "exact runtime build match" });
  });

  it("preserves version-only reuse when desktop metadata has no exact identity", () => {
    const { compareExpectedRuntimeBuild } = require(policyPath);
    expect(compareExpectedRuntimeBuild(
      { appVersion: "0.407.15", releaseTag: null, gitSha: "short" },
      null,
    )).toEqual({ matches: true, reason: "no exact runtime build identity expected" });
  });
});

describe("desktop integration", () => {
  it("compares identity.runtimeBuild and only terminates desktop-owned mismatches", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "desktop", "main.cjs"), "utf8");
    expect(source).toContain('require("./src/shared/server-reuse-policy.cjs")');
    expect(source).toContain("compareExpectedRuntimeBuild(readBuildInfo(), identity.runtimeBuild)");
    expect(source).toContain("terminate: isDesktopOwnedServerInfo(existingInfo)");
  });
});
