import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TAB_PATH = path.join(__dirname, "../../settings/tabs/PluginMarketplaceTab.tsx");
const LOCALES = ["en", "ja", "ko", "zh", "zh-TW"] as const;
const localeDir = path.join(__dirname, "../../../locales");

describe("PluginMarketplaceTab localization coverage (finding 8)", () => {
  it("introduces no new direct string literals into showToast or window.confirm calls", () => {
    const source = fs.readFileSync(TAB_PATH, "utf8");
    const offenders: string[] = [];
    for (const match of source.matchAll(/(showToast|window\.confirm)\(\s*(['"`])/g)) {
      const start = (match.index || 0) + match[0].length - 1;
      const quote = match[2];
      const end = source.indexOf(quote, start + 1);
      const literal = source.slice(start + 1, end);
      if (literal.trim()) offenders.push(literal.slice(0, 80));
    }
    expect(offenders).toEqual([]);
  });

  it("introduces no new bare JSX text nodes or attribute literals in the tab", () => {
    const source = fs.readFileSync(TAB_PATH, "utf8");
    const allowlist = new Set(["·", "unknown", "installed", "not installed", "source removed / uninstall only"]);
    // JSX text: `>text<` where text has a word character
    const jsxText = [...source.matchAll(/>\s*([A-Za-z][A-Za-z0-9 /'().-]*)\s*</g)]
      .map((m) => m[1].trim())
      .filter((text) => /[A-Za-z]{3}/.test(text));
    const bad = jsxText.filter((text) => !allowlist.has(text));
    expect([...new Set(bad)]).toEqual([]);
  });

  it("keeps identical settings.plugins key sets across all five locale files", () => {
    const keySets = LOCALES.map((loc) => {
      const json = JSON.parse(fs.readFileSync(path.join(localeDir, `${loc}.json`), "utf8"));
      return Object.keys(json.settings.plugins).sort();
    });
    for (const keys of keySets) {
      expect(keys).toEqual(keySets[0]);
    }
  });
});
