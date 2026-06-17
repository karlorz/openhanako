import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { packServerBundle } from "../scripts/pack-server-bundle.mjs";

describe("packServerBundle", () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pack-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("tars the dist-server dir into a named asset with a sha256", () => {
    const distDir = path.join(tmp, "linux-arm64");
    fs.mkdirSync(path.join(distDir, "bundle"), { recursive: true });
    fs.writeFileSync(path.join(distDir, "bundle", "index.js"), "console.log('hi')");
    fs.writeFileSync(path.join(distDir, "hana-server"), "#!/bin/sh\n");

    const result = packServerBundle(distDir, { tag: "v0.323.0-karlorz.1", os: "linux", arch: "arm64" });

    expect(result.name).toBe("hanaagent-server-v0.323.0-karlorz.1-linux-arm64.tar.gz");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(result.assetPath)).toBe(true);

    // sha256 matches an independent computation
    const independent = execSync(`sha256sum "${result.assetPath}"`).toString().split(/\s+/)[0];
    expect(result.sha256).toBe(independent);
  });

  it("produces a tarball that extracts back to the original contents", () => {
    const distDir = path.join(tmp, "mac-x64");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "marker"), "payload");

    const { assetPath } = packServerBundle(distDir, { tag: "v9", os: "mac", arch: "x64" });
    const out = path.join(tmp, "extract");
    fs.mkdirSync(out, { recursive: true });
    execSync(`tar -xzpf "${assetPath}" -C "${out}"`);
    expect(fs.readFileSync(path.join(out, "mac-x64", "marker"), "utf8")).toBe("payload");
  });

  it("rejects a missing dist-server dir", () => {
    expect(() => packServerBundle(path.join(tmp, "nope"), { tag: "v1", os: "linux", arch: "arm64" })).toThrow();
  });

  it("rejects invalid os/arch", () => {
    const distDir = path.join(tmp, "linux-arm64");
    fs.mkdirSync(distDir, { recursive: true });
    expect(() => packServerBundle(distDir, { tag: "v1", os: "solaris", arch: "arm64" })).toThrow();
    expect(() => packServerBundle(distDir, { tag: "v1", os: "linux", arch: "riscv" })).toThrow();
  });
});
