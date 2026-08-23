import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Finding-8 regression guard: Marketplace UI copy must flow through t().
 *
 * After the finding-10 decomposition moved mutation/inspector code out of
 * PluginMarketplaceTab.tsx, this canary scans every Marketplace source module
 * that emits user-facing copy. The rules are position-based (UI-copy emission
 * positions only), so status enums, identities, paths, and translation keys
 * are structurally excluded — not semantically allowlisted.
 *
 * Scanned modules and the positions they are checked in:
 *  - showToast(...)/window.confirm(...) first-argument spans (incl. the
 *    array-form `window.confirm([ ... ].join('\n'))` dialog),
 *  - array literals that feed a `.join(` (confirm/summary dialogs),
 *  - `return` statements of the label-helper functions that produce
 *    user-visible labels,
 *  - `label:` property values (inventory group labels),
 *  - `throw new Error(...)` fallbacks and `||`/`??` fallback literals in
 *    non-JSX positions (authored error/guidance framing),
 *  - `setMarketplace({ ... })` payload literals (authored guidance),
 *  - non-JSX template literals whose `${...}`-stripped text is prose
 *    (dialog lines, registry framing),
 *  - JSX-expression string literals in the extracted component modules
 *    (inspector / Manage Plugins panel).
 *
 * Deliberately excluded (data/identity/code by design):
 *  - translation keys and param values inside `t(...)` call spans,
 *  - status/version/identity enums ('not-installed', '0.0.0', ...),
 *  - API paths, status codes (all-caps tokens), CSS values, property keys,
 *  - template literals that are pure data formatting (`${a}: ${b}`),
 *  - the legacy raw JSX-expression copy in PluginMarketplaceTab.tsx, which
 *    predates this guard and is out of scope for this remediation (see the
 *    final-localization-fix report for the explicit residual list).
 */

const SCANNED: ReadonlyArray<{ rel: string; labelHelpers?: string[]; jsxExpressions?: boolean }> = [
  { rel: "settings/tabs/PluginMarketplaceTab.tsx" },
  { rel: "settings/hooks/useMarketplaceActions.ts" },
  {
    rel: "settings/hooks/useMarketplaceData.ts",
    labelHelpers: ["marketInstallLabel", "marketTargetLabel", "marketAdapterLabel", "marketConfirmationLabel"],
  },
  {
    rel: "settings/components/marketplace/MarketplacePluginInspector.tsx",
    labelHelpers: ["marketVersionStatus"],
    jsxExpressions: true,
  },
  { rel: "settings/components/plugins/ManagePluginsSkillPackagesPanel.tsx", jsxExpressions: true },
];

const ROOT = path.join(__dirname, "../../");
const LOCALES = ["en", "ja", "ko", "zh", "zh-TW"] as const;
const localeDir = path.join(__dirname, "../../../locales");

// Established non-copy fragments only — never semantic English UI prose.
const ALLOWLIST = new Set(["·", "unknown", "installed", "not installed", "source removed / uninstall only"]);

const WORD_RUN = /[A-Za-z]{3}/;
const ALL_CAPS = /^[A-Z0-9_.\-/]+$/;
const PATH_LIKE = /^[\/?'"]/;

function isCopyText(text: string): boolean {
  return !ALLOWLIST.has(text) && WORD_RUN.test(text) && !ALL_CAPS.test(text) && !PATH_LIKE.test(text);
}

/** Find balanced call spans for a callee regex, e.g. /showToast\(/g. */
function callSpans(source: string, callee: RegExp): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of source.matchAll(callee)) {
    const start = (match.index || 0) + match[0].length;
    let depth = 0;
    let i = start;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (i < source.length) spans.push([start, i]);
  }
  return spans;
}

/** First-argument span (up to the first top-level comma / close paren). */
function firstArgSpan(source: string, callStart: number, callEnd: number): [number, number] {
  let depth = 0;
  let brackets = 0;
  for (let i = callStart; i < callEnd; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) return [callStart, i];
      depth -= 1;
    } else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets -= 1;
    else if (ch === "," && depth === 0 && brackets === 0) {
      return [callStart, i];
    }
  }
  return [callStart, callEnd];
}

/** Spans of array literals that feed a `.join(` (bounded backward walk). */
function joinArraySpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of source.matchAll(/\.join\(/g)) {
    const joinPos = match.index || 0;
    let depth = 0;
    let close = -1;
    let i = joinPos - 1;
    for (; i >= 0; i -= 1) {
      const ch = source[i];
      // Statement/assignment boundaries. `==`/`!==`/`=>` inside the join
      // chain are not boundaries (check the char further back).
      if (ch === ";") break;
      if (ch === "=" && source[i - 1] !== "=" && source[i - 1] !== "!" && source[i - 1] !== ">") break;
      if (ch === "]") {
        depth += 1;
        if (close === -1) close = i;
      } else if (ch === "[") {
        depth -= 1;
        if (depth === 0 && close !== -1) {
          spans.push([i, close]);
          break;
        }
      }
    }
  }
  return spans;
}

/** Return-statement spans inside a named function body. */
function returnSpans(source: string, fnName: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const decl = new RegExp(`(?:export\\s+)?function\\s+${fnName}\\s*\\(`);
  const match = decl.exec(source);
  if (!match) return spans;
  const paramsOpen = source.indexOf("(", match.index);
  let depth = 0;
  let bodyOpen = -1;
  for (let i = paramsOpen; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        bodyOpen = source.indexOf("{", i);
        break;
      }
    }
  }
  if (bodyOpen === -1) return spans;
  depth = 0;
  let bodyClose = -1;
  for (let i = bodyOpen; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyClose = i;
        break;
      }
    }
  }
  if (bodyClose === -1) return spans;
  for (const ret of source.slice(bodyOpen, bodyClose).matchAll(/\breturn\b/g)) {
    const start = bodyOpen + (ret.index || 0);
    const semi = source.indexOf(";", start + 6);
    if (semi !== -1 && semi < bodyClose) spans.push([start, semi]);
  }
  return spans;
}

/** Spans of every `t(` call (translation keys and params are data). */
function tCallSpans(source: string): Array<[number, number]> {
  return callSpans(source, /(?<![.\w])t\(/g);
}

/** Coarse JSX regions: `{...}` expression containers only (text and attrs). */
function jsxRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let i = 0;
  let inTag = false;
  let inText = false;
  const n = source.length;
  // `<` starts a JSX tag only when not preceded by a word character
  // (`Promise<void>` generic type parameters must not flip the state machine).
  const isTagOpen = (pos: number): boolean =>
    /[A-Za-z/]/.test(source[pos + 1] || "") && !/[\w]/.test(source[pos - 1] || "");
  const recordExpr = (bracePos: number): number => {
    let depth = 1;
    let j = bracePos + 1;
    while (j < n && depth > 0) {
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") depth -= 1;
      j += 1;
    }
    regions.push([bracePos, j]);
    return j;
  };
  while (i < n) {
    const ch = source[i];
    if (!inTag && !inText) {
      if (ch === "<" && isTagOpen(i)) {
        inTag = true;
      }
      i += 1;
    } else if (inTag) {
      if (ch === "{") {
        i = recordExpr(i);
      } else if (ch === ">") {
        inTag = false;
        inText = true;
        i += 1;
      } else {
        i += 1;
      }
    } else {
      if (ch === "<") {
        if (isTagOpen(i)) {
          inTag = true;
        } else {
          inText = false;
        }
        i += 1;
      } else if (ch === "{") {
        i = recordExpr(i);
      } else {
        i += 1;
      }
    }
  }
  return regions;
}

function stripInterpolation(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "$" && text[i + 1] === "{") {
      depth += 1;
      i += 1;
    } else if (c === "}" && depth > 0) {
      depth -= 1;
    } else if (depth === 0) {
      out += c;
    }
  }
  return out;
}

interface FoundLiteral {
  text: string;      // raw literal content (escapes preserved)
  isTemplate: boolean;
  pos: number;
}

function findLiterals(source: string, start: number, end: number): FoundLiteral[] {
  const out: FoundLiteral[] = [];
  let i = start;
  while (i < end) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      let text = "";
      let interpolationDepth = 0;
      while (j < end) {
        const c = source[j];
        if (c === "\\") {
          text += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (quote === "`" && c === "$" && source[j + 1] === "{") {
          interpolationDepth += 1;
          text += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (quote === "`" && interpolationDepth > 0 && c === "}") {
          interpolationDepth -= 1;
          text += c;
          j += 1;
          continue;
        }
        if (c === quote && interpolationDepth === 0) break;
        text += c;
        j += 1;
      }
      if (j < end) out.push({ text, isTemplate: quote === "`", pos: i });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out;
}

interface ScanContext {
  source: string;
  tSpans: Array<[number, number]>;
  jsx: Array<[number, number]>;
  /** Skip property values (word-colon before the literal). */
  skipPropertyValues: boolean;
}

function inSpans(pos: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => pos >= a && pos < b);
}

function isPropertyValue(source: string, pos: number): boolean {
  // Walks back over a ternary chain to the property colon: `reason:
  // nextEnabled ? null : 'payload value'` is a property value, while dialog
  // fallbacks (`? ... : '- none'`) have no word-preceded colon before the
  // statement boundary.
  let i = pos - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  while (i >= 0) {
    const ch = source[i];
    if (ch === ";" || ch === "{" || ch === "}" || ch === "," || ch === "=") return false;
    if (ch !== ":") {
      i -= 1;
      continue;
    }
    let j = i - 1;
    while (j >= 0 && /\s/.test(source[j])) j -= 1;
    if (j >= 0 && /[\w]/.test(source[j])) return true;
    i -= 1;
  }
  return false;
}

function isPropertyKey(source: string, pos: number, literalEnd: number): boolean {
  let i = literalEnd;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== ":") return false;
  // A quoted property key sits after `{`/`,`/`;`/`(` — a ternary arm
  // (`'enabled' : 'disabled'`) sits after `?`/`:`/`||` and is scanned.
  let j = pos - 1;
  while (j >= 0 && /\s/.test(source[j])) j -= 1;
  return j >= 0 && /[{,(;]/.test(source[j]);
}

function isBracketAccess(source: string, pos: number): boolean {
  // `styles['key']` property access only — the `[` must follow an identifier
  // (array literals like `['text']` are scanned, not skipped).
  let i = pos - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (source[i] !== "[") return false;
  i -= 1;
  return i >= 0 && /[\w]/.test(source[i]);
}

function isComparisonOperand(source: string, pos: number): boolean {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  const prefix = source.slice(Math.max(0, i - 2), i + 1);
  return prefix === "===" || prefix === "!==" || prefix.slice(1) === "==" || prefix.slice(1) === "!=";
}

function isAssignmentValue(source: string, pos: number): boolean {
  // JSX attribute values (`type="button"`, `role="status"`) and comparisons.
  let i = pos - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  return source[i] === "=";
}

function classify(literal: FoundLiteral, ctx: ScanContext): "copy" | "skip" {
  if (inSpans(literal.pos, ctx.tSpans)) return "skip";
  if (literal.isTemplate) {
    const stripped = stripInterpolation(literal.text);
    return isCopyText(stripped) ? "copy" : "skip";
  }
  if (ctx.skipPropertyValues && isPropertyValue(ctx.source, literal.pos)) return "skip";
  if (isPropertyKey(ctx.source, literal.pos, literal.pos + literal.text.length + 2)) return "skip";
  if (isBracketAccess(ctx.source, literal.pos)) return "skip";
  if (isComparisonOperand(ctx.source, literal.pos)) return "skip";
  if (isAssignmentValue(ctx.source, literal.pos)) return "skip";
  return isCopyText(literal.text) ? "copy" : "skip";
}

function offendersInSpan(
  source: string,
  span: [number, number],
  ctx: ScanContext,
  out: Set<string>,
  rule: string,
  add: (rule: string, text: string) => void,
): void {
  for (const literal of findLiterals(source, span[0], span[1])) {
    if (classify(literal, ctx) === "copy") add(rule, literal.text.slice(0, 120));
  }
}

function scanFile(rel: string, cfg: { labelHelpers?: string[]; jsxExpressions?: boolean }): string[] {
  const abs = path.join(ROOT, rel);
  const source = fs.readFileSync(abs, "utf8");
  const ctx: ScanContext = {
    source,
    tSpans: tCallSpans(source),
    jsx: jsxRegions(source),
    skipPropertyValues: true,
  };
  const offenders = new Set<string>();
  const add = (rule: string, text: string) => {
    if (process.env.CANARY_DEBUG) offenders.add(`[${rule}] ${text}`);
    else offenders.add(text);
  };

  // 1. showToast / window.confirm first arguments (incl. array-form confirms).
  for (const callee of [/showToast\(/g, /window\.confirm\(/g]) {
    for (const [start, end] of callSpans(source, callee)) {
      offendersInSpan(source, firstArgSpan(source, start, end), ctx, offenders, "call", add);
    }
  }
  // 2. Array literals that feed a `.join(`.
  for (const span of joinArraySpans(source)) {
    offendersInSpan(source, span, ctx, offenders, "join", add);
  }
  // 3. Return statements of the label helpers.
  for (const fn of cfg.labelHelpers || []) {
    for (const span of returnSpans(source, fn)) {
      offendersInSpan(source, span, ctx, offenders, "return", add);
    }
  }
  // 4. `label:` property values (inventory group labels) — property-value
  //    position is the rule itself, so the property-value skip is disabled.
  for (const match of source.matchAll(/\blabel\s*:\s*(['"`])/g)) {
    const quote = match[1];
    const start = (match.index || 0) + match[0].length;
    const end = source.indexOf(quote, start);
    if (end !== -1) {
      const literal = { text: source.slice(start, end), isTemplate: quote === "`", pos: start };
      if (classify(literal, { ...ctx, skipPropertyValues: false }) === "copy") add("label", literal.text.slice(0, 120));
    }
  }
  // 5. throw new Error(...) fallback framing.
  for (const [start, end] of callSpans(source, /throw\s+new\s+Error\(/g)) {
    offendersInSpan(source, [start, end], ctx, offenders, "throw", add);
  }
  // 6. `||` / `??` / ternary fallback literals outside JSX (authored
  //    error/guidance framing and dialog fallback lines). Single-token
  //    fallbacks are enum/data values by convention ('inline', 'install',
  //    ...); multi-word prose is the flagged class.
  for (const match of source.matchAll(/(?:\|\||\?\?|[?:])\s*(['"`])/g)) {
    const quote = match[1];
    const opPos = match.index || 0;
    // Skip operators inside string/template literals (`+ ': ' +` separators,
    // `? \`template\`` arms — templates are scanned by rule 8).
    if (quote === "`") continue;
    let back = opPos - 1;
    while (back >= 0 && /\s/.test(source[back])) back -= 1;
    if (back >= 0 && /['"`]/.test(source[back])) continue;
    const start = opPos + match[0].length;
    const end = source.indexOf(quote, start);
    if (end === -1 || inSpans(start, ctx.jsx)) continue;
    const literal = { text: source.slice(start, end), isTemplate: false, pos: start - 1 };
    if (!/\s/.test(literal.text)) continue;
    if (classify(literal, ctx) === "copy") add("orfallback", literal.text.slice(0, 120));
  }
  // 7. setMarketplace({ ... }) payload literals (authored guidance; property
  //    values intentionally scanned — e.g. upgradeGuidance fallbacks).
  for (const [start, end] of callSpans(source, /setMarketplace\(/g)) {
    offendersInSpan(source, [start, end], { ...ctx, skipPropertyValues: false }, offenders, "setmarketplace", add);
  }
  // 8. Non-JSX template literals with prose after ${...} interpolation.
  for (const literal of findLiterals(source, 0, source.length)) {
    if (!literal.isTemplate) continue;
    if (inSpans(literal.pos, ctx.jsx)) continue;
    const stripped = stripInterpolation(literal.text);
    if (isCopyText(stripped)) add("template", literal.text.slice(0, 120));
  }
  // 9. JSX-expression plain literals in the extracted component modules.
  if (cfg.jsxExpressions) {
    for (const literal of findLiterals(source, 0, source.length)) {
      if (literal.isTemplate || !inSpans(literal.pos, ctx.jsx)) continue;
      if (inSpans(literal.pos, ctx.tSpans)) continue;
      if (classify(literal, ctx) === "copy") add("jsxexpr", literal.text.slice(0, 120));
    }
  }

  return [...offenders].sort();
}

describe("Marketplace localization coverage (finding 8)", () => {
  it("introduces no new raw string literals into Marketplace UI-copy positions", () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      for (const literal of scanFile(file.rel, file)) {
        offenders.push(`${file.rel}: ${JSON.stringify(literal)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("introduces no new bare JSX text nodes in the Marketplace modules", () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      const source = fs.readFileSync(path.join(ROOT, file.rel), "utf8");
      // The `>` must close a JSX tag (preceded by a tag-ish char) so arrow
      // functions (`=> Promise<...>`) and comparisons are not matched.
      const jsxText = [...source.matchAll(/(?<=[A-Za-z0-9_/"'}.-])>\s*([A-Za-z][A-Za-z0-9 /'().-]*)\s*</g)]
        .map((m) => m[1].trim())
        .filter((text) => WORD_RUN.test(text));
      const bad = jsxText.filter((text) => !ALLOWLIST.has(text));
      for (const text of [...new Set(bad)]) {
        offenders.push(`${file.rel}: ${JSON.stringify(text)}`);
      }
    }
    expect(offenders).toEqual([]);
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
