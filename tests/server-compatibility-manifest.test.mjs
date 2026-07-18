import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildServerCompatibilityManifest,
  writeServerCompatibilityManifest,
} from "../scripts/build-server-compatibility-manifest.mjs";

const TAG = "v0.407.15-karlorz.1";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CONTRACTS = {
  schemaVersion: 1,
  complete: true,
  entries: { "chat.core": 1, "input.drafts": 1, "websocket.ticket": 1 },
};
const roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-manifest-"));
  roots.push(root);
  return root;
}

function writePair(root, platform, arch, tag = TAG, directory = "") {
  const dir = path.join(root, directory);
  fs.mkdirSync(dir, { recursive: true });
  const bundle = `hanaagent-server-${tag}-${platform}-${arch}.tar.gz`;
  fs.writeFileSync(path.join(dir, bundle), "bundle");
  fs.writeFileSync(path.join(dir, `${bundle}.sha256`), `${"a".repeat(64)}  ${bundle}\n`);
  return bundle;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("server compatibility manifest", () => {
  it("builds deterministic evidence from checksum-paired server assets", () => {
    const root = makeRoot();
    const arm64 = writePair(root, "linux", "arm64", TAG, "arm64-artifact");
    const x64 = writePair(root, "linux", "x64", TAG, "x64-artifact");

    expect(buildServerCompatibilityManifest({
      artifactsDir: root,
      tag: TAG,
      gitSha: SHA,
      sourceRepository: "karlorz/openhanako",
    })).toEqual({
      schemaVersion: 1,
      tag: TAG,
      runtimeVersion: "0.407.15",
      sourceRepository: "karlorz/openhanako",
      gitSha: SHA,
      featureContracts: CONTRACTS,
      assets: {
        "linux-arm64": { bundle: arm64, checksum: `${arm64}.sha256` },
        "linux-x64": { bundle: x64, checksum: `${x64}.sha256` },
      },
    });
  });

  it("writes two-space JSON plus newline to the exact requested path", () => {
    const root = makeRoot();
    writePair(root, "linux", "arm64");
    const outputPath = path.join(root, `hanaagent-server-compatibility-${TAG}.json`);

    const result = writeServerCompatibilityManifest({
      artifactsDir: root,
      outputPath,
      tag: TAG,
      gitSha: SHA,
      sourceRepository: "karlorz/openhanako",
    });

    expect(result.outputPath).toBe(outputPath);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(`${JSON.stringify(result.manifest, null, 2)}\n`);
  });

  it("rejects invalid tags, base mismatches, repositories, SHAs, and registries", () => {
    const root = makeRoot();
    writePair(root, "linux", "arm64");
    const base = { artifactsDir: root, tag: TAG, gitSha: SHA, sourceRepository: "karlorz/openhanako" };

    expect(() => buildServerCompatibilityManifest({ ...base, tag: "v0.407.15" })).toThrow(/fork release tag/i);
    expect(() => buildServerCompatibilityManifest({ ...base, gitSha: "short" })).toThrow(/git sha/i);
    expect(() => buildServerCompatibilityManifest({ ...base, sourceRepository: "not-a-repository" })).toThrow(/repository/i);
    expect(() => buildServerCompatibilityManifest({ ...base, featureContracts: { schemaVersion: 1 } })).toThrow(/feature contracts/i);
  });

  it("rejects missing sidecars, wrong tags, and duplicate platform architecture pairs", () => {
    const root = makeRoot();
    const unpaired = `hanaagent-server-${TAG}-linux-arm64.tar.gz`;
    fs.writeFileSync(path.join(root, unpaired), "bundle");
    expect(() => buildServerCompatibilityManifest({
      artifactsDir: root,
      tag: TAG,
      gitSha: SHA,
      sourceRepository: "karlorz/openhanako",
    })).toThrow(/checksum-paired/i);

    fs.writeFileSync(path.join(root, `${unpaired}.sha256`), "sidecar");
    writePair(root, "linux", "x64", "v0.407.14-karlorz.1", "wrong-tag");
    expect(() => buildServerCompatibilityManifest({
      artifactsDir: root,
      tag: TAG,
      gitSha: SHA,
      sourceRepository: "karlorz/openhanako",
    })).toThrow(/asset tag/i);

    fs.rmSync(path.join(root, "wrong-tag"), { recursive: true, force: true });
    writePair(root, "linux", "arm64", TAG, "duplicate");
    expect(() => buildServerCompatibilityManifest({
      artifactsDir: root,
      tag: TAG,
      gitSha: SHA,
      sourceRepository: "karlorz/openhanako",
    })).toThrow(/duplicate/i);
  });

  it("rejects an orphan checksum sidecar for the selected release", () => {
    const root = makeRoot();
    writePair(root, "linux", "arm64");
    const orphanBundle = `hanaagent-server-${TAG}-linux-x64.tar.gz`;
    fs.writeFileSync(path.join(root, `${orphanBundle}.sha256`), "sidecar");

    expect(() => buildServerCompatibilityManifest({
      artifactsDir: root,
      tag: TAG,
      gitSha: SHA,
      sourceRepository: "karlorz/openhanako",
    })).toThrow(/checksum-paired/i);
  });

  it("rejects matching symlinks and non-file assets", () => {
    const root = makeRoot();
    const bundle = writePair(root, "linux", "arm64", TAG, "real");
    fs.symlinkSync(path.join(root, "real", bundle), path.join(root, bundle));
    expect(() => buildServerCompatibilityManifest({
      artifactsDir: root,
      tag: TAG,
      gitSha: SHA,
      sourceRepository: "karlorz/openhanako",
    })).toThrow(/symlink/i);

    fs.unlinkSync(path.join(root, bundle));
    fs.mkdirSync(path.join(root, bundle));
    expect(() => buildServerCompatibilityManifest({
      artifactsDir: root,
      tag: TAG,
      gitSha: SHA,
      sourceRepository: "karlorz/openhanako",
    })).toThrow(/regular file/i);
  });
});
