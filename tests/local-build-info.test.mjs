import { describe, expect, it, vi } from "vitest";

import { createLocalBuildInfo } from "../scripts/write-local-build-info.mjs";

describe("local build info", () => {
  it("prefers a release-shaped v tag when train and release tags share a commit", () => {
    const execFileSyncImpl = vi.fn((_command, args) => {
      if (args[0] === "rev-parse") return "abc123def456\n";
      if (args[0] === "describe") {
        return args.includes("--match") ? "v0.407.15\n" : "train-12\n";
      }
      if (args[0] === "status") return "";
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    });

    const buildInfo = createLocalBuildInfo({
      rootDir: process.cwd(),
      execFileSyncImpl,
      env: {},
    });

    expect(buildInfo.baseTag).toBe("v0.407.15");
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "git",
      ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"],
      expect.any(Object),
    );
  });
});
