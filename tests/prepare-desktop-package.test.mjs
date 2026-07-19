import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareDesktopPackage } from "../scripts/prepare-desktop-package.mjs";

describe("local desktop raw runtime preparation", () => {
  it("uses the shared sign-before-smoke helper for raw macOS output", async () => {
    const signAndSmoke = vi.fn(async () => {});
    const env = { HANA_RELEASE_PROFILE: "legacy-raw" };
    const result = await prepareDesktopPackage({
      env,
      platform: "darwin",
      arch: "arm64",
      root: "/tmp/hana-package-test",
      signAndSmoke,
    });

    expect(result).toEqual({ skipped: false, outDir: "/tmp/hana-package-test/dist-server/mac-arm64" });
    expect(signAndSmoke).toHaveBeenCalledWith(
      path.join("/tmp/hana-package-test", "dist-server", "mac-arm64"),
      { env },
    );
  });

  it.each([
    [{ HANA_RELEASE_PROFILE: "signed" }, "darwin"],
    [{ HANA_RELEASE_PROFILE: "legacy-raw" }, "linux"],
  ])("skips when profile/platform is not raw macOS", async (env, platform) => {
    const signAndSmoke = vi.fn();
    await expect(prepareDesktopPackage({ env, platform, signAndSmoke })).resolves.toEqual({ skipped: true });
    expect(signAndSmoke).not.toHaveBeenCalled();
  });
});
