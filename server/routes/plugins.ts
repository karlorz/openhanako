import { Hono } from "hono";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { extractZip } from "../../lib/extract-zip.ts";
import { fromRoot } from "../../shared/hana-root.ts";
import { DEFAULT_THEME } from "../../desktop/src/shared/theme-registry.cjs";
import { registerSessionFileFromRequest } from "../../lib/session-files/session-file-response.ts";
import {
  createDefaultPluginMarketplace,
  getMarketplacePluginVersionState,
} from "../../lib/plugin-marketplace.ts";
import { comparePluginVersions } from "../../lib/plugin-versioning.ts";
import {
  createPluginInstallBackup,
  restorePluginInstallBackup,
} from "../../lib/plugin-install-backups.ts";
import { detectIncompatiblePluginFormat } from "../../lib/plugin-format-guard.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";
import {
  PluginIframeTicketError,
  issuePluginIframeTicket,
  verifyPluginIframeTicket,
} from "../../core/plugin-iframe-ticket-service.ts";
import {
  DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS,
  createPluginAssetSessionCookie,
  issuePluginAssetSession,
} from "../../core/plugin-asset-session-service.ts";
import { issuePluginSurfaceSession } from "../../core/plugin-surface-session-service.ts";
import { servePluginAsset } from "../http/plugin-assets.ts";
import {
  PLUGIN_SURFACE_SESSION_HEADER,
  PLUGIN_SURFACE_SESSION_QUERY,
} from "../http/plugin-surface-session.ts";
import {
  PLUGIN_HOST_ROUTE_PLUGIN_IDS,
  isLocalOwnerPrincipal,
  isStudioOwnerPrincipal,
} from "../http/route-security.ts";
import { isSecureHttpRequest } from "../http/transport-context.ts";
import { PluginMarketplaceService } from "../../lib/plugin-marketplace-service.ts";
import { PluginSourceSwitchCoordinator } from "../../lib/plugin-source-switch.ts";
import { PluginInstallRecords } from "../../lib/plugin-install-records.ts";
import { PluginArtifactStore } from "../../lib/plugin-artifact-store.ts";
import { inspectMarketplacePackage } from "../../lib/plugin-marketplace-inspector.ts";

const log = createModuleLogger("plugin-install");

const MAX_PLUGIN_RELEASE_PACKAGE_SIZE = 50 * 1024 * 1024;
const PLUGIN_IFRAME_TICKET_QUERY = "pluginIframeTicket";
const PLUGIN_IFRAME_HOST_QUERY_PARAMS = new Set([
  PLUGIN_IFRAME_TICKET_QUERY,
  PLUGIN_SURFACE_SESSION_QUERY,
  "agentId",
  "hana-theme",
  "hana-css",
]);

/**
 * 代理分发：将 /plugins/:pluginId/* 的请求转发到对应 plugin 子 app。
 * 入口凭证（iframe ticket / surface session）在转发前剥离；请求级身份与
 * agentId 通过 Hono env 的 `pluginRouteRequest` 显式传入插件 route app，
 * 由 plugin-manager 的中间件铸造为 `pluginRequestContext` 请求变量。
 * @param {import("hono").Context} c
 * @param {import("hono").Hono} pluginApp
 * @param {string} pluginId
 * @param {string} [agentId] - 当前 agent id，仅通过请求级 Hono env 传递
 * @param {object|null} [requestPrincipal] - 本次请求的来源身份描述
 */
async function proxyToPlugin(c: any, pluginApp: any, pluginId: string, agentId?: string, requestPrincipal: any = null) {
  const url = new URL(c.req.url);
  const prefix = `/plugins/${pluginId}`;
  const prefixIndex = url.pathname.indexOf(prefix);
  const subPath = prefixIndex !== -1
    ? url.pathname.slice(prefixIndex + prefix.length) || "/"
    : "/";
  url.pathname = subPath;
  url.searchParams.delete(PLUGIN_IFRAME_TICKET_QUERY);
  url.searchParams.delete(PLUGIN_SURFACE_SESSION_QUERY);

  const headers = new Headers(c.req.raw.headers);
  headers.delete(PLUGIN_SURFACE_SESSION_HEADER);
  // 请求级 env 是 agent 身份唯一信源；删除同名原始 header，避免调用方
  // 伪造第二套上下文或让插件 handler 误读到不同身份。
  headers.delete("X-Hana-Agent-Id");

  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const subReq = new Request(url.toString(), {
    method: c.req.method,
    headers,
    body: hasBody ? c.req.raw.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  });
  return pluginApp.fetch(subReq, {
    pluginRouteRequest: {
      pluginId,
      agentId: agentId || null,
      principal: requestPrincipal,
    },
  });
}

/**
 * Standalone route proxy (for tests).
 * @param {Map<string, import("hono").Hono>} routeRegistry
 */
export function createPluginProxyRoute(routeRegistry: any) {
  const route = new Hono();
  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    const pluginApp = routeRegistry.get(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    return proxyToPlugin(c, pluginApp, pluginId);
  });
  return route;
}

function safePathSegment(value: any, fallback: string) {
  const text = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text || fallback;
}

function createPluginRouteError(message: string, status = 400, code = "PLUGIN_ERROR") {
  const err = new Error(message) as Error & { status: number; code: string };
  err.status = status;
  err.code = code;
  return err;
}

export function parsePluginIframeSurfaceRoute(routeUrl: any) {
  const parsed = new URL(String(routeUrl || ""), "http://hana.local");
  const match = /^\/api\/plugins\/([^/]+)(\/.*)?$/.exec(parsed.pathname);
  if (!match) {
    throw createPluginRouteError("plugin iframe routeUrl must target /api/plugins/:pluginId/*", 400, "PLUGIN_IFRAME_ROUTE_INVALID");
  }
  const pluginId = decodeURIComponent(match[1]);
  const surfacePath = canonicalPluginIframeSurfacePath(match[2] || "/", parsed.searchParams);
  return { pluginId, surfacePath };
}

function canonicalPluginIframeSurfacePath(pathname: string, searchParams: URLSearchParams) {
  const params = [];
  for (const [key, value] of searchParams.entries()) {
    if (PLUGIN_IFRAME_HOST_QUERY_PARAMS.has(key)) continue;
    params.push([key, value]);
  }
  params.sort(([leftKey, leftValue], [rightKey, rightValue]) => (
    leftKey === rightKey
      ? leftValue.localeCompare(rightValue)
      : leftKey.localeCompare(rightKey)
  ));
  const search = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const safePath = pathname && pathname.startsWith("/") ? pathname : `/${pathname || ""}`;
  return search ? `${safePath}?${search}` : safePath;
}

function pluginIframeSurfaceRouteFromRequest(c: any) {
  return parsePluginIframeSurfaceRoute(new URL(c.req.url).pathname + new URL(c.req.url).search);
}

function verifyPluginIframeTicketForRequest(c: any, engine: any, pluginId: string) {
  const ticket = c.req.query(PLUGIN_IFRAME_TICKET_QUERY);
  if (!ticket) return null;
  const surface = pluginIframeSurfaceRouteFromRequest(c);
  if (surface.pluginId !== pluginId) {
    throw new PluginIframeTicketError("plugin iframe ticket plugin mismatch");
  }
  return verifyPluginIframeTicket({
    hanakoHome: engine.hanakoHome,
    ticket,
    pluginId,
    surfacePath: surface.surfacePath,
  } as any);
}

function readAuthPrincipal(c: any) {
  try {
    return c.get("authPrincipal");
  } catch {
    return null;
  }
}

function responseNeedsPluginAssetSession(c: any, response: Response, iframeTicket: any) {
  const method = String(c.req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (response.status >= 400) return false;
  if (iframeTicket) return true;
  return String(response.headers.get("content-type") || "").toLowerCase().includes("text/html");
}

function appendPluginAssetSessionCookie(c: any, engine: any, pluginId: string, response: Response, iframeTicket: any) {
  if (!responseNeedsPluginAssetSession(c, response, iframeTicket)) return response;
  if (!engine?.hanakoHome) return response;
  const principal = readAuthPrincipal(c);
  // Surface session 凭证不允许给自己续发资产会话 cookie：派生凭证不能再派生，
  // 续发只能来自 ticket 或 owner / device 凭证的入口。
  if (!iframeTicket && principal?.credentialKind === "plugin_surface_session") return response;
  const principalId = iframeTicket?.principalId || principal?.principalId;
  if (!principalId) return response;
  const issued = issuePluginAssetSession({
    hanakoHome: engine.hanakoHome,
    pluginId,
    principalId,
  } as any);
  const maxAgeSeconds = Math.max(
    1,
    Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000)
      || Math.ceil(DEFAULT_PLUGIN_ASSET_SESSION_TTL_MS / 1000),
  );
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", createPluginAssetSessionCookie({
    pluginId,
    token: issued.token,
    maxAgeSeconds,
    secure: isSecureHttpRequest(c),
  } as any));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function verifyPluginIframeTicketForHostRequest(c: any, engine: any, { requireTicket = true } = {}) {
  const ticket = c.req.query(PLUGIN_IFRAME_TICKET_QUERY);
  if (!ticket) {
    if (!requireTicket) return null;
    throw new PluginIframeTicketError("plugin iframe ticket required");
  }
  const surface = pluginIframeSurfaceRouteFromRequest(c);
  assertPluginIframeSurfaceAllowed(surface);
  return verifyPluginIframeTicket({
    hanakoHome: engine.hanakoHome,
    ticket,
    pluginId: surface.pluginId,
    surfacePath: surface.surfacePath,
  } as any);
}

function assertPluginIframeSurfaceAllowed(surface: any) {
  if (!surface?.pluginId || !surface?.surfacePath) {
    throw new PluginIframeTicketError("plugin iframe route invalid");
  }
  if (PLUGIN_HOST_ROUTE_PLUGIN_IDS.has(surface.pluginId)) {
    throw new PluginIframeTicketError("plugin iframe ticket cannot target plugin host routes", {
      code: "plugin_iframe_ticket_route_forbidden",
    });
  }
  const pathname = new URL(surface.surfacePath, "http://hana.local").pathname;
  if (PLUGIN_HOST_ROUTE_SURFACE_PATHS.has(pathname)) {
    throw new PluginIframeTicketError("plugin iframe ticket cannot target plugin host routes", {
      code: "plugin_iframe_ticket_route_forbidden",
    });
  }
}

const PLUGIN_HOST_ROUTE_SURFACE_PATHS = new Set([
  "/config",
  "/config-schema",
]);

/**
 * 构造插件 route handler 请求级上下文的来源身份描述。
 * 优先采用 HTTP 鉴权铸造的 authPrincipal（owner / device / plugin surface）；
 * ticket 加载的 surface 文档请求没有 authPrincipal，从已验证的 iframe ticket
 * 推导。两者都缺席时为 null（如测试直连 route app）。
 */
function pluginRouteRequestPrincipal(authPrincipal: any, iframeTicket: any, pluginId: string) {
  if (authPrincipal && typeof authPrincipal === "object") {
    return {
      kind: authPrincipal.kind ?? null,
      principalId: authPrincipal.principalId ?? null,
      pluginId: authPrincipal.pluginId ?? null,
      credentialId: authPrincipal.credentialId ?? null,
      credentialKind: authPrincipal.credentialKind ?? null,
      connectionKind: authPrincipal.connectionKind ?? null,
    };
  }
  if (iframeTicket && typeof iframeTicket === "object") {
    return {
      kind: "plugin",
      principalId: iframeTicket.principalId ?? null,
      pluginId,
      credentialId: iframeTicket.ticketId ?? null,
      credentialKind: "plugin_iframe_ticket",
      connectionKind: null,
    };
  }
  return null;
}

function assertInsideDir(childPath: string, parentDir: string) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  if (child !== parent && !child.startsWith(parentWithSep)) {
    throw createPluginRouteError("Plugin install target escaped plugins directory", 400, "PLUGIN_INSTALL_PATH_INVALID");
  }
}

function readPluginDescriptorForInstall(pm: any, pluginDir: string) {
  const formatIssue = detectIncompatiblePluginFormat(pluginDir);
  if (formatIssue) {
    throw createPluginRouteError(formatIssue.message, 400, formatIssue.code);
  }
  if (typeof pm.readPluginDescriptor === "function") {
    return pm.readPluginDescriptor(pluginDir, path.basename(pluginDir));
  }
  const manifestPath = path.join(pluginDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw createPluginRouteError("Not a valid plugin directory", 400, "PLUGIN_INVALID");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const id = manifest?.id || path.basename(pluginDir);
  return {
    id,
    name: manifest?.name || id,
    version: manifest?.version || "0.0.0",
    manifest,
    pluginDir,
  };
}

function findInstalledPlugin(pm: any, pluginId: string, candidateDir?: string) {
  const plugins = typeof pm.listPlugins === "function" ? pm.listPlugins({ source: "community" }) : [];
  return plugins.find((plugin) => (
    plugin.id === pluginId
    || (candidateDir && plugin.pluginDir && path.resolve(plugin.pluginDir) === path.resolve(candidateDir))
  )) || null;
}

function readInstalledVersion(pm: any, pluginId: string, targetDir: string) {
  const existing = findInstalledPlugin(pm, pluginId, targetDir);
  if (existing?.version) return existing.version;
  const manifestPath = path.join(targetDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest?.version || null;
  } catch {
    return null;
  }
}

function removePluginInstallRecord(engine: any, pluginId: string) {
  if (!pluginId) return;
  if (typeof engine?.removePluginInstallRecord === "function") {
    engine.removePluginInstallRecord(pluginId);
  }
}

function reconcileMissingPluginDirectories(engine: any, pm: any) {
  const removed = typeof pm?.reconcileMissingPluginDirectories === "function"
    ? pm.reconcileMissingPluginDirectories()
    : [];
  if (!Array.isArray(removed) || removed.length === 0) return [];
  for (const entry of removed) {
    if ((entry?.source || "community") !== "community") continue;
    removePluginInstallRecord(engine, entry.id);
  }
  return removed;
}

function defaultCommunityPluginDir(pm: any, pluginId: string) {
  const userPluginsDir = typeof pm?.getUserPluginsDir === "function"
    ? pm.getUserPluginsDir()
    : null;
  if (!userPluginsDir) return null;
  return path.join(userPluginsDir, safePathSegment(pluginId, pluginId));
}

function readLiveOrReconciledInstallRecord(engine: any, pm: any, pluginId: string, installedPlugin: any) {
  if (installedPlugin) return null;
  const record = typeof engine?.getPluginInstallRecord === "function"
    ? engine.getPluginInstallRecord(pluginId)
    : null;
  if (!record) return null;
  const defaultDir = defaultCommunityPluginDir(pm, pluginId);
  if (defaultDir && !fs.existsSync(defaultDir)) {
    removePluginInstallRecord(engine, pluginId);
    return null;
  }
  return record;
}

function getInstallTargetDir(pm: any, desc: any, stagedDir: string, userPluginsDir: string) {
  const idSegment = safePathSegment(desc.id, path.basename(stagedDir));
  const defaultTarget = path.join(userPluginsDir, idSegment);
  const existing = findInstalledPlugin(pm, desc.id, defaultTarget);
  const targetDir = existing?.pluginDir || defaultTarget;
  assertInsideDir(targetDir, userPluginsDir);
  return targetDir;
}

async function stagePluginSource({ pm, sourcePath, userPluginsDir }: { pm: any; sourcePath: string; userPluginsDir: string }) {
  const stat = fs.statSync(sourcePath);
  const cleanupPaths = [];
  fs.mkdirSync(userPluginsDir, { recursive: true });
  const tmpTarget = fs.mkdtempSync(path.join(userPluginsDir, ".installing-"));
  cleanupPaths.push(tmpTarget);

  try {
    let pluginSrc = null;
    if (sourcePath.endsWith(".zip")) {
      const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
      cleanupPaths.push(extractDir);
      await extractZip(sourcePath, extractDir);
      const entries = fs.readdirSync(extractDir, { withFileTypes: true });
      pluginSrc = entries.length === 1 && entries[0].isDirectory()
        ? path.join(extractDir, entries[0].name)
        : extractDir;
    } else if (stat.isDirectory()) {
      pluginSrc = sourcePath;
    } else {
      throw createPluginRouteError("Path must be a .zip file or directory", 400, "PLUGIN_INSTALL_SOURCE_INVALID");
    }

    const formatIssue = detectIncompatiblePluginFormat(pluginSrc);
    if (formatIssue) {
      throw createPluginRouteError(formatIssue.message, 400, formatIssue.code);
    }
    fs.cpSync(pluginSrc, tmpTarget, { recursive: true });
    if (!pm.isValidPluginDir(tmpTarget)) {
      throw createPluginRouteError("Not a valid plugin directory", 400, "PLUGIN_INVALID");
    }
    return { stagedDir: tmpTarget, cleanupPaths };
  } catch (err) {
    for (const cleanupPath of cleanupPaths) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
    throw err;
  }
}

function assertExpectedPlugin(desc: any, { expectedPluginId, expectedVersion }: { expectedPluginId?: string; expectedVersion?: string }) {
  if (expectedPluginId && desc.id !== expectedPluginId) {
    throw createPluginRouteError(
      `Marketplace package id mismatch: expected "${expectedPluginId}", got "${desc.id}"`,
      409,
      "PLUGIN_PACKAGE_ID_MISMATCH",
    );
  }
  if (expectedVersion && comparePluginVersions(desc.version, expectedVersion) !== 0) {
    throw createPluginRouteError(
      `Marketplace package version mismatch: expected v${expectedVersion}, got v${desc.version}`,
      409,
      "PLUGIN_PACKAGE_VERSION_MISMATCH",
    );
  }
}

function assertInstallEntryHealthy(entry: any) {
  if (!entry) {
    throw createPluginRouteError("Plugin install failed", 500, "PLUGIN_INSTALL_FAILED");
  }
  if (entry.status === "failed") {
    throw createPluginRouteError(entry.error || "Plugin install failed", 500, "PLUGIN_INSTALL_FAILED");
  }
  if (entry.status === "incompatible") {
    throw createPluginRouteError(entry.error || "Plugin is incompatible with this app version", 409, "PLUGIN_VERSION_INCOMPATIBLE");
  }
}

async function restoreAfterFailedInstall({ engine, pm, backup, targetDir, desc }: { engine: any; pm: any; backup: any; targetDir: string; desc: any }) {
  if (backup && restorePluginInstallBackup(backup, targetDir)) {
    try {
      await pm.installPlugin(targetDir, { source: "community" });
      await engine.syncPluginExtensions();
    } catch (restoreErr) {
      log.warn(`failed to reload restored plugin "${desc.id}": ${restoreErr.message}`);
    }
    return;
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  if (desc?.id && typeof pm.removePlugin === "function") {
    try {
      await pm.removePlugin(desc.id, { source: "community", persist: false });
    } catch {
      // The failed install may not have reached the plugin registry.
    }
  }
}

async function installPluginFromPath({
  engine,
  pm,
  sourcePath,
  sessionPath,
  expectedPluginId,
  expectedVersion,
  allowDowngrade = false,
  installRecord = {},
}: {
  engine?: any;
  pm?: any;
  sourcePath?: any;
  sessionPath?: any;
  expectedPluginId?: string;
  expectedVersion?: string;
  allowDowngrade?: boolean;
  installRecord?: Record<string, any>;
} = {}) {
  fs.statSync(sourcePath);
  const sourceFile = registerSessionFileFromRequest(engine, {
    sessionPath,
    filePath: sourcePath,
    label: path.basename(sourcePath),
    origin: "plugin_install_source",
    storageKind: "install_source",
  } as any);
  const userPluginsDir = pm.getUserPluginsDir();
  const { stagedDir, cleanupPaths } = await stagePluginSource({ pm, sourcePath, userPluginsDir });
  let desc = null;
  let targetDir = null;
  let backup = null;

  try {
    desc = readPluginDescriptorForInstall(pm, stagedDir);
    assertExpectedPlugin(desc, { expectedPluginId, expectedVersion });
    targetDir = getInstallTargetDir(pm, desc, stagedDir, userPluginsDir);
    const installedVersion = readInstalledVersion(pm, desc.id, targetDir);
    if (installedVersion && comparePluginVersions(desc.version, installedVersion) < 0 && !allowDowngrade) {
      throw createPluginRouteError(
        `Installing v${desc.version} would downgrade installed v${installedVersion}`,
        409,
        "PLUGIN_VERSION_DOWNGRADE",
      );
    }

    backup = createPluginInstallBackup({
      hanakoHome: engine.hanakoHome,
      pluginId: desc.id,
      pluginDir: targetDir,
      version: installedVersion,
    } as any);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);

    let entry;
    try {
      entry = await pm.installPlugin(targetDir, { source: "community" });
      assertInstallEntryHealthy(entry);
      await engine.syncPluginExtensions();
    } catch (err) {
      await restoreAfterFailedInstall({ engine, pm, backup, targetDir, desc });
      throw err;
    }

    engine.recordPluginInstall?.({
      pluginId: entry.id || desc.id,
      installedVersion: entry.version || desc.version,
      source: "local",
      sourcePath,
      ...installRecord,
    });

    return {
      ...entry,
      ...(sourceFile ? { sourceFile } : {}),
    };
  } finally {
    for (const cleanupPath of cleanupPaths) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
  }
}

function decodeHttpConfigValues(values: any) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === null ? undefined : value]),
  );
}

function decodeHttpConfigBody(body: any) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { values: {}, scope: "global", agentId: undefined, sessionId: undefined, sessionPath: undefined, legacySessionPath: undefined };
  }
  const hasValuesEnvelope = Object.prototype.hasOwnProperty.call(body, "values");
  const rawValues = hasValuesEnvelope
    ? body.values
    : Object.fromEntries(
        Object.entries(body).filter(([key]) => ![
          "scope",
          "agentId",
          "sessionId",
          "sessionPath",
          "legacySessionPath",
        ].includes(key)),
      );
  return {
    values: decodeHttpConfigValues(rawValues),
    scope: body.scope || "global",
    agentId: body.agentId,
    sessionId: body.sessionId,
    sessionPath: body.sessionPath,
    legacySessionPath: body.legacySessionPath,
  };
}

async function downloadMarketplaceRelease({ engine, plugin }: { engine: any; plugin: any }) {
  const dist = plugin?.distribution;
  if (!dist || dist.kind !== "release") {
    const err = new Error("Plugin has no release distribution") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  if (!dist.packageUrl || !dist.sha256) {
    const err = new Error("Plugin release distribution is missing packageUrl or sha256") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  const expectedSha256 = String(dist.sha256).trim();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    const err = new Error("Plugin release sha256 must be 64 lowercase hex characters") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  const packageUrl = new URL(dist.packageUrl);
  if (packageUrl.protocol !== "https:") {
    const err = new Error("Plugin release packageUrl must use https") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  const fetchImpl = engine.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    const err = new Error("fetch is unavailable") as Error & { status: number };
    err.status = 500;
    throw err;
  }
  if (!engine.hanakoHome) {
    const err = new Error("HANA_HOME is unavailable for plugin release installation") as Error & { status: number };
    err.status = 500;
    throw err;
  }

  const res = await fetchImpl(packageUrl.toString());
  if (!res.ok) {
    const err = new Error(`Plugin release download failed: ${res.status}`) as Error & { status: number };
    err.status = 502;
    throw err;
  }
  const contentLength = Number(res.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_PLUGIN_RELEASE_PACKAGE_SIZE) {
    const err = new Error("Plugin release package is too large") as Error & { status: number };
    err.status = 413;
    throw err;
  }

  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_PLUGIN_RELEASE_PACKAGE_SIZE) {
    const err = new Error("Plugin release package is too large") as Error & { status: number };
    err.status = 413;
    throw err;
  }
  const actualSha256 = crypto.createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== expectedSha256) {
    const err = new Error("Plugin release sha256 mismatch") as Error & { status: number };
    err.status = 502;
    throw err;
  }

  const pluginId = safePathSegment(plugin.id, "plugin");
  const version = safePathSegment(plugin.version, "0.0.0");
  const downloadsDir = path.join(engine.hanakoHome, "plugin-install-sources", pluginId, version);
  fs.mkdirSync(downloadsDir, { recursive: true });
  const packagePath = path.join(downloadsDir, `${pluginId}-${version}.zip`);
  fs.writeFileSync(packagePath, body);
  return packagePath;
}

function isMarketplacePluginInstallable(plugin: any, marketplace: any) {
  if (plugin.distribution?.kind === "source") {
    return !!marketplace.resolveSourceDistribution(plugin);
  }
  if (plugin.distribution?.kind === "release") {
    return !!(plugin.distribution.packageUrl && plugin.distribution.sha256);
  }
  return false;
}

function marketplacePluginForVersion(plugin: any, versionState: any) {
  return {
    ...plugin,
    version: versionState.selectedVersion || plugin.version,
    compatibility: versionState.selectedCompatibility || plugin.compatibility || {},
    distribution: versionState.selectedDistribution || null,
  };
}

function getEngineAppVersion(engine: any) {
  if (typeof engine.getAppVersion === "function") return engine.getAppVersion();
  return engine.appVersion || "0.0.0";
}

function pluginDevServiceOrError(engine: any, c: any) {
  const service = engine.pluginDevService;
  if (!service) {
    return {
      errorResponse: c.json({
        error: "Plugin dev service not available",
        code: "PLUGIN_DEV_SERVICE_UNAVAILABLE",
      }, 500),
    };
  }
  return { service };
}

function pluginDevErrorResponse(c: any, err: any) {
  return c.json({
    error: err?.message || String(err),
    ...(err?.code ? { code: err.code } : {}),
  }, err?.status || 500);
}

function sanitizeMarketplacePluginForClient(plugin: any) {
  const {
    readme: _readme,
    readmePath: _readmePath,
    distribution,
    versions,
    ...rest
  } = plugin;
  return {
    ...rest,
    distribution: distribution
      ? {
          kind: distribution.kind,
          ...(distribution.path ? { path: distribution.path } : {}),
          ...(distribution.packageUrl ? { packageUrl: distribution.packageUrl } : {}),
          ...(distribution.sha256 ? { sha256: distribution.sha256 } : {}),
        }
      : null,
    versions: Array.isArray(versions)
      ? versions.map((item) => ({
          version: item.version,
          compatibility: item.compatibility || {},
          distribution: item.distribution
            ? {
                kind: item.distribution.kind,
                ...(item.distribution.path ? { path: item.distribution.path } : {}),
                ...(item.distribution.packageUrl ? { packageUrl: item.distribution.packageUrl } : {}),
                ...(item.distribution.sha256 ? { sha256: item.distribution.sha256 } : {}),
              }
            : null,
        }))
      : [],
  };
}

/**
 * Plugin management REST API + route proxy (combined).
 * @param {import('../../core/engine.ts').HanaEngine} engine
 */
export function createPluginsRoute(engine: any) {
  const route = new Hono();

  /**
   * 可见插件过滤 + 序列化（单一出口，所有返回插件列表的端点共用）。
   * hidden 插件（系统插件）永远不暴露给前端管理页。
   * @param {object} [opts]
   * @param {string} [opts.source] - 按 source 过滤（"community" | "builtin"）
   */
  function visiblePlugins(pm: any, opts: { source?: string } = {}) {
    reconcileMissingPluginDirectories(engine, pm);
    let plugins = pm.listPlugins().filter((p: any) => !p.hidden);
    if (opts.source) plugins = plugins.filter((p: any) => p.source === opts.source);
    return plugins.map(p => ({
      id: p.id, name: p.name, version: p.version,
      pluginKey: p.pluginKey || `${p.source || "community"}:${p.id}`,
      description: p.description, status: p.status,
      shadowedBy: p.shadowedBy || null,
      shadowedByPluginKey: p.shadowedByPluginKey || null,
      shadows: Array.isArray(p.shadows) ? p.shadows : [],
      activationState: p.activationState || null,
      activationEvents: Array.isArray(p.activationEvents) ? p.activationEvents : [],
      activationError: p.activationError || null,
      source: p.source || "community", trust: p.trust || "restricted",
      contributions: p.contributions,
      error: p.error || null,
    }));
  }

  // ── Management API (specific routes first) ──

  route.get("/plugins", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    return c.json(visiblePlugins(pm, { source: c.req.query("source") }));
  });

  route.get("/plugins/config-schemas", (c) => {
    const pm = engine.pluginManager;
    return c.json(pm?.getAllConfigSchemas() || []);
  });

  route.get("/plugins/event-bus/capabilities", (c) => {
    const bus = engine.getEventBus?.() || engine.eventBus || null;
    const capabilities = typeof bus?.listCapabilities === "function"
      ? bus.listCapabilities()
      : [];
    return c.json(capabilities);
  });

  route.get("/plugins/diagnostics", (c) => {
    const pm = engine.pluginManager;
    const bus = engine.getEventBus?.() || engine.eventBus || null;
    reconcileMissingPluginDirectories(engine, pm);
    return c.json({
      plugins: typeof pm?.getDiagnostics === "function"
        ? pm.getDiagnostics().filter(p => !p.hidden)
        : [],
      eventBus: typeof bus?.listCapabilities === "function" ? bus.listCapabilities() : [],
      tasks: typeof engine.taskRegistry?.listAll === "function" ? engine.taskRegistry.listAll() : [],
      schedules: typeof engine.taskRegistry?.listSchedules === "function" ? engine.taskRegistry.listSchedules() : [],
    });
  });

  // ── Plugin dev loop endpoints ──

  route.post("/plugins/dev/install", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    const sourcePath = body.sourcePath || body.path;
    try {
      return c.json(await service.installFromSource({
        sourcePath,
        pluginId: body.pluginId,
        allowFullAccess: !!body.allowFullAccess,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.post("/plugins/dev/:id/reload", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.reloadPlugin(c.req.param("id"), {
        devRunId: body.devRunId,
        allowFullAccess: body.allowFullAccess,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.put("/plugins/dev/:id/enabled", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = body.enabled === false
        ? await service.disablePlugin(c.req.param("id"), { devRunId: body.devRunId })
        : await service.enablePlugin(c.req.param("id"), {
            devRunId: body.devRunId,
            allowFullAccess: body.allowFullAccess,
          });
      return c.json(result);
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.post("/plugins/dev/:id/reset", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.resetPlugin(c.req.param("id"), {
        devRunId: body.devRunId,
        allowFullAccess: body.allowFullAccess,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.delete("/plugins/dev/:id", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.uninstallPlugin(c.req.param("id"), {
        devRunId: body.devRunId,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.get("/plugins/dev/:id/scenarios", (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const pluginId = c.req.param("id");
    try {
      return c.json({
        pluginId,
        scenarios: service.getScenarios({ pluginId }),
      });
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.post("/plugins/dev/:id/scenarios/:scenarioId/run", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.runScenario({
        pluginId: c.req.param("id"),
        scenarioId: c.req.param("scenarioId"),
        allowDestructive: body.allowDestructive === true,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.post("/plugins/dev/:id/tools/:toolName/invoke", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await service.invokeTool({
        pluginId: c.req.param("id"),
        toolName: c.req.param("toolName"),
        input: body.input || {},
        sessionId: body.sessionId,
        sessionRef: body.sessionRef,
        sessionPath: body.sessionPath,
        agentId: body.agentId,
      }));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  route.get("/plugins/dev/diagnostics", (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    return c.json(service.getDiagnostics(c.req.query("pluginId") || undefined));
  });

  route.get("/plugins/dev/surfaces", (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    return c.json(service.listSurfaces(c.req.query("pluginId") || undefined));
  });

  route.post("/plugins/dev/surfaces/describe", async (c) => {
    const { service, errorResponse } = pluginDevServiceOrError(engine, c);
    if (errorResponse) return errorResponse;
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(service.describeSurfaceDebug(body));
    } catch (err) {
      return pluginDevErrorResponse(c, err);
    }
  });

  function getMarketplace() {
    return engine.pluginMarketplace || createDefaultPluginMarketplace({
      hanakoHome: engine.hanakoHome,
      fetchImpl: engine.fetch,
    } as any);
  }

  function getMarketplaceService() {
    if (engine.pluginMarketplaceService) return engine.pluginMarketplaceService as PluginMarketplaceService;
    if (!engine.hanakoHome) {
      throw new Error("HANA_HOME is required for multi-source marketplace service");
    }
    return new PluginMarketplaceService({
      hanakoHome: engine.hanakoHome,
      fetchOptions: engine.fetch ? { fetchImpl: engine.fetch } : undefined,
    });
  }

  function principalFlags(c: any) {
    // HTTP auth middleware sets authPrincipal (not requestPrincipal). Local desktop
    // loopback tokens are kind=local_user + credentialKind=loopback_token.
    const principal = readAuthPrincipal(c)
      || c.get?.("requestPrincipal")
      || c.env?.requestPrincipal
      || null;
    const isLocalOwner = isLocalOwnerPrincipal(principal);
    // Local owner counts as studio.owner for marketplace mutations (desktop Settings).
    const isStudioOwner = isStudioOwnerPrincipal(principal)
      || isLocalOwner
      || principal?.scopes?.includes?.("studio.owner") === true
      || principal?.role === "owner";
    return { isLocalOwner, isStudioOwner, principal };
  }

  function expectedRegistryPreconditionsFromBody(body: any) {
    return {
      expectedRevision: typeof body?.expectedRevision === "number" ? body.expectedRevision : undefined,
      expectedDigest: typeof body?.expectedDigest === "string" ? body.expectedDigest : undefined,
    };
  }

  function expectedRegistryPreconditionsFromQuery(c: any) {
    const rawRevision = c.req.query("expectedRevision");
    const parsedRevision = rawRevision !== undefined ? Number(rawRevision) : undefined;
    return {
      expectedRevision: Number.isInteger(parsedRevision) ? parsedRevision : undefined,
      expectedDigest: c.req.query("expectedDigest") || undefined,
    };
  }

  // ── Multi-source marketplace registry (Approach 1) ──
  route.get("/plugins/marketplace/capabilities", (c) => {
    try {
      const svc = getMarketplaceService();
      return c.json({
        ...svc.getCapabilityContract(),
        registry: svc.getRegistryStatus(),
      });
    } catch (err: any) {
      return c.json({
        schemaVersion: 1,
        supported: false,
        version: "plugin-marketplace-capabilities.v1",
        code: "PLUGIN_MARKETPLACE_UNSUPPORTED_SERVER",
        message: err?.message || "Plugin marketplace service is unavailable on this server",
        upgradeGuidance: "Upgrade the connected Hana server to a build with plugin-marketplace-capabilities.v1.",
      }, 501);
    }
  });

  route.get("/plugins/marketplace/sources", async (c) => {
    const { principal } = principalFlags(c);
    const forRemote = !isLocalOwnerPrincipal(principal);
    const svc = getMarketplaceService();
    // Seed official snapshot before listing so local Settings is not empty/error on first open.
    await svc.ensureOfficialSnapshotSeededAsync();
    return c.json({
      capabilities: svc.getCapabilityContract(),
      registry: svc.getRegistryStatus(),
      sources: svc.listSources({ forRemote }),
    });
  });

  route.post("/plugins/marketplace/sources", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService();
      const result = await svc.addSource(body, {
        isStudioOwner: flags.isStudioOwner,
        isLocalOwner: flags.isLocalOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      });
      return c.json(result, 201);
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, err.status || 400);
    }
  });

  route.delete("/plugins/marketplace/sources/:marketplaceId", (c) => {
    const flags = principalFlags(c);
    try {
      const svc = getMarketplaceService();
      const result = svc.removeSource(c.req.param("marketplaceId"), {
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromQuery(c),
      });
      return c.json(result);
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, err.status || 400);
    }
  });

  route.put("/plugins/marketplace/sources/:marketplaceId/enabled", async (c) => {
    const flags = principalFlags(c);
    const body = await c.req.json().catch(() => ({}));
    try {
      const svc = getMarketplaceService();
      const result = svc.setSourceEnabled(c.req.param("marketplaceId"), body.enabled !== false, {
        isStudioOwner: flags.isStudioOwner,
        ...expectedRegistryPreconditionsFromBody(body),
      });
      return c.json(result);
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, err.status || 400);
    }
  });

  route.post("/plugins/marketplace/sources/:marketplaceId/refresh", async (c) => {
    const flags = principalFlags(c);
    try {
      const svc = getMarketplaceService();
      const status = await svc.refreshSource(c.req.param("marketplaceId"), {
        isStudioOwner: flags.isStudioOwner,
      });
      return c.json({ marketplaceId: c.req.param("marketplaceId"), status });
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
      }, err.status || 400);
    }
  });

  route.get("/plugins/marketplace/catalog", async (c) => {
    const flags = principalFlags(c);
    const forRemote = !flags.isLocalOwner;
    const svc = getMarketplaceService();
    await svc.ensureOfficialSnapshotSeededAsync();
    return c.json({
      capabilities: svc.getCapabilityContract(),
      registry: svc.getRegistryStatus(),
      ...svc.listCatalogRows({ forRemote }),
    });
  });

  route.post("/plugins/:pluginId/source-switch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const pluginId = c.req.param("pluginId");
    try {
      const records = new PluginInstallRecords({ hanakoHome: engine.hanakoHome });
      const artifacts = new PluginArtifactStore({ hanakoHome: engine.hanakoHome });
      const pluginsDir = path.join(engine.hanakoHome, "plugins");
      const coordinator = new PluginSourceSwitchCoordinator({
        records,
        artifacts,
        pluginsDir,
        runtime: {
          async unloadActive(id) {
            await engine.pluginManager?.disablePlugin?.(id)?.catch?.(() => {});
          },
          async activateCandidate(input) {
            // Re-scan/load after active projection swap when plugin manager is present.
            await engine.pluginManager?.installPlugin?.(input.artifactPath)?.catch?.(() => {});
            await engine.pluginManager?.enablePlugin?.(input.pluginId)?.catch?.(() => {});
          },
          async healthCheck() {
            return true;
          },
        },
      });
      const result = await coordinator.switchSource({
        pluginId,
        marketplaceId: body.marketplaceId,
        artifactDigest: body.artifactDigest,
        version: body.version,
      });
      return c.json(result, result.ok ? 200 : 409);
    } catch (err: any) {
      return c.json({
        error: err.message,
        code: err.code || "PLUGIN_SOURCE_SWITCH_HEALTH_FAILED",
      }, err.status || 500);
    }
  });

  route.get("/plugins/marketplace", async (c) => {
    const pm = engine.pluginManager;
    const marketplace = getMarketplace();
    const data = await marketplace.load();
    const appVersion = getEngineAppVersion(engine);
    reconcileMissingPluginDirectories(engine, pm);
    const installed = new Map<string, any>((pm?.listPlugins?.({ source: "community" }) || []).map((plugin: any) => [plugin.id, plugin]));
    return c.json({
      ...data,
      plugins: data.plugins.map((plugin) => {
        const installedPlugin = installed.get(plugin.id);
        const installRecord = readLiveOrReconciledInstallRecord(engine, pm, plugin.id, installedPlugin);
        const installedVersion = installedPlugin?.version || installRecord?.installedVersion || null;
        const versionState = getMarketplacePluginVersionState(plugin, {
          appVersion,
          installedVersion,
        });
        const installCandidate = marketplacePluginForVersion(plugin, versionState);
        return {
          ...sanitizeMarketplacePluginForClient(plugin),
          installed: !!installedPlugin,
          ...versionState,
          canInstall: versionState.canInstall && isMarketplacePluginInstallable(installCandidate, marketplace),
        };
      }),
    });
  });

  route.get("/plugins/marketplace/:id/readme", async (c) => {
    const pluginId = c.req.param("id");
    const marketplaceId = c.req.query("marketplaceId") || null;
    try {
      // Prefer multi-source snapshot README when HANA home + marketplaceId/resolvable row exist.
      if (engine.hanakoHome) {
        try {
          const svc = getMarketplaceService();
          const resolved = svc.resolveInstall(pluginId, marketplaceId);
          if (resolved.ok === true) {
            const row = svc.getCatalogPlugin(pluginId, resolved.row.marketplaceId);
            if (row?.readme) {
              return c.json({
                pluginId,
                marketplaceId: resolved.row.marketplaceId,
                markdown: row.readme,
              });
            }
            if (row?.readmeUrl) {
              const { safeFetchText } = await import("../../lib/plugin-marketplace-network-policy.ts");
              const markdown = await safeFetchText(row.readmeUrl, {
                fetchImpl: engine.fetch || globalThis.fetch,
                allowQuery: true,
              });
              return c.json({
                pluginId,
                marketplaceId: resolved.row.marketplaceId,
                markdown,
              });
            }
            // Claude / multi-source rows often have description only — soft empty, not 404.
            if (row) {
              return c.json({
                pluginId,
                marketplaceId: resolved.row.marketplaceId,
                markdown: row.description || "",
              });
            }
          } else if (marketplaceId && resolved.ok === false) {
            return c.json({
              error: resolved.message || "not found",
              code: `PLUGIN_MARKETPLACE_${resolved.code}`,
            }, resolved.code === "AMBIGUOUS" || resolved.code === "INCOMPLETE" ? 409 : 404);
          }
        } catch {
          // Fall through to legacy single-source path.
        }
      }

      // Legacy single-source fallback
      const marketplace = getMarketplace();
      const readme = await marketplace.getReadme(pluginId);
      if (readme === null) return c.json({ error: "not found" }, 404);
      return c.json({ pluginId, markdown: readme });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/plugins/marketplace/:id/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const pluginId = c.req.param("id");
    const {
      sessionPath,
      version: targetVersion,
      allowDowngrade = false,
      marketplaceId: requestedMarketplaceId = null,
    } = await c.req.json().catch(() => ({}));

    try {
      const marketplace = getMarketplace();
      let plugin: any = null;
      let sourceMarketplaceId: string | null = null;
      let catalogSha256: string | null = null;
      let sourceFingerprint: string | null = null;
      let svc: PluginMarketplaceService | null = null;
      let resolution: ReturnType<PluginMarketplaceService["resolveInstall"]> | null = null;
      let pluginFromMultiSource = false;

      // Multi-source resolve first when durable home exists (official-wins / qualified / ambiguous).
      if (engine.hanakoHome) {
        svc = getMarketplaceService();
        resolution = svc.resolveInstall(pluginId, requestedMarketplaceId);
        if (resolution.ok === true) {
          sourceMarketplaceId = resolution.row.marketplaceId;
          plugin = svc.getCatalogPlugin(pluginId, sourceMarketplaceId);
          pluginFromMultiSource = !!plugin;
          const status = svc.snapshots.getStatus(sourceMarketplaceId);
          if (status.state === "ok" || status.state === "stale" || status.state === "refreshing") {
            catalogSha256 = status.current?.catalogSha256 || null;
            sourceFingerprint = status.current?.sourceFingerprint || null;
          }
        } else if (requestedMarketplaceId && resolution.ok === false) {
          throw createPluginRouteError(
            resolution.message || `Cannot resolve ${pluginId}@${requestedMarketplaceId}`,
            resolution.code === "AMBIGUOUS" || resolution.code === "INCOMPLETE" || resolution.code === "OFFICIAL_UNAVAILABLE"
              ? 409
              : 404,
            `PLUGIN_MARKETPLACE_${resolution.code}`,
          );
        }
      }

      // Legacy single-catalog fallback when multi-source has no snapshot yet.
      if (!plugin) {
        const marketplaceData = await marketplace.load();
        plugin = marketplaceData.plugins.find((item) => item.id === pluginId) || null;
        if (!plugin) {
          if (resolution && resolution.ok === false) {
            throw createPluginRouteError(
              resolution.message || "not found",
              resolution.code === "AMBIGUOUS" || resolution.code === "INCOMPLETE" || resolution.code === "OFFICIAL_UNAVAILABLE"
                ? 409
                : 404,
              `PLUGIN_MARKETPLACE_${resolution.code}`,
            );
          }
          return c.json({ error: "not found" }, 404);
        }
        sourceMarketplaceId = sourceMarketplaceId || "oh-plugins-official";
      }

      const installedPlugin = (pm.listPlugins?.({ source: "community" }) || []).find((item) => item.id === plugin.id);
      const installRecord = readLiveOrReconciledInstallRecord(engine, pm, plugin.id, installedPlugin);
      // Lifecycle ops must stay pinned to the active marketplace when already installed.
      if (installedPlugin && installRecord?.activeMarketplaceId && requestedMarketplaceId
        && installRecord.activeMarketplaceId !== requestedMarketplaceId
        && !allowDowngrade) {
        // Fresh install from another source while one is active is a source-switch concern.
        // Still allow install if the user explicitly targets a marketplace (retain both).
      }
      const installedVersion = installedPlugin?.version || installRecord?.installedVersion || null;
      const versionState = getMarketplacePluginVersionState(plugin, {
        appVersion: getEngineAppVersion(engine),
        installedVersion,
        targetVersion,
      });
      if (!versionState.compatible || !versionState.selectedVersion) {
        throw createPluginRouteError("Plugin is incompatible with this app version", 409, "PLUGIN_VERSION_INCOMPATIBLE");
      }
      if (versionState.downgrade && allowDowngrade !== true) {
        throw createPluginRouteError(
          `Installing v${versionState.selectedVersion} would downgrade installed v${installedVersion}`,
          409,
          "PLUGIN_VERSION_DOWNGRADE",
        );
      }
      // Claude catalog → skills-lane (not Hana deep plugin zip).
      const claudeInstall = plugin?.install && typeof plugin.install === "object"
        ? plugin.install as Record<string, unknown>
        : null;
      if (claudeInstall?.catalogFormat === "claude") {
        if (!svc || !sourceMarketplaceId) {
          return c.json({ error: "Claude marketplace install requires multi-source service" }, 400);
        }
        const userSkillsDir = engine.userSkillsDir;
        if (!userSkillsDir) {
          return c.json({ error: "User skills directory not available" }, 500);
        }
        try {
          const flags = principalFlags(c);
          const result = await svc.installClaudePluginSkills(plugin.id, sourceMarketplaceId, {
            userSkillsDir,
            isStudioOwner: flags.isStudioOwner,
          });
          try {
            await engine.reloadSkills?.();
          } catch {
            // best-effort reload
          }
          return c.json({
            ok: true,
            installTarget: "hana-skills",
            catalogFormat: "claude",
            marketplaceId: result.marketplaceId,
            pluginId: result.pluginId,
            skills: result.skills,
            skipped: result.skipped,
            warnings: result.warnings,
            resolvedRevision: result.resolvedRevision,
          });
        } catch (err: any) {
          const status = err?.status || 400;
          return c.json({
            error: err?.message || String(err),
            code: err?.code || "PLUGIN_MARKETPLACE_SOURCE_INVALID",
            ...(Array.isArray(err?.skipped) ? { skipped: err.skipped } : {}),
            ...(Array.isArray(err?.warnings) ? { warnings: err.warnings } : {}),
          }, status);
        }
      }

      const marketplaceInspection = inspectMarketplacePackage(plugin);
      if (svc && sourceMarketplaceId && pluginFromMultiSource && marketplaceInspection.destination === "native-plugin") {
        throw createPluginRouteError(
          "Native marketplace install is preview-only until the PluginManager contract audit and Agent Plugin Access routing are complete.",
          409,
          "PLUGIN_MARKETPLACE_NATIVE_INSTALL_PREVIEW_ONLY",
        );
      }

      const installCandidate = marketplacePluginForVersion(plugin, versionState);
      const sourcePath = marketplace.resolveSourceDistribution(installCandidate)
        || (installCandidate.distribution?.kind === "source" && installCandidate.distribution?.path
          ? installCandidate.distribution.path
          : null);
      const installPath = sourcePath || await downloadMarketplaceRelease({ engine, plugin: installCandidate });
      const packageSha256 = installCandidate.distribution?.sha256
        && /^[a-f0-9]{64}$/.test(installCandidate.distribution.sha256)
        ? installCandidate.distribution.sha256
        : null;

      // Retain immutable artifact before activating when we have a digest.
      let artifactPath = installPath;
      if (svc && packageSha256 && engine.hanakoHome && fs.existsSync(installPath)) {
        try {
          const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-retain-"));
          // installPath may be a zip or a directory
          let packageDir = installPath;
          if (fs.statSync(installPath).isFile()) {
            await extractZip(installPath, extractDir);
            packageDir = extractDir;
          }
          const retained = svc.artifacts.retain({
            marketplaceId: sourceMarketplaceId!,
            pluginId: plugin.id,
            artifactDigest: packageSha256,
            version: versionState.selectedVersion,
            sourceFingerprint: sourceFingerprint || "0".repeat(64),
            catalogSha256: catalogSha256 || "0".repeat(64),
            packageSha256,
            packageUrl: installCandidate.distribution?.packageUrl,
            packageDir,
          });
          artifactPath = retained.artifactPath;
        } catch (retainErr: any) {
          log.warn?.(`artifact retain failed (continuing install): ${retainErr?.message || retainErr}`);
        }
      }

      const entry = await installPluginFromPath({
        engine,
        pm,
        sourcePath: installPath,
        sessionPath,
        expectedPluginId: plugin.id,
        expectedVersion: versionState.selectedVersion,
        allowDowngrade: allowDowngrade === true,
        installRecord: {
          source: "marketplace",
          marketplaceId: sourceMarketplaceId,
          marketplaceSource: sourceMarketplaceId,
          distributionKind: installCandidate.distribution?.kind || null,
          packageUrl: installCandidate.distribution?.packageUrl || null,
          sha256: packageSha256,
          sourceFingerprint: sourceFingerprint || undefined,
          catalogSha256: catalogSha256 || undefined,
          artifactPath,
        },
      });

      // Ensure install-record v2 active pointer after legacy installPluginFromPath write.
      if (svc && packageSha256 && sourceMarketplaceId) {
        try {
          svc.records.retainAndActivate({
            pluginId: plugin.id,
            marketplaceId: sourceMarketplaceId,
            artifactDigest: packageSha256,
            version: versionState.selectedVersion,
            sourceFingerprint: sourceFingerprint || "0".repeat(64),
            catalogSha256: catalogSha256 || "0".repeat(64),
            packageSha256,
            packageUrl: installCandidate.distribution?.packageUrl,
            artifactPath,
            action: installedPlugin ? "update" : "install",
            result: "ok",
          });
        } catch (recErr: any) {
          log.warn?.(`install record v2 update failed: ${recErr?.message || recErr}`);
        }
      }

      return c.json({
        ...entry,
        marketplaceId: sourceMarketplaceId,
        artifactDigest: packageSha256,
      });
    } catch (err: any) {
      return c.json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      }, err.status || 500);
    }
  });

  route.get("/plugins/:id/config-schema", (c) => {
    const pm = engine.pluginManager;
    const schema = pm?.getConfigSchema(c.req.param("id"));
    if (!schema) return c.json({ error: "not found" }, 404);
    return c.json(schema);
  });

  route.get("/plugins/:id/config", (c) => {
    const pm = engine.pluginManager;
    const config = pm?.getConfig(c.req.param("id"), {
      scope: c.req.query("scope") || "global",
      agentId: c.req.query("agentId") || undefined,
      sessionId: c.req.query("sessionId") || undefined,
      sessionPath: c.req.query("sessionPath") || undefined,
      legacySessionPath: c.req.query("legacySessionPath") || undefined,
    });
    if (!config) return c.json({ error: "not found" }, 404);
    return c.json(config);
  });

  route.put("/plugins/:id/config", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const body = await c.req.json();
    try {
      const { values, scope, agentId, sessionId, sessionPath, legacySessionPath } = decodeHttpConfigBody(body);
      const config = pm.setConfig(c.req.param("id"), values, {
        scope,
        agentId,
        sessionId,
        sessionPath,
        legacySessionPath,
      });
      const { rawValues: _rawValues, ...safeConfig } = config;
      return c.json(safeConfig);
    } catch (err) {
      if (err?.code === "PLUGIN_CONFIG_INVALID") {
        return c.json({ error: err.message, code: err.code, fields: err.errors || [] }, 400);
      }
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Plugin install ──
  route.post("/plugins/install", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const { path: sourcePath, sessionPath, allowDowngrade = false } = await c.req.json();
    if (!sourcePath) return c.json({ error: "path is required" }, 400);

    try {
      return c.json(await installPluginFromPath({ engine, pm, sourcePath, sessionPath, allowDowngrade }));
    } catch (err) {
      return c.json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      }, err.status || 500);
    }
  });

  // ── Plugin delete ──
  route.delete("/plugins/:id", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    try {
      const pluginDir = await pm.removePlugin(id, { source: "community" });
      await engine.syncPluginExtensions();
      removePluginInstallRecord(engine, id);
      if (pluginDir && fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Plugin enable/disable ──
  route.put("/plugins/:id/enabled", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const id = c.req.param("id");
    const { enabled } = await c.req.json();
    try {
      if (enabled) {
        await pm.enablePlugin(id, { source: "community" });
      } else {
        await pm.disablePlugin(id, { source: "community" });
      }
      await engine.syncPluginExtensions();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 404);
    }
  });

  // ── Global plugin settings ──
  route.get("/plugins/settings", (c) => {
    const pm = engine.pluginManager;
    const canSeeLocalPaths = isLocalOwnerPrincipal(readAuthPrincipal(c));
    return c.json({
      allow_full_access: pm?.getAllowFullAccess() || false,
      plugin_dev_tools_enabled: typeof engine.getPluginDevToolsEnabled === "function"
        ? engine.getPluginDevToolsEnabled()
        : false,
      plugins_dir: canSeeLocalPaths ? (pm?.getUserPluginsDir() || "") : "",
    });
  });

  route.put("/plugins/settings", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    const { allow_full_access, plugin_dev_tools_enabled } = await c.req.json();
    if (typeof allow_full_access === "boolean") {
      await pm.setFullAccess(allow_full_access);
      await engine.syncPluginExtensions();
    }
    if (typeof plugin_dev_tools_enabled === "boolean" && typeof engine.setPluginDevToolsEnabled === "function") {
      engine.setPluginDevToolsEnabled(plugin_dev_tools_enabled);
    }
    return c.json(visiblePlugins(pm, { source: "community" }));
  });

  // ── Plugin UI panel endpoints ──

  route.get("/plugins/pages", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const pages = pm.getPages().map(p => ({
      pluginId: p.pluginId,
      title: p.title,
      icon: p.icon,
      routeUrl: `/api/plugins/${p.pluginId}${p.route}`,
      hostCapabilities: Array.isArray(p.hostCapabilities) ? p.hostCapabilities : [],
    }));
    return c.json(pages);
  });

  route.get("/plugins/widgets", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const widgets = pm.getWidgets().map(w => ({
      pluginId: w.pluginId,
      title: w.title,
      icon: w.icon,
      routeUrl: `/api/plugins/${w.pluginId}${w.route}`,
      hostCapabilities: Array.isArray(w.hostCapabilities) ? w.hostCapabilities : [],
    }));
    return c.json(widgets);
  });

  route.get("/plugins/ui-host-capabilities", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    return c.json(pm.getUiHostCapabilityGrants?.() || []);
  });

  route.get("/plugins/settings-tabs", (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json([]);
    const tabs = pm.getSettingsTabs().map(t => ({
      pluginId: t.pluginId,
      id: t.id,
      title: t.title,
      icon: t.icon,
      nativeComponent: t.nativeComponent,
    }));
    return c.json(tabs);
  });

  route.post("/plugins/iframe-ticket", async (c) => {
    const pm = engine.pluginManager;
    if (!pm) return c.json({ error: "Plugin manager not available" }, 500);
    try {
      const body = await c.req.json();
      const { pluginId, surfacePath } = parsePluginIframeSurfaceRoute(body?.routeUrl);
      assertPluginIframeSurfaceAllowed({ pluginId, surfacePath });
      if (!pm.getRouteApp(pluginId)) {
        return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
      }
      const principal = (c as any).get("authPrincipal");
      const principalId = principal?.principalId || "principal_unknown";
      const issued = issuePluginIframeTicket({
        hanakoHome: engine.hanakoHome,
        pluginId,
        surfacePath,
        principalId,
      } as any);
      // Surface session 与 ticket 一并签发：ticket 只负责该 surface 的文档加载，
      // surface session 是页面脚本调用本插件 route handler 的请求级入口凭证。
      const surfaceSession = issuePluginSurfaceSession({
        hanakoHome: engine.hanakoHome,
        pluginId,
        principalId,
      } as any);
      return c.json({
        ticket: issued.ticket,
        ticketId: issued.ticketId,
        pluginId,
        surfacePath,
        expiresAt: issued.expiresAt,
        surfaceSession: {
          token: surfaceSession.token,
          expiresAt: surfaceSession.expiresAt,
        },
      });
    } catch (err) {
      return c.json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      }, err.status || 400);
    }
  });

  route.get("/plugins/theme.css", (c) => {
    const theme = c.req.query("theme") || DEFAULT_THEME;
    // Sanitize theme name to prevent path traversal
    const safeName = path.basename(theme).replace(/[^a-zA-Z0-9_-]/g, "");
    const candidates = [
      fromRoot("desktop", "src", "themes", `${safeName}.css`),
      fromRoot("desktop", "dist-renderer", "themes", `${safeName}.css`),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) {
      c.header("Content-Type", "text/css");
      return c.body("/* theme not found */");
    }
    let css = fs.readFileSync(found, "utf-8");
    // Flatten selectors for iframe consumption:
    // [data-theme="xxx"], :root:not([data-theme]) → :root
    // [data-theme="xxx"] → :root
    css = css.replace(/\[data-theme="[^"]*"\](?:,\s*:root:not\(\[data-theme\]\))?/g, ":root");
    c.header("Content-Type", "text/css");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(css);
  });

  route.get("/plugins/:pluginId/assets/*", (c) => servePluginAsset(c, engine, false));
  route.on("HEAD", "/plugins/:pluginId/assets/*", (c) => servePluginAsset(c, engine, true));

  // ── Plugin route proxy (catch-all last) ──

  route.all("/plugins/:pluginId/*", async (c) => {
    const pluginId = c.req.param("pluginId");
    // Host-owned path segments must never be treated as community plugin ids.
    if (PLUGIN_HOST_ROUTE_PLUGIN_IDS.has(pluginId)) {
      return c.json({ error: "not found", code: "PLUGIN_HOST_ROUTE" }, 404);
    }
    const pluginApp = engine.pluginManager?.getRouteApp(pluginId);
    if (!pluginApp) return c.json({ error: `Plugin "${pluginId}" not found` }, 404);
    let iframeTicket = null;
    try {
      iframeTicket = verifyPluginIframeTicketForRequest(c, engine, pluginId);
    } catch (err) {
      if (err instanceof PluginIframeTicketError) {
        return c.json({ error: (err as any).code, detail: err.message }, (err as any).status);
      }
      throw err;
    }
    const url = new URL(c.req.url);
    const prefix = `/plugins/${pluginId}`;
    const prefixIndex = url.pathname.indexOf(prefix);
    const subPath = prefixIndex !== -1
      ? url.pathname.slice(prefixIndex + prefix.length) || "/"
      : "/";
    await engine.pluginManager?.activatePluginRoute?.(pluginId, subPath);
    // The plugin contract lets a surface run without an agent, so an absent
    // agentId is an answer rather than a question: pass null through instead of
    // handing the plugin whichever agent the server happens to be focused on.
    const requestedAgentId = c.req.query("agentId") || null;
    let agentId: string | null = null;
    if (requestedAgentId) {
      const agent = engine.getAgent(requestedAgentId);
      if (!agent) return c.json({ error: `agent "${requestedAgentId}" not found` }, 404);
      agentId = agent.id;
    }
    const requestPrincipal = pluginRouteRequestPrincipal(readAuthPrincipal(c), iframeTicket, pluginId);
    const response = await proxyToPlugin(c, pluginApp, pluginId, agentId, requestPrincipal);
    return appendPluginAssetSessionCookie(c, engine, pluginId, response, iframeTicket);
  });

  return route;
}
