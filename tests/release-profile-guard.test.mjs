import { describe, expect, it } from "vitest";
import {
  assertReleaseProfileCompatibility,
  releaseProfileMarkerName,
} from "../scripts/guard-release-profile.mjs";

describe("release profile immutability guard", () => {
  it("accepts a clean release and same-profile reruns", () => {
    expect(() => assertReleaseProfileCompatibility({ requested: "legacy-raw", assetNames: [] })).not.toThrow();
    expect(() => assertReleaseProfileCompatibility({
      requested: "legacy-raw",
      assetNames: [releaseProfileMarkerName("legacy-raw"), "HanaAgent-test-legacy-raw.dmg"],
    })).not.toThrow();
  });

  it("rejects cross-profile reruns without mutating the asset list", () => {
    const assets = [releaseProfileMarkerName("signed"), "HanaAgent-test.dmg"];
    const snapshot = [...assets];

    expect(() => assertReleaseProfileCompatibility({ requested: "legacy-raw", assetNames: assets }))
      .toThrow(/signed.*legacy-raw|legacy-raw.*signed/i);
    expect(assets).toEqual(snapshot);
  });

  it("rejects opposite-profile installer assets even when the marker matches", () => {
    expect(() => assertReleaseProfileCompatibility({
      requested: "legacy-raw",
      assetNames: [releaseProfileMarkerName("legacy-raw"), "HanaAgent-test.dmg"],
    })).toThrow(/signed.*asset|mixed|profile/i);
    expect(() => assertReleaseProfileCompatibility({
      requested: "signed",
      assetNames: [releaseProfileMarkerName("signed"), "HanaAgent-test-legacy-raw.dmg"],
    })).toThrow(/legacy-raw|mixed|profile/i);
  });

  it("rejects nonempty unmarked releases as not clean-room", () => {
    expect(() => assertReleaseProfileCompatibility({ requested: "signed", assetNames: ["unknown.dmg"] }))
      .toThrow(/marker|clean/i);
  });
});
