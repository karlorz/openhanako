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

  it("rejects signed updater and train artifacts on a marked legacy-raw rerun", () => {
    for (const forbiddenAsset of [
      "latest.yml",
      "latest-mac.yml",
      "HanaAgent-test.dmg.blockmap",
      "server-v0.407.15-linux-x64.tar.gz",
      "renderer-v0.407.15.tar.gz",
      "seed-train.json",
    ]) {
      expect(() => assertReleaseProfileCompatibility({
        requested: "legacy-raw",
        assetNames: [releaseProfileMarkerName("legacy-raw"), forbiddenAsset],
      }), forbiddenAsset).toThrow(/legacy-raw|forbidden|mixed|profile/i);
    }
  });

  it("allows standalone server bundles on a marked legacy-raw rerun", () => {
    expect(() => assertReleaseProfileCompatibility({
      requested: "legacy-raw",
      assetNames: [
        releaseProfileMarkerName("legacy-raw"),
        "hanaagent-server-v0.407.15-linux-x64.tar.gz",
        "hanaagent-server-v0.407.15-linux-x64.tar.gz.sha256",
      ],
    })).not.toThrow();
  });

  it("rejects nonempty unmarked releases as not clean-room", () => {
    expect(() => assertReleaseProfileCompatibility({ requested: "signed", assetNames: ["unknown.dmg"] }))
      .toThrow(/marker|clean/i);
  });
});
