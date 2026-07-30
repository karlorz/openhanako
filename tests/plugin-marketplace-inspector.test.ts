import { describe, expect, it } from "vitest";
import {
  createMarketplaceInstallPlan,
  inspectMarketplacePackage,
} from "../lib/plugin-marketplace-inspector.ts";

describe("MarketplacePackageInspector", () => {
  it("classifies installable Claude relative packages as Hana skills", () => {
    const inspection = inspectMarketplacePackage({
      id: "skillwiki",
      install: {
        catalogFormat: "claude",
        sourceKind: "relative",
        source: "packages/skills",
        canInstall: true,
      },
    });
    expect(inspection).toMatchObject({
      destination: "hana-skills",
      installAdapter: "skill-manager",
      installable: true,
      confirmationLevel: "inline",
    });
    expect(inspection.capabilityInventory.agentFacing).toEqual(["skills"]);
    expect(createMarketplaceInstallPlan(inspection)).toMatchObject({
      action: "install",
      destination: "hana-skills",
      installAdapter: "skill-manager",
    });
  });

  it("classifies unsupported Claude source forms as inspect-only unsupported", () => {
    const inspection = inspectMarketplacePackage({
      id: "remote-plugin",
      install: {
        catalogFormat: "claude",
        sourceKind: "git-subdir",
        canInstall: false,
      },
    });
    expect(inspection).toMatchObject({
      destination: "unsupported",
      installAdapter: "none",
      installable: false,
      confirmationLevel: "capability-review",
    });
    expect(inspection.warnings[0]).toMatch(/not installable/i);
  });

  it("classifies Hana release packages as native-plugin preview-only until audit completes", () => {
    const inspection = inspectMarketplacePackage({
      id: "demo",
      trust: "restricted",
      contributions: ["tools"],
      distribution: {
        kind: "release",
        packageUrl: "https://example.com/demo.zip",
      },
    });
    expect(inspection).toMatchObject({
      destination: "native-plugin",
      installAdapter: "plugin-manager",
      installable: false,
      confirmationLevel: "capability-review",
    });
    expect(inspection.capabilityInventory.agentFacing).toEqual(["tools"]);
    expect(inspection.warnings).toContain(
      "native marketplace install is preview-only until the PluginManager contract audit is complete",
    );
  });

  it("escalates full-access server-impacting native packages to typed exact confirmation", () => {
    const inspection = inspectMarketplacePackage({
      id: "native-page",
      trust: "full-access",
      contributions: ["tools", "routes", "providers"],
      distribution: {
        kind: "release",
        packageUrl: "https://example.com/native-page.zip",
      },
    });
    expect(inspection.confirmationLevel).toBe("typed-exact");
    expect(inspection.installable).toBe(false);
    expect(inspection.capabilityInventory.serverImpact).toEqual(["routes", "providers"]);
    expect(inspection.warnings).toEqual(expect.arrayContaining([
      "native marketplace install is preview-only until the PluginManager contract audit is complete",
      "native plugin requests full-access review",
      "native plugin has server-impacting contributions: routes, providers",
    ]));
  });
});
