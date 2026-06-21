#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import WebSocket from "ws";

export const STORAGE_KEY = "hana-server-connections-v1";
const DEFAULT_APP_PATH = "/Applications/HanaAgent.app";
const DEFAULT_PORT = 14592;
const DEFAULT_URL = "http://100.125.173.118:14500";
const DEFAULT_USER_DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "Hanako");
const RELOAD_SETTLE_MS = 800;
const VERIFY_RETRY_DELAY_MS = 500;

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

// Keep these Node-side connection normalizers aligned with the copies embedded
// in rendererResetExpression below. Work item:
// 2026-06-22-hana-desktop-smoke-helper-followups.
function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function normalizeConnectionKind(value, hostname) {
  if (value === "custom_remote" || value === "relay" || value === "cloud") return value;
  if (value === "local" && isLoopbackHost(hostname)) return "local";
  return "lan";
}

function normalizeTrustState(value, kind) {
  if (kind === "custom_remote" || kind === "relay") return "tunnel";
  if (kind === "cloud") return "cloud";
  if (kind === "local") return "local";
  if (value === "local" || value === "lan" || value === "tunnel" || value === "cloud") return value;
  return "lan";
}

export function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error("server URL required");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("server URL must use http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname === "/mobile" || pathname === "/desktop" ? "/" : pathname || "/";
  return trimTrailingSlash(parsed.toString());
}

function wsUrlForBaseUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return trimTrailingSlash(parsed.toString());
}

function normalizeCapabilities(value) {
  return Array.isArray(value) ? [...value] : ["chat"];
}

export function buildConnectionFromProbe({ baseUrl, credential, identity }) {
  const base = normalizeBaseUrl(baseUrl);
  const parsed = new URL(base);
  const serverId = identity?.serverId || parsed.host;
  const serverNodeId = identity?.serverNodeId || serverId;
  const studioId = identity?.studioId || "default";
  const kind = normalizeConnectionKind(identity?.connectionKind, parsed.hostname);
  return {
    connectionId: `${kind}:${serverNodeId}:${studioId}`,
    kind,
    serverId,
    serverNodeId,
    ...(identity?.serverNodeKind !== undefined ? { serverNodeKind: identity.serverNodeKind } : {}),
    ...(identity?.serverNodeTransport !== undefined ? { serverNodeTransport: identity.serverNodeTransport } : {}),
    ...(identity?.userId !== undefined ? { userId: identity.userId } : {}),
    studioId,
    label: identity?.studioLabel || identity?.label || "Hana Studio",
    ...(identity?.userLabel !== undefined ? { userLabel: identity.userLabel } : {}),
    ...(identity?.studioLabel !== undefined ? { studioLabel: identity.studioLabel } : {}),
    ...(identity?.version !== undefined ? { serverVersion: identity.version } : {}),
    baseUrl: base,
    wsUrl: wsUrlForBaseUrl(base),
    token: String(credential || ""),
    authState: identity?.authState || "paired",
    trustState: normalizeTrustState(identity?.trustState, kind),
    credentialKind: "device_credential",
    platformAccountId: identity?.platformAccountId ?? null,
    officialServiceKind: identity?.officialServiceKind ?? null,
    ...(identity?.executionBoundary !== undefined ? { executionBoundary: identity.executionBoundary } : {}),
    capabilities: normalizeCapabilities(identity?.capabilities),
  };
}

function parsePersistedConnectionState(raw) {
  if (!raw) return { schemaVersion: 1, serverConnections: {}, activeServerConnectionId: null };
  const parsed = JSON.parse(raw);
  return {
    schemaVersion: 1,
    serverConnections: parsed?.serverConnections && typeof parsed.serverConnections === "object"
      ? parsed.serverConnections
      : {},
    activeServerConnectionId: typeof parsed?.activeServerConnectionId === "string"
      ? parsed.activeServerConnectionId
      : null,
  };
}

function findConnectionForBaseUrl(state, baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  for (const connection of Object.values(state.serverConnections || {})) {
    if (!connection || connection.kind === "local" || !connection.baseUrl) continue;
    try {
      if (normalizeBaseUrl(connection.baseUrl) === normalized) return connection;
    } catch {
      // Ignore malformed stale entries.
    }
  }
  return null;
}

export function createRestoredConnectionState(raw, { baseUrl, connection } = {}) {
  const previous = parsePersistedConnectionState(raw);
  const selected = connection || findConnectionForBaseUrl(previous, baseUrl);
  if (!selected?.connectionId) {
    throw new Error(`no saved non-local connection found for ${normalizeBaseUrl(baseUrl)}`);
  }
  return {
    schemaVersion: 1,
    serverConnections: {
      [selected.connectionId]: selected,
    },
    activeServerConnectionId: selected.connectionId,
  };
}

function summarizeConnection(connection) {
  return {
    connectionId: connection.connectionId,
    kind: connection.kind,
    baseUrl: connection.baseUrl,
    wsUrl: connection.wsUrl,
    credentialKind: connection.credentialKind,
    hasToken: Boolean(connection.token),
  };
}

export function summarizePersistedConnectionState(raw) {
  const state = parsePersistedConnectionState(raw);
  return {
    activeServerConnectionId: state.activeServerConnectionId,
    connections: Object.values(state.serverConnections || {})
      .filter(Boolean)
      .map(summarizeConnection),
  };
}

function readBalancedObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

export function extractPersistedConnectionStates(text) {
  const marker = "{\"schemaVersion\":1,\"serverConnections\":";
  const states = [];
  let searchIndex = 0;
  while (searchIndex < text.length) {
    const startIndex = text.indexOf(marker, searchIndex);
    if (startIndex === -1) break;
    const raw = readBalancedObject(text, startIndex);
    if (!raw) {
      searchIndex = startIndex + marker.length;
      continue;
    }
    try {
      states.push(parsePersistedConnectionState(raw));
    } catch {
      // Ignore stale or partial LevelDB fragments.
    }
    searchIndex = startIndex + raw.length;
  }
  return states;
}

function readHistoricalConnectionStates(userDataDir = DEFAULT_USER_DATA_DIR) {
  const levelDbDir = path.join(userDataDir, "Local Storage", "leveldb");
  if (!fs.existsSync(levelDbDir)) return [];
  const states = [];
  for (const entry of fs.readdirSync(levelDbDir)) {
    if (!/\.(log|ldb)$/.test(entry)) continue;
    const filePath = path.join(levelDbDir, entry);
    try {
      states.push(...extractPersistedConnectionStates(fs.readFileSync(filePath, "utf8")));
    } catch {
      // Ignore unreadable files while Electron owns the LevelDB lock.
    }
  }
  return states;
}

function findHistoricalConnection({ userDataDir, baseUrl }) {
  const states = readHistoricalConnectionStates(userDataDir);
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const connection = findConnectionForBaseUrl(states[index], baseUrl);
    if (connection) return connection;
  }
  return null;
}

function parseArgs(argv) {
  const options = {
    appPath: DEFAULT_APP_PATH,
    port: DEFAULT_PORT,
    baseUrl: DEFAULT_URL,
    token: process.env.HANA_DESKTOP_SMOKE_TOKEN || process.env.HANA_DEVICE_KEY || "",
    restart: false,
    timeoutMs: 15000,
    userDataDir: DEFAULT_USER_DATA_DIR,
    verify: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--app") options.appPath = requireValue(argv, ++i, arg);
    else if (arg === "--port") options.port = Number(requireValue(argv, ++i, arg));
    else if (arg === "--url") options.baseUrl = requireValue(argv, ++i, arg);
    else if (arg === "--token") options.token = requireValue(argv, ++i, arg);
    else if (arg === "--user-data-dir") options.userDataDir = requireValue(argv, ++i, arg);
    else if (arg === "--restart") options.restart = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--timeout-ms") options.timeoutMs = Number(requireValue(argv, ++i, arg));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("--port must be a valid TCP port");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function usage() {
  return `HanaAgent desktop smoke helper

Usage:
  node scripts/hana-desktop-smoke-helper.mjs --restart --verify [--url ${DEFAULT_URL}]
  HANA_DESKTOP_SMOKE_TOKEN=<device-key> node scripts/hana-desktop-smoke-helper.mjs --restart --verify --url ${DEFAULT_URL}

What it does:
  1. Optionally restarts /Applications/HanaAgent.app with Chromium remote debugging.
  2. Reads the existing HanaAgent renderer localStorage connection registry.
  3. If needed, recovers the target LAN connection from Electron Local Storage history.
  4. Clears localStorage, restores only the target LAN connection, and reloads.
  5. With --verify, confirms token-auth identity fetch and WebSocket open from the renderer.

If no saved connection exists for --url, pass --token or HANA_DESKTOP_SMOKE_TOKEN.
Prefer HANA_DESKTOP_SMOKE_TOKEN because command-line tokens can appear in shell history or process listings.
The helper never prints stored device tokens.
`;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
}

async function restartAppWithDebugging({ appPath, port }) {
  run("osascript", ["-e", "tell application \"HanaAgent\" to quit"]);
  await delay(1200);
  const opened = run("open", ["-a", appPath, "--args", `--remote-debugging-port=${port}`]);
  if (opened.status !== 0) {
    throw new Error((opened.stderr || opened.stdout || `failed to open ${appPath}`).trim());
  }
}

async function fetchJson(url, { timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDebugEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: Math.min(2000, timeoutMs) });
    } catch (err) {
      lastError = err;
      await delay(250);
    }
  }
  throw new Error(`remote debugging endpoint not available on 127.0.0.1:${port}: ${lastError?.message || lastError}`);
}

async function selectPageTarget(port, timeoutMs) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, { timeoutMs });
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  const main = pages.find((target) => String(target.url || "").startsWith("file://") && !String(target.url || "").includes("settings.html"))
    || pages.find((target) => String(target.url || "").startsWith("file://"))
    || pages[0];
  if (!main) throw new Error("no debuggable HanaAgent page target found");
  return main;
}

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const onOpen = () => {
      ws.off("error", onError);
      resolve(ws);
    };
    const onError = (err) => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

export async function cdpCommand(ws, method, params = {}, { timeoutMs = 15000 } = {}) {
  cdpCommand.nextId = (cdpCommand.nextId || 0) + 1;
  const id = cdpCommand.nextId;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    let timer = null;
    const onMessage = (data) => {
      const message = JSON.parse(String(data));
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ws.off("message", onMessage);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on("message", onMessage);
    ws.send(payload, (err) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });
}

async function evaluate(ws, expression, { timeoutMs } = {}) {
  const result = await cdpCommand(ws, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, { timeoutMs });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || "renderer evaluation failed";
    throw new Error(text);
  }
  return result.result?.value;
}

function rendererResetExpression({ baseUrl, token, connection }) {
  const payload = JSON.stringify({ baseUrl, token, connection: connection || null });
  return `
(async (options) => {
  const STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)};
  // Keep these renderer-injected normalizers aligned with the Node-side copies
  // above. Work item: 2026-06-22-hana-desktop-smoke-helper-followups.
  const normalizeBaseUrl = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) throw new Error('server URL required');
    const withProtocol = /^[a-z][a-z0-9+.-]*:\\/\\//i.test(trimmed) ? trimmed : 'http://' + trimmed;
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('server URL must use http or https');
    parsed.hash = '';
    parsed.search = '';
    const pathname = parsed.pathname.replace(/\\/+$/, '');
    parsed.pathname = pathname === '/mobile' || pathname === '/desktop' ? '/' : (pathname || '/');
    return parsed.toString().replace(/\\/+$/, '');
  };
  const wsUrlForBaseUrl = (baseUrl) => {
    const parsed = new URL(baseUrl);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\\/+$/, '');
  };
  const isLoopbackHost = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  const normalizeKind = (value, hostname) => {
    if (value === 'custom_remote' || value === 'relay' || value === 'cloud') return value;
    if (value === 'local' && isLoopbackHost(hostname)) return 'local';
    return 'lan';
  };
  const normalizeTrust = (value, kind) => {
    if (kind === 'custom_remote' || kind === 'relay') return 'tunnel';
    if (kind === 'cloud') return 'cloud';
    if (kind === 'local') return 'local';
    if (value === 'local' || value === 'lan' || value === 'tunnel' || value === 'cloud') return value;
    return 'lan';
  };
  const parseState = (raw) => {
    if (!raw) return { schemaVersion: 1, serverConnections: {}, activeServerConnectionId: null };
    const parsed = JSON.parse(raw);
    return {
      schemaVersion: 1,
      serverConnections: parsed && parsed.serverConnections && typeof parsed.serverConnections === 'object' ? parsed.serverConnections : {},
      activeServerConnectionId: typeof (parsed && parsed.activeServerConnectionId) === 'string' ? parsed.activeServerConnectionId : null,
    };
  };
  const summarize = (raw) => {
    const state = parseState(raw);
    return {
      activeServerConnectionId: state.activeServerConnectionId,
      connections: Object.values(state.serverConnections || {}).filter(Boolean).map((connection) => ({
        connectionId: connection.connectionId,
        kind: connection.kind,
        baseUrl: connection.baseUrl,
        wsUrl: connection.wsUrl,
        credentialKind: connection.credentialKind,
        hasToken: Boolean(connection.token),
      })),
    };
  };
  const buildConnectionFromProbe = (baseUrl, credential, identity) => {
    const base = normalizeBaseUrl(baseUrl);
    const parsed = new URL(base);
    const serverId = identity.serverId || parsed.host;
    const serverNodeId = identity.serverNodeId || serverId;
    const studioId = identity.studioId || 'default';
    const kind = normalizeKind(identity.connectionKind, parsed.hostname);
    return {
      connectionId: kind + ':' + serverNodeId + ':' + studioId,
      kind,
      serverId,
      serverNodeId,
      serverNodeKind: identity.serverNodeKind,
      serverNodeTransport: identity.serverNodeTransport,
      userId: identity.userId,
      studioId,
      label: identity.studioLabel || identity.label || 'Hana Studio',
      userLabel: identity.userLabel,
      studioLabel: identity.studioLabel,
      serverVersion: identity.version,
      baseUrl: base,
      wsUrl: wsUrlForBaseUrl(base),
      token: String(credential || ''),
      authState: identity.authState || 'paired',
      trustState: normalizeTrust(identity.trustState, kind),
      credentialKind: 'device_credential',
      platformAccountId: identity.platformAccountId ?? null,
      officialServiceKind: identity.officialServiceKind ?? null,
      executionBoundary: identity.executionBoundary,
      capabilities: Array.isArray(identity.capabilities) ? [...identity.capabilities] : ['chat'],
    };
  };
  const targetBaseUrl = normalizeBaseUrl(options.baseUrl);
  const beforeRaw = localStorage.getItem(STORAGE_KEY);
  const beforeState = parseState(beforeRaw);
  let selected = Object.values(beforeState.serverConnections || {}).find((connection) => {
    if (!connection || connection.kind === 'local' || !connection.baseUrl) return false;
    try { return normalizeBaseUrl(connection.baseUrl) === targetBaseUrl; } catch { return false; }
  });
  if (!selected && options.connection) {
    selected = options.connection;
  }
  if (!selected && options.token) {
    if (!window.hana || typeof window.hana.probeConnection !== 'function') {
      throw new Error('window.hana.probeConnection is unavailable');
    }
    const probe = await window.hana.probeConnection({ baseUrl: targetBaseUrl, credential: options.token });
    if (!probe || !probe.ok) throw new Error('connect probe failed: ' + ((probe && probe.error) || 'unknown'));
    selected = buildConnectionFromProbe(targetBaseUrl, options.token, probe.identity || {});
  }
  if (!selected || !selected.connectionId) {
    throw new Error('No saved connection for ' + targetBaseUrl + '; connect once manually or pass --token/HANA_DESKTOP_SMOKE_TOKEN.');
  }
  const restoredRaw = JSON.stringify({
    schemaVersion: 1,
    serverConnections: { [selected.connectionId]: selected },
    activeServerConnectionId: selected.connectionId,
  });
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, restoredRaw);
  setTimeout(() => location.reload(), 50);
  return { before: summarize(beforeRaw), restored: summarize(restoredRaw) };
})(${payload})
`;
}

async function resetRendererStorage(options) {
  const historicalLookup = options.token
    ? Promise.resolve(null)
    : Promise.resolve().then(() => findHistoricalConnection({ userDataDir: options.userDataDir, baseUrl: options.baseUrl }));
  const [, historicalConnection] = await Promise.all([
    waitForDebugEndpoint(options.port, options.timeoutMs),
    historicalLookup,
  ]);
  const target = await selectPageTarget(options.port, options.timeoutMs);
  const ws = await connectWebSocket(target.webSocketDebuggerUrl);
  try {
    await cdpCommand(ws, "Runtime.enable", {}, { timeoutMs: options.timeoutMs });
    return await evaluate(ws, rendererResetExpression({
      ...options,
      connection: historicalConnection,
    }), { timeoutMs: options.timeoutMs });
  } finally {
    ws.close();
  }
}

function rendererVerificationExpression() {
  return `
(async () => {
  const STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)};
  const raw = localStorage.getItem(STORAGE_KEY);
  const state = raw ? JSON.parse(raw) : { serverConnections: {}, activeServerConnectionId: null };
  const connection = state.serverConnections && state.activeServerConnectionId
    ? state.serverConnections[state.activeServerConnectionId]
    : Object.values(state.serverConnections || {})[0];
  if (!connection) return { ok: false, reason: 'missing connection' };

  let identityStatus = null;
  let identityOk = false;
  let identityError = null;
  try {
    const res = await fetch(connection.baseUrl + '/api/server/identity', {
      headers: connection.token ? { Authorization: 'Bearer ' + connection.token } : {},
    });
    identityStatus = res.status;
    identityOk = res.ok;
  } catch (err) {
    identityError = err && err.message ? err.message : String(err);
  }

  const wsOk = await new Promise((resolve) => {
    if (!connection.token) return resolve(false);
    const socket = new WebSocket(connection.wsUrl + '/ws?token=' + encodeURIComponent(connection.token));
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      resolve(false);
    }, 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });

  return {
    ok: Boolean(connection.baseUrl && connection.wsUrl),
    baseUrl: connection.baseUrl,
    hasToken: Boolean(connection.token),
    identityStatus,
    identityOk,
    identityError,
    wsOk,
  };
})()
`;
}

export function connectionVerificationPassed(verification) {
  return Boolean(verification?.ok && verification?.hasToken && verification?.identityOk && verification?.wsOk);
}

async function verifyRendererConnection(options) {
  await waitForDebugEndpoint(options.port, options.timeoutMs);
  const target = await selectPageTarget(options.port, options.timeoutMs);
  const ws = await connectWebSocket(target.webSocketDebuggerUrl);
  try {
    await cdpCommand(ws, "Runtime.enable", {}, { timeoutMs: options.timeoutMs });
    return await evaluate(ws, rendererVerificationExpression(), { timeoutMs: options.timeoutMs });
  } finally {
    ws.close();
  }
}

export async function waitForRendererConnectionVerification(options, {
  delayFn = delay,
  retryDelayMs = VERIFY_RETRY_DELAY_MS,
  timeoutMs = options.timeoutMs || 15000,
  verify = verifyRendererConnection,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastVerification = null;
  do {
    lastVerification = await verify(options);
    if (connectionVerificationPassed(lastVerification)) return lastVerification;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delayFn(Math.min(retryDelayMs, remainingMs));
  } while (Date.now() < deadline);
  return lastVerification;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`x ${err.message}`);
    console.error(usage());
    return 1;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.restart) {
    await restartAppWithDebugging(options);
  }

  const result = await resetRendererStorage(options);
  const verification = options.verify
    ? await delay(RELOAD_SETTLE_MS).then(() => waitForRendererConnectionVerification(options))
    : null;
  const ok = !options.verify || connectionVerificationPassed(verification);
  console.log(JSON.stringify({
    ok,
    baseUrl: options.baseUrl,
    port: options.port,
    ...result,
    ...(verification ? { verification } : {}),
  }, null, 2));
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    if (code) process.exitCode = code;
  }).catch((err) => {
    console.error(`x ${err.message || err}`);
    process.exitCode = 1;
  });
}
