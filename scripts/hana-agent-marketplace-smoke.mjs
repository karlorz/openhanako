import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { reduceCliChatStreamIdentity } from "../cli/chat.ts";
import { redactSecretsFromText } from "../lib/secret-fingerprint.ts";

const REQUIRED_ACTIONS = [
  "list_sources",
  "add_source",
  "refresh_source",
  "set_source_enabled",
  "set_source_enabled",
  "list_catalog",
  "inspect_package",
  "plan_install",
  "install",
  "list_installed_packages",
  "set_package_enabled",
  "set_package_enabled",
  "plan_uninstall",
  "uninstall",
  "remove_source",
];

const REVIEWED_MUTATION_ACTIONS = new Set([
  "add_source",
  "refresh_source",
  "set_source_enabled",
  "set_package_enabled",
  "install",
  "uninstall",
  "remove_source",
]);

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function redactSecrets(value, secrets = []) {
  return redactSecretsFromText(typeof value === "string" ? value : stableJson(value), secrets);
}

export function fixtureSpec(permissionMode) {
  if (permissionMode !== "auto" && permissionMode !== "operate") {
    throw new Error(`Unsupported smoke permission mode: ${permissionMode}`);
  }
  const id = `codex-agent-smoke-${permissionMode}`;
  return {
    permissionMode,
    sourceId: id,
    pluginId: id,
    identity: `${id}@${id}`,
    skillName: `${id}-skill`,
    sourceInput: `./${id}`,
  };
}

export function assertContainedCleanupTarget(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing unsafe fixture cleanup target: ${target}`);
  }
  return target;
}

export function writeMarketplaceFixture(localRoot, spec) {
  fs.mkdirSync(localRoot, { recursive: true });
  const sourceDir = assertContainedCleanupTarget(localRoot, path.join(localRoot, spec.sourceId));
  if (fs.existsSync(sourceDir)) throw new Error(`Fixture source already exists: ${spec.sourceId}`);
  const catalogDir = path.join(sourceDir, ".claude-plugin");
  const skillDir = path.join(sourceDir, "packages", "skills", spec.skillName);
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(catalogDir, "marketplace.json"), JSON.stringify({
    name: spec.sourceId,
    owner: { name: "codex-smoke" },
    plugins: [{
      name: spec.pluginId,
      version: "1.0.0",
      description: `Harmless disposable ${spec.permissionMode} Marketplace fixture`,
      source: "./packages/skills",
    }],
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---",
    `name: ${spec.skillName}`,
    "description: harmless disposable marketplace smoke fixture",
    "---",
    "",
    `# ${spec.skillName}`,
    "",
  ].join("\n"), "utf8");
  return sourceDir;
}

export function buildLifecyclePrompt(spec) {
  return [
    "Use only the plugin_marketplace tool for this task.",
    "Do not use shell, exec, HTTP tools, browser tools, Computer Use, or any other tool.",
    `This is a harmless disposable local fixture for permission mode ${spec.permissionMode}.`,
    `Source input: ${spec.sourceInput}`,
    `Exact source id: ${spec.sourceId}`,
    `Exact plugin id: ${spec.pluginId}`,
    `Exact package identity: ${spec.identity}`,
    `Authorized local source root: ${spec.authorizedSourceRoot || "the current workspace"}`,
    `Authorized Hana skills root: ${spec.authorizedSkillsRoot || "the declared skills workspace"}`,
    "The user explicitly authorizes only the exact disposable source and package lifecycle listed below within those two roots.",
    "For every mutation, use the latest registry revision and digest returned by the preceding plugin_marketplace result.",
    "Perform this exact lifecycle in order:",
    "1. list_sources",
    "2. add_source with the source input above plus expectedRevision and expectedDigest from list_sources",
    "3. refresh_source for the exact source id plus expectedRevision and expectedDigest returned by add_source",
    "4. set_source_enabled false using expectedRevision and expectedDigest returned by refresh_source, then set_source_enabled true using the preconditions returned by the false toggle",
    "5. list_catalog and inspect_package for the exact source-qualified package",
    "6. plan_install, then install with its exact plan token",
    "7. list_installed_packages",
    "8. set_package_enabled false using the latest expectedRevision and expectedDigest, then set_package_enabled true using the preconditions returned by the false toggle",
    "9. plan_uninstall, then uninstall with its exact plan token plus the latest expectedRevision and expectedDigest",
    "10. remove_source using expectedRevision and expectedDigest returned by uninstall",
    "If automatic review rejects or is unavailable, fail closed and report it. Never bypass review or change permission mode.",
    "Finish with a concise success/failure summary.",
  ].join("\n");
}

function toolCallBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) =>
    block && (block.type === "toolCall" || block.type === "tool_use") && typeof block.name === "string");
}

export function extractMarketplaceTrace(branchEntries) {
  const results = new Map();
  for (const entry of branchEntries || []) {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, message);
    }
  }
  const calls = [];
  for (const entry of branchEntries || []) {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role !== "assistant") continue;
    for (const block of toolCallBlocks(message.content)) {
      const args = block.arguments || block.input || {};
      const result = typeof block.id === "string" ? results.get(block.id) || null : null;
      calls.push({
        id: block.id || null,
        name: block.name,
        action: typeof args?.action === "string" ? args.action : null,
        args,
        result,
        success: !!result && result.isError !== true,
        confirmation: result?.details?.confirmation || null,
      });
    }
  }
  return calls;
}

export function branchHasFinalAssistantResponse(branchEntries) {
  const assistantMessages = (branchEntries || [])
    .map((entry) => entry?.type === "message" ? entry.message : null)
    .filter((message) => message?.role === "assistant");
  const lastAssistant = assistantMessages.at(-1);
  return !!lastAssistant && lastAssistant.stopReason !== "toolUse";
}

export function assertLifecycleTrace(trace, permissionMode) {
  if (permissionMode !== "auto" && permissionMode !== "operate") {
    throw new Error(`Unsupported smoke permission mode: ${permissionMode}`);
  }
  const forbidden = trace.filter((call) => call.name !== "plugin_marketplace");
  if (forbidden.length > 0) {
    throw new Error(`Forbidden tool calls during Marketplace smoke: ${forbidden.map((call) => call.name).join(", ")}`);
  }
  const actual = trace.map((call) => call.action).filter(Boolean);
  let cursor = 0;
  for (const expected of REQUIRED_ACTIONS) {
    const index = actual.indexOf(expected, cursor);
    if (index < 0) throw new Error(`Missing ordered plugin_marketplace action ${expected}; saw ${actual.join(", ")}`);
    cursor = index + 1;
  }
  const failed = trace.filter((call) => !call.result || call.success !== true);
  if (failed.length > 0) {
    throw new Error(`plugin_marketplace failures or missing results: ${failed.map((call) => call.action).join(", ")}`);
  }
  const mutations = trace.filter((call) => REVIEWED_MUTATION_ACTIONS.has(call.action));
  if (permissionMode === "operate") {
    const reviewed = mutations.filter((call) => call.confirmation);
    if (reviewed.length > 0) {
      throw new Error(`operate mode unexpectedly recorded review evidence for: ${reviewed.map((call) => call.action).join(", ")}`);
    }
  }
  return {
    kind: permissionMode === "auto" ? "automatic-review-enforced" : "full-session-access",
    successfulReviewedMutations: mutations.map((call) => call.action),
  };
}

export function assertPersistedSessionEvidence(metadata, permissionMode, authorizedFolders) {
  if (!metadata || metadata.permissionMode !== permissionMode) {
    throw new Error(`Persisted smoke permission mode mismatch: expected ${permissionMode}, got ${metadata?.permissionMode || "missing"}`);
  }
  if (metadata.accessMode !== "operate") {
    throw new Error(`Persisted smoke access mode mismatch: expected operate, got ${metadata.accessMode || "missing"}`);
  }
  const expected = [...authorizedFolders].map((folder) => path.resolve(folder)).sort();
  const actual = [...(metadata.authorizedFolders || [])].map((folder) => path.resolve(folder)).sort();
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`Persisted smoke authorized folders mismatch: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  }
  if ((metadata.workspaceFolders || []).length !== 0) {
    throw new Error(`Detached smoke unexpectedly persisted workspace folders: ${metadata.workspaceFolders.join(", ")}`);
  }
  return {
    permissionMode: metadata.permissionMode,
    accessMode: metadata.accessMode,
    authorizedFolders: actual,
  };
}

function readPersistedSessionMetadata(hanaHome, sessionPath) {
  const metaPath = path.join(hanaHome, "agents", "hanako", "sessions", "session-meta.json");
  const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  return metadata[path.basename(sessionPath)] || null;
}

function readServerInfo(hanaHome) {
  const filePath = path.join(hanaHome, "server-info.json");
  const info = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Number.isInteger(info.port) || !info.token) throw new Error(`Invalid server info: ${filePath}`);
  return { baseUrl: `http://127.0.0.1:${info.port}`, token: info.token };
}

async function api(connection, pathname, options = {}) {
  const response = await fetch(`${connection.baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const err = new Error(`${options.method || "GET"} ${pathname} failed (${response.status}): ${redactSecrets(body, [connection.token])}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function snapshotState(connection) {
  const [sources, inventory, nativePlugins] = await Promise.all([
    api(connection, "/api/plugins/marketplace/sources"),
    api(connection, "/api/plugins/marketplace/installed-skill-packages"),
    api(connection, "/api/plugins"),
  ]);
  return { sources, inventory, nativePlugins };
}

function assertNoFixtureCollision(state, specs, hanaHome) {
  for (const spec of specs) {
    if (state.sources?.sources?.some((source) => source.id === spec.sourceId)) {
      throw new Error(`Marketplace source collision: ${spec.sourceId}`);
    }
    if (state.inventory?.packages?.some((pkg) => pkg.identity === spec.identity)) {
      throw new Error(`Marketplace package collision: ${spec.identity}`);
    }
    if (fs.existsSync(path.join(hanaHome, "skills", spec.skillName))) {
      throw new Error(`Marketplace skill collision: ${spec.skillName}`);
    }
  }
}

async function createDetachedSession(connection, permissionMode, cwd, workspaceFolders = [cwd]) {
  return api(connection, "/api/sessions/new-detached", {
    method: "POST",
    body: JSON.stringify({
      cwd,
      workspaceFolders,
      memoryEnabled: false,
      recordWorkspaceHistory: false,
      permissionMode,
    }),
  });
}

async function authorizeSessionFolders(connection, session, folders) {
  const scope = await api(connection, "/api/sessions/authorized-folders", {
    method: "PATCH",
    body: JSON.stringify({
      path: session.path,
      action: "set",
      folders,
    }),
  });
  const authorized = new Set(scope?.authorizedFolders || []);
  const missing = folders.filter((folder) => !authorized.has(folder));
  if (missing.length > 0) {
    throw new Error(`Detached smoke session missing authorized folders: ${missing.join(", ")}`);
  }
  return scope;
}

async function runPrompt(connection, session, prompt, timeoutMs = 10 * 60_000) {
  const wsUrl = new URL(connection.baseUrl.replace(/^http/, "ws"));
  wsUrl.pathname = "/ws";
  wsUrl.searchParams.set("token", connection.token);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 10_000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket open failed")); }, { once: true });
  });
  let identity = {
    sessionId: session.sessionId,
    sessionPath: session.path,
    streamId: null,
    isStreaming: false,
  };
  let seenStreaming = false;
  const events = [];
  const terminal = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hana turn timeout after ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()); } catch { return; }
      events.push(message);
      identity = reduceCliChatStreamIdentity(identity, message);
      if (identity.isStreaming) seenStreaming = true;
      if (message.type === "error" && seenStreaming) {
        clearTimeout(timer);
        reject(new Error(message.message || "Hana turn failed"));
      } else if (message.type === "turn_end" && seenStreaming && !identity.isStreaming) {
        const branch = SessionManager.open(session.path, path.dirname(session.path)).getBranch();
        if (branchHasFinalAssistantResponse(branch)) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  ws.send(JSON.stringify({
    type: "prompt",
    text: prompt,
    sessionId: session.sessionId,
    sessionPath: session.path,
  }));
  try {
    await terminal;
  } finally {
    ws.close();
  }
  return events;
}

async function recoverFixture(connection, spec, localRoot) {
  let state = await snapshotState(connection);
  if (state.inventory?.packages?.some((pkg) => pkg.identity === spec.identity)) {
    const registry = state.inventory.registry;
    await api(connection, `/api/plugins/marketplace/${encodeURIComponent(spec.pluginId)}/skills`, {
      method: "DELETE",
      body: JSON.stringify({
        marketplaceId: spec.sourceId,
        expectedRevision: registry.revision,
        expectedDigest: registry.digest,
      }),
    }).catch(() => null);
    state = await snapshotState(connection);
  }
  if (state.sources?.sources?.some((source) => source.id === spec.sourceId)) {
    const registry = state.sources.registry;
    const query = new URLSearchParams({
      expectedRevision: String(registry.revision),
      expectedDigest: registry.digest,
    });
    await api(connection, `/api/plugins/marketplace/sources/${encodeURIComponent(spec.sourceId)}?${query}`, {
      method: "DELETE",
    }).catch(() => null);
  }
  const sourceDir = assertContainedCleanupTarget(localRoot, path.join(localRoot, spec.sourceId));
  fs.rmSync(sourceDir, { recursive: true, force: true });
}

export async function runMarketplaceSmoke(options = {}) {
  const hanaHome = path.resolve(options.hanaHome || process.env.HANA_HOME || path.join(os.homedir(), ".hanako"));
  const repoRoot = path.resolve(options.repoRoot || path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
  const localRoot = path.join(hanaHome, "plugin-marketplaces-local");
  const skillsRoot = path.join(hanaHome, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  const connection = readServerInfo(hanaHome);
  const specs = [fixtureSpec("auto"), fixtureSpec("operate")].map((spec) => ({
    ...spec,
    authorizedSourceRoot: localRoot,
    authorizedSkillsRoot: skillsRoot,
  }));
  const baseline = await snapshotState(connection);
  assertNoFixtureCollision(baseline, specs, hanaHome);
  const evidence = [];

  try {
    for (const spec of specs) writeMarketplaceFixture(localRoot, spec);
    for (const spec of specs) {
      const session = await createDetachedSession(connection, spec.permissionMode, repoRoot, []);
      await authorizeSessionFolders(connection, session, [localRoot, skillsRoot]);
      await runPrompt(connection, session, buildLifecyclePrompt(spec), options.timeoutMs);
      const branch = SessionManager.open(session.path, path.dirname(session.path)).getBranch();
      const trace = extractMarketplaceTrace(branch);
      const reviewEvidence = assertLifecycleTrace(trace, spec.permissionMode);
      const sessionEvidence = assertPersistedSessionEvidence(
        readPersistedSessionMetadata(hanaHome, session.path),
        spec.permissionMode,
        [localRoot, skillsRoot],
      );
      evidence.push({
        permissionMode: spec.permissionMode,
        sessionId: session.sessionId,
        sessionPath: session.path,
        accessMode: sessionEvidence.accessMode,
        authorizedFolders: sessionEvidence.authorizedFolders,
        reviewEvidence,
        actions: trace.map((call) => call.action),
        confirmations: trace.filter((call) => call.confirmation).map((call) => ({
          action: call.action,
          confirmation: call.confirmation,
        })),
      });
    }

    const finalState = await snapshotState(connection);
    for (const spec of specs) {
      if (finalState.sources?.sources?.some((source) => source.id === spec.sourceId)) throw new Error(`Source residue: ${spec.sourceId}`);
      if (finalState.inventory?.packages?.some((pkg) => pkg.identity === spec.identity)) throw new Error(`Package residue: ${spec.identity}`);
      if (fs.existsSync(path.join(hanaHome, "skills", spec.skillName))) throw new Error(`Skill residue: ${spec.skillName}`);
    }
    if (stableJson(finalState.nativePlugins) !== stableJson(baseline.nativePlugins)) {
      throw new Error("Native PluginManager inventory changed during Marketplace skill-package smoke");
    }
    if (stableJson(finalState.inventory?.activations || {}) !== stableJson(baseline.inventory?.activations || {})) {
      throw new Error("Marketplace activation maps were not restored after smoke lifecycle");
    }
    return { ok: true, evidence };
  } finally {
    for (const spec of specs) await recoverFixture(connection, spec, localRoot);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMarketplaceSmoke()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((err) => {
      process.stderr.write(`${redactSecrets(err?.stack || err?.message || String(err))}\n`);
      process.exitCode = 1;
    });
}
