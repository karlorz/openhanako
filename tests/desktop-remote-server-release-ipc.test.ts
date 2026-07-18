import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Desktop remote server release IPC boundary", () => {
  it("registers one fixed main-process loader without renderer-selected network inputs", () => {
    const source = fs.readFileSync(path.join(root, "desktop/main.cjs"), "utf8");
    expect(source).toContain('require("../shared/remote-server-release-loader.cjs")');
    expect(source).toContain('wrapIpcHandler("remote-server-release:check"');
    expect(source).toContain("payload && payload.force === true");
    expect(source).not.toMatch(/remote-server-release:check[\s\S]{0,500}payload\.(repository|url|headers|token|channel|timeout)/);
  });

  it("exposes only a boolean force option through preload", () => {
    const source = fs.readFileSync(path.join(root, "desktop/preload.cjs"), "utf8");
    expect(source).toContain("checkRemoteServerRelease: (options) => ipcRenderer.invoke(");
    expect(source).toContain('"remote-server-release:check"');
    expect(source).toContain("{ force: options && options.force === true }");
  });

  it("declares the sanitized release-check result on PlatformApi", () => {
    const source = fs.readFileSync(path.join(root, "desktop/src/react/types.ts"), "utf8");
    expect(source).toContain("checkRemoteServerRelease?");
    expect(source).toContain("RemoteServerReleaseCheck");
  });
});
