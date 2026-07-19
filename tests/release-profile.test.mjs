import { describe, expect, it } from "vitest";

import {
  LEGACY_RAW_PROFILE,
  SIGNED_PROFILE,
  normalizeReleaseProfile,
  resolveServerBuildMode,
} from "../shared/release-profile.cjs";

describe("release profile contract", () => {
  it("defaults to the fail-closed signed profile", () => {
    expect(normalizeReleaseProfile()).toBe(SIGNED_PROFILE);
    expect(normalizeReleaseProfile(" ")).toBe(SIGNED_PROFILE);
  });

  it("accepts only the explicit legacy raw profile", () => {
    expect(normalizeReleaseProfile(LEGACY_RAW_PROFILE)).toBe(LEGACY_RAW_PROFILE);
    expect(() => normalizeReleaseProfile("unsigned"))
      .toThrow(/release profile/i);
  });

  it("selects runtime-only server output only when explicitly requested", () => {
    expect(resolveServerBuildMode({})).toBe("seed");
    expect(resolveServerBuildMode({ HANA_RELEASE_PROFILE: LEGACY_RAW_PROFILE })).toBe("runtime-only");
    expect(resolveServerBuildMode({ HANA_SERVER_BUILD_MODE: "runtime-only" })).toBe("runtime-only");
    expect(() => resolveServerBuildMode({ HANA_SERVER_BUILD_MODE: "raw-but-unknown" }))
      .toThrow(/HANA_SERVER_BUILD_MODE/);
  });
});
