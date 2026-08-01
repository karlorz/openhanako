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
    expect(pluginsGuide).toContain("Agent Skill Toggle");
    expect(pluginsGuide).toContain("current multi-source/Agent contract");
    expect(pluginsGuide).toMatch(/preview-only|deferred/i);
    expect(pluginSdk).toMatch(/native Hana application plugins/i);
    expect(pluginSdk).toContain("current durable multi-source/Agent contract");
    expect(pluginSdk).toMatch(/preview-only|deferred/i);

    const unqualifiedNativeInstall = /every Marketplace release[\s\S]{0,100}plugin directory/i;
    expect(pluginsGuide).not.toMatch(unqualifiedNativeInstall);
    expect(pluginSdk).not.toMatch(unqualifiedNativeInstall);
  });

  it("routes Marketplace operations and native authoring to separate bundled skills", () => {
    const creator = read("skills2set/hana-plugin-creator/SKILL.md");
    const userGuide = read("skills2set/user-guide/SKILL.md");

    expectDestinationBoundary(creator);
    expect(creator).toContain("marketplace-manager");
    expect(creator).toContain("Native Hana Plugin Marketplace Publication Rules");
    expect(creator).toMatch(/default-enabled:\s*false/);

    expect(userGuide).toContain("marketplace-manager");
    expect(userGuide).toContain("Marketplace package gate");
    expect(userGuide).toContain("Agent Skill Toggle");
    expect(userGuide).toContain("Marketplace source toggle");
    expect(userGuide).toContain("native plugin toggle");
    expect(userGuide).toContain("Hana skills badge");
    expect(userGuide).toMatch(/folder|ZIP/i);
    expect(userGuide).toContain("PluginManager");
  });
});
