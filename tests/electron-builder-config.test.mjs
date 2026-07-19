import { describe, expect, it } from "vitest";

import {
  LEGACY_RAW_PROFILE,
  SIGNED_PROFILE,
} from "../shared/release-profile.cjs";
import { createElectronBuilderConfig } from "../scripts/electron-builder-config.cjs";

function baseConfig() {
  return {
    files: ["desktop/dist-splash/**"],
    extraResources: [
      { from: "dist-server-artifact/${os}-${arch}/", to: "seed/" },
      { from: "desktop/src/assets/", to: "assets/" },
    ],
    mac: { artifactName: "${productName}-${version}-macOS-${arch}.${ext}" },
    win: { artifactName: "${productName}-${version}-Windows-${arch}.${ext}" },
    linux: { artifactName: "${productName}-${version}-Linux-${arch}.${ext}" },
  };
}

describe("electron-builder release profile config", () => {
  it("leaves the signed config's seed contract unchanged", () => {
    const input = baseConfig();
    expect(createElectronBuilderConfig({ profile: SIGNED_PROFILE, baseConfig: input })).toEqual(input);
  });

  it("switches legacy-raw to the old renderer plus Resources/server layout and marks artifacts", () => {
    const config = createElectronBuilderConfig({ profile: LEGACY_RAW_PROFILE, baseConfig: baseConfig() });

    expect(config.files).toContain("desktop/dist-renderer/**");
    expect(config.extraResources).toContainEqual({
      from: "dist-server/${os}-${arch}/",
      to: "server/",
    });
    expect(config.extraResources).not.toContainEqual(expect.objectContaining({ to: "seed/" }));
    expect(config.mac.artifactName).toContain("-legacy-raw.");
    expect(config.win.artifactName).toContain("-legacy-raw.");
    expect(config.linux.artifactName).toContain("-legacy-raw.");
  });
});
