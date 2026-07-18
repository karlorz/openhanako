import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import buildInfoModule from "../shared/server-build-info.cjs";
import featureModule from "../shared/remote-feature-contracts.cjs";
import {
  createServerBuildInfo,
  writeServerBuildInfo,
} from "../scripts/write-server-build-info.mjs";

const { normalizeServerBuildInfo, readServerBuildInfo } = buildInfoModule;
const { SERVER_FEATURE_CONTRACTS } = featureModule;

describe("server build evidence", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("exports one complete immutable feature-contract declaration", () => {
    expect(SERVER_FEATURE_CONTRACTS).toEqual({
      schemaVersion: 1,
      complete: true,
      entries: {
        "chat.core": 1,
        "input.drafts": 1,
        "websocket.ticket": 1,
      },
    });
    expect(Object.isFrozen(SERVER_FEATURE_CONTRACTS)).toBe(true);
    expect(Object.isFrozen(SERVER_FEATURE_CONTRACTS.entries)).toBe(true);
  });

  it("creates a fork release record whose base matches package version", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-build-info-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.407.15" }));
    expect(createServerBuildInfo({
      rootDir: root,
      releaseTag: "v0.407.15-karlorz.2",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRepository: "karlorz/openhanako",
      platform: "linux",
      arch: "arm64",
    })).toEqual({
      schemaVersion: 1,
      runtimeVersion: "0.407.15",
      releaseTag: "v0.407.15-karlorz.2",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRepository: "karlorz/openhanako",
      platform: "linux",
      arch: "arm64",
    });
  });

  it("rejects plain upstream tags and base mismatch", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-build-info-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.407.15" }));
    expect(() => createServerBuildInfo({
      rootDir: root,
      releaseTag: "v0.407.15",
      gitSha: null,
      sourceRepository: "karlorz/openhanako",
      platform: "linux",
      arch: "arm64",
    })).toThrow("fork release tag");
    expect(() => createServerBuildInfo({
      rootDir: root,
      releaseTag: "v0.408.0-karlorz.1",
      gitSha: null,
      sourceRepository: "karlorz/openhanako",
      platform: "linux",
      arch: "arm64",
    })).toThrow("does not match package version 0.407.15");
  });

  it("writes and reads the normalized distribution-root record", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-build-info-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.407.15" }));
    const result = writeServerBuildInfo({
      outputRoot: root,
      rootDir: root,
      releaseTag: "v0.407.15-karlorz.1",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRepository: "karlorz/openhanako",
      platform: "linux",
      arch: "arm64",
    });
    expect(result.outputPath).toBe(path.join(root, "server-build-info.json"));
    expect(readServerBuildInfo({ rootDir: root })).toEqual(result.buildInfo);
    expect(normalizeServerBuildInfo({ ...result.buildInfo, token: "secret" })).not.toHaveProperty("token");
  });
});
