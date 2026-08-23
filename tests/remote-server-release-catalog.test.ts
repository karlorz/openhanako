import { describe, expect, it } from "vitest";
import catalogModule from "../shared/remote-server-release-catalog.cjs";
import policy from "../shared/remote-server-policy.json";

const {
  compareForkReleaseTags,
  normalizeGithubServerRelease,
  normalizeServerCompatibilityManifest,
  normalizeServerPlatformArch,
  parseForkReleaseTag,
  parseServerAssetName,
  selectRecommendedServerRelease,
} = catalogModule;

function serverRelease(tag: string, options: {
  draft?: boolean;
  prerelease?: boolean;
  includeBundle?: boolean;
  includeSidecar?: boolean;
} = {}) {
  const includeBundle = options.includeBundle !== false;
  const includeSidecar = options.includeSidecar !== false;
  const bundle = "hanaagent-server-" + tag + "-linux-arm64.tar.gz";
  const assets = [];
  if (includeBundle) assets.push({ name: bundle, browser_download_url: "https://example.test/" + bundle });
  if (includeSidecar) assets.push({ name: bundle + ".sha256", browser_download_url: "https://example.test/" + bundle + ".sha256" });
  return {
    tag_name: tag,
    draft: options.draft === true,
    prerelease: options.prerelease !== false,
    published_at: "2026-07-18T12:00:00.000Z",
    html_url: "https://github.com/karlorz/openhanako/releases/tag/" + tag,
    assets,
  };
}

describe("fork server release catalog", () => {
  it("accepts only the numeric karlorz fork namespace", () => {
    expect(parseForkReleaseTag("v0.407.15-karlorz.2")).toEqual({
      tag: "v0.407.15-karlorz.2",
      runtimeVersion: "0.407.15",
      version: [0, 407, 15],
      forkRevision: 2,
    });
    expect(parseForkReleaseTag("v0.407.15")).toBeNull();
    expect(parseForkReleaseTag("train-13")).toBeNull();
    expect(parseForkReleaseTag("channels")).toBeNull();
    expect(parseForkReleaseTag("v0.407.15-other.1")).toBeNull();
  });

  it("orders same-base releases by numeric fork revision", () => {
    expect(compareForkReleaseTags("v0.407.15-karlorz.2", "v0.407.15-karlorz.10")).toBeLessThan(0);
    expect(compareForkReleaseTags("v0.408.0-karlorz.1", "v0.407.15-karlorz.99")).toBeGreaterThan(0);
  });

  it("parses only exact server bundle names and normalizes host aliases", () => {
    expect(parseServerAssetName("hanaagent-server-v0.407.15-karlorz.2-linux-arm64.tar.gz")).toEqual({
      tag: "v0.407.15-karlorz.2",
      platform: "linux",
      arch: "arm64",
    });
    expect(parseServerAssetName("hanaagent-server-v0.407.15-linux-arm64.tar.gz")).toBeNull();
    expect(parseServerAssetName("hanaagent-server-v0.407.15-karlorz.2-linux-arm64.zip")).toBeNull();
    expect(normalizeServerPlatformArch("darwin", "aarch64")).toEqual({ platform: "mac", arch: "arm64" });
    expect(normalizeServerPlatformArch("win32", "amd64")).toEqual({ platform: "win", arch: "x64" });
    expect(normalizeServerPlatformArch("freebsd", "x64")).toBeNull();
  });

  it("rejects drafts and unpaired server bundles", () => {
    expect(normalizeGithubServerRelease(serverRelease("v0.407.15-karlorz.1", { draft: true }), policy)).toBeNull();
    expect(normalizeGithubServerRelease(serverRelease("v0.407.15-karlorz.1", { includeSidecar: false }), policy)).toBeNull();
    expect(normalizeGithubServerRelease(serverRelease("v0.407.15-karlorz.1"), policy))
      .toMatchObject({
        tag: "v0.407.15-karlorz.1",
        runtimeVersion: "0.407.15",
        forkRevision: 1,
        assets: [{
          platform: "linux",
          arch: "arm64",
          name: "hanaagent-server-v0.407.15-karlorz.1-linux-arm64.tar.gz",
          checksumName: "hanaagent-server-v0.407.15-karlorz.1-linux-arm64.tar.gz.sha256",
        }],
      });
  });

  it("skips newer ineligible releases and selects the highest eligible fork release", () => {
    const selected = selectRecommendedServerRelease([
      serverRelease("train-99"),
      serverRelease("v0.500.0-karlorz.1", { includeSidecar: false }),
      serverRelease("v0.407.15-karlorz.10"),
      serverRelease("v0.407.15-karlorz.2"),
    ], policy);
    expect(selected?.tag).toBe("v0.407.15-karlorz.10");
  });

  it("reports stable publication drift without rejecting an eligible release", () => {
    const selected = selectRecommendedServerRelease([
      serverRelease("v0.357.17-karlorz.1", { prerelease: false }),
    ], policy);
    expect(selected).toMatchObject({
      tag: "v0.357.17-karlorz.1",
      prerelease: false,
      reasonCodes: ["release_publication_policy_drift"],
    });
  });

  it("validates a compatibility manifest only against the normalized release", () => {
    const tag = "v0.407.15-karlorz.1";
    const raw = serverRelease(tag);
    raw.assets.push({
      name: `hanaagent-server-compatibility-${tag}.json`,
      browser_download_url: `https://example.test/hanaagent-server-compatibility-${tag}.json`,
    });
    const release = normalizeGithubServerRelease(raw, policy)!;
    const bundle = `hanaagent-server-${tag}-linux-arm64.tar.gz`;
    const manifest = {
      schemaVersion: 1,
      tag,
      runtimeVersion: "0.407.15",
      sourceRepository: "karlorz/openhanako",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      featureContracts: {
        schemaVersion: 1,
        complete: true,
        entries: { "chat.core": 1, "input.drafts": 1, "websocket.ticket": 1 },
      },
      assets: {
        "linux-arm64": { bundle, checksum: `${bundle}.sha256` },
      },
    };

    expect(normalizeServerCompatibilityManifest(manifest, release)).toEqual({
      featureContracts: manifest.featureContracts,
      manifestGitSha: manifest.gitSha,
    });

    const invalidValues = [
      { ...manifest, schemaVersion: 2 },
      { ...manifest, tag: "v0.407.15-karlorz.2" },
      { ...manifest, runtimeVersion: "0.407.14" },
      { ...manifest, sourceRepository: "other/openhanako" },
      { ...manifest, gitSha: "short" },
      { ...manifest, featureContracts: { ...manifest.featureContracts, complete: false } },
      { ...manifest, featureContracts: { ...manifest.featureContracts, entries: { "Input.Drafts": 1 } } },
      { ...manifest, assets: { "linux-x64": { bundle: bundle.replace("arm64", "x64"), checksum: `${bundle.replace("arm64", "x64")}.sha256` } } },
      { ...manifest, assets: { ...manifest.assets, "linux-x64": { bundle, checksum: `${bundle}.sha256` } } },
    ];
    for (const invalid of invalidValues) {
      expect(normalizeServerCompatibilityManifest(invalid, release)).toBeNull();
    }
  });
});
