/**
 * Skills 管理路由
 *
 * GET    /skills              — 列出所有可用 skill（含当前 agent 的 enabled 状态）
 * PUT    /agents/:id/skills   — 更新指定 agent 的 enabled skills 列表
 * PATCH  /agents/:id/skills/:name — 增量启用/停用单个 skill
 * PATCH  /agents/:id/skill-bundles/:bundleId — 增量启用/停用 bundle 内 skills
 * POST   /skills/install      — 安装用户技能（文件夹路径 / .zip / .skill）
 * DELETE /skills/:name        — 删除用户技能
 */
import path from "path";
import fs from "fs";
import { Hono } from "hono";
import { emitAppEvent } from "../app-events.ts";
import { safeJson } from "../hono-helpers.ts";
import { loadConfig, saveConfig } from "../../lib/memory/config-loader.ts";
import {
  installSkillPackageFromPath,
  sanitizeSkillName,
} from "../../lib/skills/skill-package-installer.ts";
import { t } from "../../lib/i18n.ts";
import { validateId, agentExists } from "../utils/validation.ts";
import { registerSessionFileFromRequest } from "../../lib/session-files/session-file-response.ts";
import {
  createSkillBundle,
  deleteSkillBundle,
  loadSkillBundleStore,
  removeSkillsFromBundles,
  reorderSkillBundles,
  updateSkillBundle,
} from "../../lib/skill-bundles/store.ts";
import { exportSkillBundlePackage } from "../../lib/skill-bundles/package-service.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";
import { materializeUploadedSkillPackage } from "../utils/uploaded-skill-package.ts";
import { removeAgentSkillReferences } from "../../lib/skills/remove-skill-references.ts";
import { setMarketplaceSkillPreference } from "../../lib/marketplace-skill-preferences.ts";

const log = createModuleLogger("skills");
const MAX_SKILL_PREVIEW_BYTES = 2 * 1024 * 1024;
const SKILL_PREVIEW_IGNORED_DIRS = new Set([
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  "__pycache__",
  "coverage",
  "venv",
  ".venv",
]);

/** 递归删除目录 */
function rmDirSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function installErrorMessage(err, sourcePath) {
  switch (err?.code) {
    case "SKILL_SOURCE_MUST_BE_ABSOLUTE":
      return t("error.skillNeedAbsolutePath");
    case "SKILL_SOURCE_NOT_FOUND":
      return t("error.skillPathNotExists");
    case "SKILL_UNSUPPORTED_FORMAT":
      return t("error.skillUnsupportedFormat");
    case "SKILL_MISSING_SKILL_MD": {
      const isArchive = [".zip", ".skill"].includes(path.extname(sourcePath || "").toLowerCase());
      return isArchive ? t("error.skillMissingSkillMdInZip") : t("error.skillMissingSkillMd");
    }
    case "SKILL_MISSING_NAME":
      return t("error.skillMissingName");
    case "SKILL_INVALID_NAME":
      return t("error.skillNameInvalid", { name: "" });
    default:
      return err?.message || "skill install failed";
  }
}

export function createSkillsRoute(engine) {
  const route = new Hono();

  // 安装/删除/reload 共享互斥锁，防止 reloadSkills() 并发导致 500
  let _installLock = Promise.resolve();
  function withInstallLock(fn) {
    const prev = _installLock;
    let resolve;
    _installLock = new Promise(r => { resolve = r; });
    return prev.then(fn).finally(resolve);
  }

  const agentSkillWriteLocks = new Map();

  function withAgentSkillWriteLock(agentId, fn) {
    const prev = agentSkillWriteLocks.get(agentId) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const cleanup = run.finally(() => {
      if (agentSkillWriteLocks.get(agentId) === cleanup) {
        agentSkillWriteLocks.delete(agentId);
      }
    });
    agentSkillWriteLocks.set(agentId, cleanup);
    return cleanup;
  }

  function bundleForResponse(bundle, skillByName = new Map()) {
    return {
      ...bundle,
      skills: bundle.skillNames.map((name) => {
        const skill = skillByName.get(name);
        if (!skill) {
          return { name, enabled: false, source: null, missing: true };
        }
        return {
          name,
          enabled: !!skill.enabled,
          source: skill.source || null,
          missing: false,
        };
      }),
    };
  }

  // Every bundle reply carries a per-agent enabled flag for each skill, and the
  // write routes check the requested skills against the same view. The request
  // has to say which agent it means: answering for whichever agent the server
  // was focused on showed one client the other client's switches, and let a
  // write be validated against an agent the caller never named.
  function resolveBundleSkillView(c) {
    const agentId = c.req.query("agentId") || "";
    if (!agentId) {
      const err: any = new Error("agentId required");
      err.status = 400;
      throw err;
    }
    if (!validateId(agentId) || !agentExists(engine, agentId)) {
      const err: any = new Error("agent not found");
      err.status = 404;
      throw err;
    }
    const skills = engine.getAllSkills(agentId) || [];
    return { agentId, skills, skillByName: new Map(skills.map(skill => [skill.name, skill])) };
  }

  function assertBundleSkillsInstalled(skillNames, skillByName) {
    const names = Array.isArray(skillNames) ? skillNames : [];
    for (const name of names) {
      const normalized = typeof name === "string" ? name.trim() : "";
      if (normalized && !skillByName.has(normalized)) {
        const err: any = new Error(`unknown skill in bundle: ${normalized}`);
        err.status = 400;
        throw err;
      }
    }
  }

  function validateAgentIdOrResponse(c, id) {
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    return null;
  }

  function resolveSkillPreviewTarget(c) {
    const name = sanitizeSkillName(c.req.param("name"));
    if (!name) {
      const err: any = new Error("invalid skill name");
      err.status = 400;
      throw err;
    }
    // A preview without agentId is a global installed-skill lookup. Falling
    // back to the server's UI focus would let one client preview another
    // client's per-agent skill view.
    const agentId = c.req.query("agentId") || "";
    if (agentId && (!validateId(agentId) || !agentExists(engine, agentId))) {
      const err: any = new Error("agent not found");
      err.status = 404;
      throw err;
    }
    const skills = agentId ? engine.getAllSkills(agentId) : (engine.getAllSkills?.() || []);
    const skill = skills.find(item => item?.name === name);
    const baseDir = skill?.sourceIdentity?.baseDir || skill?.baseDir;
    if (!skill || !baseDir || !path.isAbsolute(baseDir)) {
      const err: any = new Error("skill not found");
      err.status = 404;
      throw err;
    }
    let rootStat;
    try {
      rootStat = fs.statSync(baseDir);
    } catch {
      const err: any = new Error("skill not found");
      err.status = 404;
      throw err;
    }
    if (!rootStat.isDirectory()) {
      const err: any = new Error("skill not found");
      err.status = 404;
      throw err;
    }
    return { skill, baseDir: path.resolve(baseDir), agentId };
  }

  function normalizeSkillPreviewPath(rawPath) {
    const text = String(rawPath || "SKILL.md");
    if (!text || text.includes("\0") || path.isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text)) {
      const err: any = new Error("invalid skill file path");
      err.status = 400;
      throw err;
    }
    const parts = text.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length === 0 || parts.some(part => part === "." || part === "..")) {
      const err: any = new Error("invalid skill file path");
      err.status = 400;
      throw err;
    }
    return parts.join("/");
  }

  function isPathInside(childPath, rootPath) {
    const rel = path.relative(rootPath, childPath);
    return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  }

  function resolveSkillPreviewFile(baseDir, rawPath) {
    const relativePath = normalizeSkillPreviewPath(rawPath);
    const resolvedRoot = path.resolve(baseDir);
    const candidate = path.resolve(resolvedRoot, relativePath);
    if (!isPathInside(candidate, resolvedRoot)) {
      const err: any = new Error("invalid skill file path");
      err.status = 400;
      throw err;
    }
    let realRoot;
    let realFile;
    try {
      realRoot = fs.realpathSync(resolvedRoot);
      realFile = fs.realpathSync(candidate);
    } catch {
      const err: any = new Error("skill file not found");
      err.status = 404;
      throw err;
    }
    if (!isPathInside(realFile, realRoot)) {
      const err: any = new Error("invalid skill file path");
      err.status = 400;
      throw err;
    }
    return { relativePath, filePath: realFile };
  }

  function scanSkillPreviewDir(dir, rootDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith("."))
      .filter(entry => !entry.isDirectory() || !SKILL_PREVIEW_IGNORED_DIRS.has(entry.name))
      .sort((a, b) => {
        if (a.name === "SKILL.md") return -1;
        if (b.name === "SKILL.md") return 1;
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
    return entries.map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: relativePath,
          isDir: true,
          children: scanSkillPreviewDir(fullPath, rootDir),
        };
      }
      return { name: entry.name, path: relativePath, isDir: false };
    });
  }

  function readSkillPreviewText(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      const err: any = new Error("skill file not found");
      err.status = 404;
      throw err;
    }
    if (stat.size > MAX_SKILL_PREVIEW_BYTES) {
      const err: any = new Error("skill file is too large");
      err.status = 413;
      throw err;
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) {
      const err: any = new Error("skill file is not text");
      err.status = 415;
      throw err;
    }
    return buffer.toString("utf-8");
  }

  function readAgentConfig(agentId) {
    const agent = engine.getAgent?.(agentId);
    if (agent?.config) return agent.config;
    const configPath = path.join(engine.agentsDir, agentId, "config.yaml");
    try {
      return loadConfig(configPath);
    } catch {
      return {};
    }
  }

  function marketplaceOverridesPatch(current, next) {
    const currentRecord = current && typeof current === "object" && !Array.isArray(current)
      ? current
      : {};
    const nextRecord = next && typeof next === "object" && !Array.isArray(next)
      ? next
      : {};
    const patch = { ...nextRecord };

    // Config persistence is a deep merge: an empty object does not remove
    // existing child keys. Add explicit null tombstones for package entries
    // that disappeared so enabling the last disabled skill actually clears
    // that package's preference while preserving sibling packages.
    for (const key of Object.keys(currentRecord)) {
      if (!Object.prototype.hasOwnProperty.call(nextRecord, key)) patch[key] = null;
    }
    return patch;
  }

  async function persistSkillPreferences(agentId, enabled, marketplaceOverrides) {
    const currentMarketplaceOverrides = marketplaceOverrides === undefined
      ? undefined
      : readAgentConfig(agentId)?.skills?.marketplace_overrides;
    const partial = {
      skills: {
        enabled,
        ...(marketplaceOverrides === undefined
          ? {}
          : { marketplace_overrides: marketplaceOverridesPatch(currentMarketplaceOverrides, marketplaceOverrides) }),
      },
    };

    // 走 engine.updateConfig (ConfigCoordinator)，它会在 partial.skills 存在时
    // 调用 syncAgentSkills 把新 enabled 列表同步到 agent 的内存态和 system prompt。
    // 直接调 agent.updateConfig 会绕过这一步，导致写盘成功但内存未刷新。
    const agent = engine.getAgent?.(agentId);
    if (agent) {
      await engine.updateConfig(partial, { agentId });
    } else {
      const configPath = path.join(engine.agentsDir, agentId, "config.yaml");
      saveConfig(configPath, partial);
    }
    return enabled;
  }

  function visibleSkillsForAgent(agentId) {
    const skills = engine.getAllSkills(agentId) || [];
    return {
      skills,
      visibleSet: new Set(skills.map(skill => skill.name)),
      skillByName: new Map<string, any>(skills.map(skill => [skill.name, skill] as [string, any])),
    };
  }

  async function writeSkillDelta(agentId, skillNames, enable) {
    const requested: string[] = [...new Set<string>(
      skillNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim())),
    )];
    return withAgentSkillWriteLock(agentId, async () => {
      const { skills, visibleSet, skillByName } = visibleSkillsForAgent(agentId);
      const changed = requested.filter(name => visibleSet.has(name));
      const config = readAgentConfig(agentId);
      const rawEnabled = Array.isArray(config?.skills?.enabled) ? config.skills.enabled : null;
      const currentEnabled = new Set(rawEnabled || skills
        .filter(skill => !skill.marketplacePackage && skill.enabled)
        .map(skill => skill.name));
      let marketplaceOverrides = config?.skills?.marketplace_overrides;
      for (const name of changed) {
        const skill = skillByName.get(name);
        if (skill?.marketplacePackage?.identity) {
          marketplaceOverrides = setMarketplaceSkillPreference(
            marketplaceOverrides,
            skill.marketplacePackage.identity,
            skill.marketplacePackage.skillName || name,
            enable,
          );
        } else if (enable) {
          currentEnabled.add(name);
        } else {
          currentEnabled.delete(name);
        }
      }
      const enabledNames = rawEnabled
        ? [...new Set(rawEnabled.filter(name => typeof name === "string"))]
        : [];
      const enabled = rawEnabled
        ? enabledNames.filter(name => currentEnabled.has(name))
        : skills.filter(skill => !skill.marketplacePackage && currentEnabled.has(skill.name)).map(skill => skill.name);
      // Append newly enabled ordinary skills in the same order as the request;
      // preserve the historical list shape while keeping package defaults out
      // of skills.enabled.
      for (const name of changed) {
        const skill = skillByName.get(name);
        if (!skill?.marketplacePackage && enable && !enabled.includes(name)) enabled.push(name);
      }
      await persistSkillPreferences(
        agentId,
        enabled,
        changed.some(name => skillByName.get(name)?.marketplacePackage) ? marketplaceOverrides : undefined,
      );
      emitAppEvent(engine, "skills-changed", { agentId });
      return { enabled, changed };
    });
  }

  route.get("/skills/bundles", async (c) => {
    try {
      const { skillByName } = resolveBundleSkillView(c);
      const store = loadSkillBundleStore(engine);
      const bundles = store.bundles.map(bundle => bundleForResponse(bundle, skillByName));
      return c.json({ bundles });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.post("/skills/bundles", async (c) => {
    try {
      const body = await safeJson(c);
      const { skillByName } = resolveBundleSkillView(c);
      assertBundleSkillsInstalled(body.skillNames, skillByName);
      const bundle = createSkillBundle(engine, {
        name: body.name,
        skillNames: body.skillNames,
      } as any);
      emitAppEvent(engine, "skills-changed", { agentId: null });
      return c.json({ ok: true, bundle: bundleForResponse(bundle, skillByName) });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.put("/skills/bundles/order", async (c) => {
    try {
      const body = await safeJson(c);
      if (!Array.isArray(body.bundleIds)) {
        return c.json({ error: "bundleIds must be an array" }, 400);
      }
      const { skillByName } = resolveBundleSkillView(c);
      const store = reorderSkillBundles(engine, body.bundleIds);
      emitAppEvent(engine, "skills-changed", { agentId: null });
      return c.json({ ok: true, bundles: store.bundles.map(bundle => bundleForResponse(bundle, skillByName)) });
    } catch (err) {
      const status = /^(bundleIds must|unknown skill bundle)/.test(err.message) ? 400 : 500;
      return c.json({ error: err.message }, err.status || status);
    }
  });

  route.put("/skills/bundles/:id", async (c) => {
    try {
      const body = await safeJson(c);
      const { skillByName } = resolveBundleSkillView(c);
      if (Array.isArray(body.skillNames)) {
        assertBundleSkillsInstalled(body.skillNames, skillByName);
      }
      const bundle = updateSkillBundle(engine, c.req.param("id"), {
        name: body.name,
        skillNames: body.skillNames,
      });
      emitAppEvent(engine, "skills-changed", { agentId: null });
      return c.json({ ok: true, bundle: bundleForResponse(bundle, skillByName) });
    } catch (err) {
      return c.json({ error: err.message }, err.status || (err.message === "skill bundle not found" ? 404 : 500));
    }
  });

  route.delete("/skills/bundles/:id", async (c) => {
    try {
      const deleted = deleteSkillBundle(engine, c.req.param("id"));
      if (!deleted) return c.json({ error: "skill bundle not found" }, 404);
      emitAppEvent(engine, "skills-changed", { agentId: null });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.post("/skills/bundles/:id/export", async (c) => {
    try {
      const result = await exportSkillBundlePackage(engine, c.req.param("id"));
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.get("/skills", async (c) => {
    try {
      const agentId = c.req.query("agentId");
      const runtime = c.req.query("runtime") === "1";
      // 必须显式指定 agentId — 不允许从全局焦点指针推导，避免前后端 agent 错位
      // 后用户在 desk 上 toggle skill 时把错位 agent 的列表写入当前 agent (#397)
      if (!agentId) {
        return c.json({ error: "agentId is required" }, 400);
      }
      if (!validateId(agentId) || !agentExists(engine, agentId)) {
        return c.json({ error: "agent not found" }, 404);
      }
      return c.json({
        skills: runtime ? engine.getRuntimeSkills(agentId) : engine.getAllSkills(agentId),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/skills/:name/files", async (c) => {
    try {
      const { baseDir } = resolveSkillPreviewTarget(c);
      return c.json({ files: scanSkillPreviewDir(baseDir, baseDir) });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.get("/skills/:name/file", async (c) => {
    try {
      const { baseDir } = resolveSkillPreviewTarget(c);
      const { relativePath, filePath } = resolveSkillPreviewFile(baseDir, c.req.query("path") || "SKILL.md");
      return c.json({ path: relativePath, content: readSkillPreviewText(filePath) });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.put("/agents/:id/skills", async (c) => {
    const id = c.req.param("id");
    const invalidAgent = validateAgentIdOrResponse(c, id);
    if (invalidAgent) return invalidAgent;
    try {
      const body = await safeJson(c);
      const { enabled } = body;
      if (!Array.isArray(enabled)) {
        return c.json({ error: "enabled must be an array of skill names" }, 400);
      }

      // 防御性过滤：把请求体里的 enabled 与该 agent 实际可见的 skill 集合做交集，
      // 防止前端因 store 错位（例如 agent 切换 race）把别的 agent 的列表写进来 (#397)
      const persisted = await withAgentSkillWriteLock(id, async () => {
        const { skills, skillByName } = visibleSkillsForAgent(id);
        const visibleSet = new Set(skills.map(s => s.name));
        const filtered = enabled.filter(name => visibleSet.has(name));
        const config = readAgentConfig(id);
        const rawEnabled = Array.isArray(config?.skills?.enabled) ? config.skills.enabled : [];
        const ordinaryEnabled = filtered.filter(name => !skillByName.get(name)?.marketplacePackage);
        const packageNames = rawEnabled.filter(name => skillByName.get(name)?.marketplacePackage);
        const nextEnabled = [...new Set([...ordinaryEnabled, ...packageNames])];
        let marketplaceOverrides;
        for (const name of filtered) {
          const skill = skillByName.get(name);
          if (!skill?.marketplacePackage?.identity) continue;
          marketplaceOverrides = setMarketplaceSkillPreference(
            marketplaceOverrides === undefined ? config?.skills?.marketplace_overrides : marketplaceOverrides,
            skill.marketplacePackage.identity,
            skill.marketplacePackage.skillName || name,
            true,
          );
        }
        await persistSkillPreferences(
          id,
          nextEnabled,
          marketplaceOverrides === undefined ? undefined : marketplaceOverrides,
        );
        emitAppEvent(engine, "skills-changed", { agentId: id });
        return nextEnabled;
      });
      return c.json({ ok: true, enabled: persisted });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.patch("/agents/:id/skills/:name", async (c) => {
    const id = c.req.param("id");
    const invalidAgent = validateAgentIdOrResponse(c, id);
    if (invalidAgent) return invalidAgent;
    try {
      const body = await safeJson(c);
      if (typeof body.enabled !== "boolean") {
        return c.json({ error: "enabled must be a boolean" }, 400);
      }
      const name = c.req.param("name");
      const { visibleSet } = visibleSkillsForAgent(id);
      if (!visibleSet.has(name)) {
        return c.json({ error: "skill not found" }, 404);
      }
      const result = await writeSkillDelta(id, [name], body.enabled);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.patch("/agents/:id/skill-bundles/:bundleId", async (c) => {
    const id = c.req.param("id");
    const invalidAgent = validateAgentIdOrResponse(c, id);
    if (invalidAgent) return invalidAgent;
    try {
      const body = await safeJson(c);
      if (typeof body.enabled !== "boolean") {
        return c.json({ error: "enabled must be a boolean" }, 400);
      }
      const store = loadSkillBundleStore(engine);
      const bundle = store.bundles.find(item => item.id === c.req.param("bundleId"));
      if (!bundle) {
        return c.json({ error: "skill bundle not found" }, 404);
      }
      const result = await writeSkillDelta(id, bundle.skillNames, body.enabled);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  // ── 安装用户技能 ──
  route.post("/skills/install", async (c) => {
    return withInstallLock(async () => {
    let uploadedSource = null;
    try {
      const body = await safeJson(c);
      const { path: srcPath, sessionPath } = body;
      uploadedSource = srcPath ? null : materializeUploadedSkillPackage(engine, body);
      const sourcePath = srcPath || uploadedSource?.sourcePath;
      if (!sourcePath || !path.isAbsolute(sourcePath)) {
        return c.json({ error: t("error.skillNeedAbsolutePath") }, 400);
      }

      if (!fs.existsSync(sourcePath)) {
        return c.json({ error: t("error.skillPathNotExists") }, 400);
      }

      const sourceFile = srcPath
        ? registerSessionFileFromRequest(engine, {
          sessionPath,
          filePath: sourcePath,
          label: path.basename(sourcePath),
          origin: "skill_install_source",
          storageKind: "install_source",
        } as any)
        : null;

      const userDir = engine.userSkillsDir;
      let installed;
      try {
        // 手动安装（用户行为）不做 LLM 安全审查，只做包结构和文件系统安全校验。
        installed = await installSkillPackageFromPath({
          sourcePath,
          installDir: userDir,
          owner: "user",
        });
      } catch (err) {
        return c.json({ error: installErrorMessage(err, sourcePath) }, err.status || 400);
      }
      const safeName = installed.name;
      const installedSkillSource = installed.installedSkillSource;

      // 重新加载 skills
      await engine.reloadSkills();

      // 可选：如果传了 agentId 就顺便加入该 agent 的 enabled 列表（历史行为）。
      // 新布局下 SkillsTab 顶部"技能管理"区走全局安装（不传 agentId），只做
      // 文件注册；用户自己到 Agent 配置区打开开关。原则：全局的管全局的。
      const agentId = c.req.query("agentId");
      if (agentId) {
        const configPath = path.join(engine.agentsDir, agentId, "config.yaml");
        if (fs.existsSync(configPath)) {
          const { loadConfig } = await import("../../lib/memory/config-loader.ts");
          const cfg = loadConfig(configPath);
          const enabled = new Set(cfg?.skills?.enabled || []);
          enabled.add(safeName);
          // 走 ConfigCoordinator 路径：写盘 + syncAgentSkills 同步内存态
          // 必须传 agentId，否则 fallback 到焦点 agent 会同步错对象 (#397)
          await engine.updateConfig({ skills: { enabled: [...enabled] } }, { agentId });
        }
      }

      // 返回 skill 详情：传了 agentId 就给该 agent 的视角（含 enabled 开关）。
      // 全局安装没有 agent 视角可言，此时只回 skill 本身；借焦点 agent 的视角
      // 会把"某个 agent 有没有开这个技能"当成全局安装的结果报给调用方。
      const skill = agentId
        ? engine.getAllSkills(agentId).find(s => s.name === safeName)
        : null;
      emitAppEvent(engine, "skills-changed", { agentId: agentId || null });
      return c.json({
        ok: true,
        skill: skill || { name: safeName, type: "user" },
        installedSkillSource,
        ...(sourceFile ? { sourceFile } : {}),
      });
    } catch (err) {
      log.error(`install failed: ${err?.stack || err}`);
      return c.json({ error: err.message }, err.status || 500);
    } finally {
      uploadedSource?.cleanup?.();
    }
    }); // withInstallLock
  });

  // ── 外部兼容技能路径 ──
  route.get("/skills/external-paths", async (c) => {
    try {
      return c.json(engine.getExternalSkillPaths());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/skills/external-paths", async (c) => {
    try {
      const body = await safeJson(c);
      const { paths } = body;
      if (!Array.isArray(paths)) {
        return c.json({ error: "paths must be an array" }, 400);
      }
      for (const p of paths) {
        if (!path.isAbsolute(p)) {
          return c.json({ error: t("error.skillPathMustBeAbsolute", { path: p }) }, 400);
        }
        if (path.resolve(p) === path.resolve(engine.skillsDir)) {
          return c.json({ error: t("error.skillCannotAddSelfDir") }, 400);
        }
      }
      await engine.setExternalSkillPaths(paths);
      emitAppEvent(engine, "skills-changed", { agentId: null });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 删除技能 ──
  route.delete("/skills/:name", async (c) => {
    return withInstallLock(async () => {
    try {
      const name = c.req.param("name");
      if (!sanitizeSkillName(name)) {
        return c.json({ error: t("error.skillInvalidName") }, 400);
      }

      // Deleting a skill is destructive and the target agent decides which
      // skill is even visible, so the caller has to say which agent it means
      // rather than letting the server pick the one it happens to be focused
      // on.
      const queryAgentId = c.req.query("agentId");
      if (!queryAgentId) {
        return c.json({ error: "agentId required" }, 400);
      }
      if (!validateId(queryAgentId) || !agentExists(engine, queryAgentId)) {
        return c.json({ error: "agent not found" }, 404);
      }
      const targetAgentId = queryAgentId;

      // 外部技能不可删除（用该 agent 的视角查 readonly 即可，与 enabled 无关）
      const allSkills = targetAgentId ? engine.getAllSkills(targetAgentId) : [];
      const target = allSkills.find(s => s.name === name);
      if (target?.readonly) {
        return c.json({ error: t("error.skillExternalCannotDelete") }, 403);
      }

      const userSkillPath = path.join(engine.skillsDir, name);
      if (!fs.existsSync(userSkillPath)) {
        return c.json({ error: t("error.skillNotExists") }, 404);
      }

      // 删除目录
      rmDirSync(userSkillPath);

      // 从所有 agent 的 enabled 列表中移除
      const referenceCleanup = removeAgentSkillReferences(engine.agentsDir, [name]);
      for (const failure of referenceCleanup.failedAgents) {
        log.error(`清理 agent ${failure.agentId} 的 skill 引用失败: ${failure.error}`);
      }

      // 重新加载 skills
      await engine.reloadSkills();
      if (engine.hanakoHome) {
        removeSkillsFromBundles(engine, [name]);
      }

      emitAppEvent(engine, "skills-changed", { agentId: targetAgentId || null });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
    }); // withInstallLock
  });

  // POST /skills/reload — 强制重新加载所有技能
  route.post("/skills/reload", async (c) => {
    return withInstallLock(async () => {
    try {
      await engine.reloadSkills();
      // 不返回 skills 列表（缺乏 agent 上下文），前端会 fallback 到 GET /skills?agentId=X
      emitAppEvent(engine, "skills-changed", { agentId: null });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
    }); // withInstallLock
  });

  // POST /skills/translate — 用工具模型翻译技能名
  route.post("/skills/translate", async (c) => {
    const body = await safeJson(c);
    const { names, lang, agentId } = body;
    if (!Array.isArray(names) || !lang || lang === "en") {
      return c.json({});
    }
    if (!agentId) {
      return c.json({ error: "agentId is required" }, 400);
    }
    if (!validateId(agentId) || !agentExists(engine, agentId)) {
      return c.json({ error: "agent not found" }, 404);
    }
    const skills = engine.getAllSkills(agentId);
    return c.json(await engine.translateSkillNames(names, lang, { agentId, skills }));
  });

  return route;
}
