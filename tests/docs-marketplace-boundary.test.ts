import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf-8");
}

function expectDestinationBoundary(content: string) {
  expect(content).toMatch(/hana-skills[\s\S]{0,180}skill-manager/i);
  expect(content).toMatch(/native-plugin[\s\S]{0,180}PluginManager/i);
}

describe("Marketplace documentation package boundaries", () => {
  it("scopes the community guide and Plugin SDK to the correct installer owners", () => {
    const pluginsGuide = read("PLUGINS_EN.md");
    const pluginSdk = read("PLUGIN_SDK.md");

    expectDestinationBoundary(pluginsGuide);
    expectDestinationBoundary(pluginSdk);
    expect(pluginsGuide).toContain("Hana skills badge");
    expect(pluginsGuide).toContain("**Package**");
    expect(pluginsGuide).toContain("**Agent preference**");
    expect(pluginsGuide).toContain("**Effective");
    expect(pluginsGuide).toContain("current multi-source/Agent contract");
    expect(pluginsGuide).toMatch(/preview-only|deferred/i);
    expect(pluginsGuide).toMatch(/Studio owners[\s\S]{0,180}Settings[\s\S]{0,180}signed\s+plan\/execute lifecycle/i);
    expect(pluginsGuide).toMatch(/Agent-driven native installation[\s\S]{0,100}(unsupported|preview-only|deferred)/i);
    expect(pluginsGuide).toMatch(/legacy release metadata[\s\S]{0,160}(cannot|not)[\s\S]{0,80}bypass/i);
    expect(pluginSdk).toMatch(/native Hana application plugins/i);
    expect(pluginSdk).toContain("current durable multi-source/Agent contract");
    expect(pluginSdk).toMatch(/preview-only|deferred/i);
    expect(pluginSdk).toContain("Studio owners use the signed Settings plan/execute lifecycle");
    expect(pluginSdk).toMatch(/Agent-driven native installation[\s\S]{0,100}(unsupported|preview-only|deferred)/i);
    expect(pluginSdk).toMatch(/legacy release-metadata endpoint[\s\S]{0,160}cannot bypass/i);

    const unqualifiedNativeInstall = /every Marketplace release[\s\S]{0,100}plugin directory/i;
    expect(pluginsGuide).not.toMatch(unqualifiedNativeInstall);
    expect(pluginSdk).not.toMatch(unqualifiedNativeInstall);
  });

  it("routes Marketplace operations and native authoring to separate bundled skills", () => {
    const creator = read("skills2set/hana-plugin-creator/SKILL.md");
    const marketplaceManager = read("skills2set/marketplace-manager/SKILL.md");
    const userGuide = read("skills2set/user-guide/SKILL.md");

    expectDestinationBoundary(creator);
    expect(creator).toContain("marketplace-manager");
    expect(creator).toContain("Native Hana Plugin Marketplace Publication Rules");
    expect(creator).toMatch(/default-enabled:\s*false/);
    expect(creator).toMatch(/Studio[\s\S]{0,100}Settings[\s\S]{0,120}signed\s+plan\/execute lifecycle/i);
    expect(creator).toMatch(/Agent-driven native installation[\s\S]{0,100}unsupported/i);
    expect(creator).toMatch(/legacy release metadata[\s\S]{0,100}cannot[\s\S]{0,60}bypass/i);

    expectDestinationBoundary(marketplaceManager);
    expect(marketplaceManager).toMatch(/Studio-owner Settings signed plan\/execute lifecycle/i);
    expect(marketplaceManager).toMatch(/Agent-driven native install[\s\S]{0,100}unsupported/i);
    expect(marketplaceManager).toMatch(/legacy release metadata[\s\S]{0,100}bypass/i);

    expect(userGuide).toContain("marketplace-manager");
    expect(userGuide).toContain("**Package**");
    expect(userGuide).toContain("**Agent preference**");
    expect(userGuide).toContain("**Effective availability**");
    expect(userGuide).toContain("Marketplace source toggle");
    expect(userGuide).toContain("native plugin toggle");
    expect(userGuide).toContain("Hana skills badge");
    expect(userGuide).toMatch(/folder|ZIP/i);
    expect(userGuide).toContain("PluginManager");
  });
});
