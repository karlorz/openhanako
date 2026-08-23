import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { healCredentialFileModes } from "../core/credential-file-healer.ts";
import { LOCAL_PROVIDER_PLUGINS_DIR } from "../core/local-provider-plugin-store.ts";
import {
  PLUGIN_CONFIG_FILENAME,
  PLUGIN_DATA_DIRNAME,
  PLUGIN_SECRETS_DIRNAME,
  PLUGIN_SECRETS_FILENAME,
} from "../core/plugin-config.ts";
import { SECURITY_DIR } from "../core/security-dir.ts";
import { PluginInstallRecords } from "../lib/plugin-install-records.ts";
import { SECRET_TMP_SUFFIX } from "../shared/secret-fs.ts";

const POSIX = process.platform !== "win32";

let home: string | null = null;

function makeHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-credential-healer-"));
  return home;
}

function writeOpen(relativePath: string, content = "{}\n") {
  const target = path.join(home!, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, 0o644);
  return target;
}

function writeOpenAt(target: string, content = "{}\n") {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, 0o644);
  return target;
}

function modeOf(target: string) {
  return fs.statSync(target).mode & 0o777;
}

function digest(character: string) {
  return character.repeat(64);
}

function registerMarketplaceInstall(
  records: PluginInstallRecords,
  marketplaceId: string,
  pluginId: string,
  artifactDigest: string,
) {
  records.retainAndActivate({
    marketplaceId,
    pluginId,
    artifactDigest,
    version: "1.0.0",
    sourceFingerprint: digest("1"),
    catalogSha256: digest("2"),
    packageSha256: artifactDigest,
    artifactPath: "/tmp/marketplace-artifact",
    action: "install",
    result: "ok",
  });
}

function marketplaceConfigPath(marketplaceId: string, pluginId: string) {
  return path.join(PLUGIN_DATA_DIRNAME, marketplaceId, pluginId, PLUGIN_CONFIG_FILENAME);
}

function marketplaceSecretsPath(marketplaceId: string, pluginId: string) {
  return path.join(PLUGIN_SECRETS_DIRNAME, marketplaceId, pluginId, PLUGIN_SECRETS_FILENAME);
}

afterEach(() => {
  vi.restoreAllMocks();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

describe.skipIf(!POSIX)("healCredentialFileModes", () => {
  it("tightens the data directory itself", () => {
    const root = makeHome();
    fs.chmodSync(root, 0o755);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(root)).toBe(0o700);
    expect(result.healed).toContain(".");
  });

  it("tightens every known credential file at the top level", () => {
    const root = makeHome();
    const targets = [
      "provider-catalog.json",
      "models.json",
      "added-models.yaml",
      "auth.json",
      "device-credentials.json",
      "devices.json",
      "pairing-sessions.json",
      "local-user-auth.json",
      "users.json",
      "web-sessions.json",
    ];
    for (const name of targets) writeOpen(name);

    const result = healCredentialFileModes({ hanakoHome: root });

    for (const name of targets) {
      expect(modeOf(path.join(root, name))).toBe(0o600);
      expect(result.healed).toContain(name);
    }
  });

  it("tightens per-agent configuration files", () => {
    const root = makeHome();
    writeOpen(path.join("agents", "hanako", "config.yaml"), "api:\n  api_key: value\n");
    writeOpen(path.join("agents", "second", "config.yaml"), "api:\n  api_key: value\n");

    healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, "agents", "hanako", "config.yaml"))).toBe(0o600);
    expect(modeOf(path.join(root, "agents", "second", "config.yaml"))).toBe(0o600);
  });

  // The scope migration writes this backup once and never rewrites it, so a
  // file left behind by an older version would otherwise keep its mode forever.
  it("tightens the scope-migration backups kept beside agent configuration files", () => {
    const root = makeHome();
    const live = path.join("agents", "hanako", "config.yaml.pre-scope-migration");
    const inCheckpoint = path.join(
      "checkpoints", "session-manifest", "cp-1", "agents", "hanako", "config.yaml.pre-scope-migration",
    );
    writeOpen(live, "api:\n  api_key: value\n");
    writeOpen(inCheckpoint, "api:\n  api_key: value\n");

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, live))).toBe(0o600);
    expect(modeOf(path.join(root, inCheckpoint))).toBe(0o600);
    expect(result.healed).toContain(live);
  });

  // Older versions rewrote agent configuration through a temporary copy written
  // with default permissions. A crash before the rename leaves that copy behind
  // with the full configuration in it, and nothing ever rewrites it, so the
  // credentials would stay readable forever.
  it("tightens a leftover temporary copy of an agent configuration", () => {
    const root = makeHome();
    const live = path.join("agents", "hanako", `config.yaml${SECRET_TMP_SUFFIX}`);
    const inCheckpoint = path.join(
      "checkpoints", "session-manifest", "cp-1", "agents", "hanako", `config.yaml${SECRET_TMP_SUFFIX}`,
    );
    writeOpen(live, "api:\n  api_key: value\n");
    writeOpen(inCheckpoint, "api:\n  api_key: value\n");

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, live))).toBe(0o600);
    expect(modeOf(path.join(root, inCheckpoint))).toBe(0o600);
    expect(result.healed).toContain(live);
    expect(result.healed).toContain(inCheckpoint);
  });

  it("tightens migration backup directories and everything inside them", () => {
    const root = makeHome();
    const backupDir = path.join(root, "migration-backups", "provider-catalog-v1-2026-01-01");
    writeOpen(path.join("migration-backups", "provider-catalog-v1-2026-01-01", "added-models.yaml"));
    writeOpen(path.join("migration-backups", "provider-catalog-v1-2026-01-01", "models.json"));
    fs.chmodSync(backupDir, 0o755);
    fs.chmodSync(path.join(root, "migration-backups"), 0o755);

    healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, "migration-backups"))).toBe(0o700);
    expect(modeOf(backupDir)).toBe(0o700);
    expect(modeOf(path.join(backupDir, "added-models.yaml"))).toBe(0o600);
    expect(modeOf(path.join(backupDir, "models.json"))).toBe(0o600);
  });

  // The tree is located through LOCAL_PROVIDER_PLUGINS_DIR rather than a
  // literal, because the healer reads a directory name that the store owns.
  // A guard that only asserts a string is in SECRET_TREES passes even when the
  // two names have drifted apart and the healer walks a path that never exists.
  it("tightens locally defined provider plugins, whose files carry that provider's key", () => {
    const root = makeHome();
    const pluginRoot = path.join(root, LOCAL_PROVIDER_PLUGINS_DIR);
    const providerDir = path.join(pluginRoot, "acme");
    const keyFile = path.join(LOCAL_PROVIDER_PLUGINS_DIR, "acme", "providers", "acme.json");
    writeOpen(keyFile, JSON.stringify({ api_key: "value" }));
    fs.chmodSync(providerDir, 0o755);
    fs.chmodSync(pluginRoot, 0o755);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(pluginRoot)).toBe(0o700);
    expect(modeOf(providerDir)).toBe(0o700);
    expect(modeOf(path.join(root, keyFile))).toBe(0o600);
    expect(result.healed).toContain(keyFile);
  });

  // The signing keys here are written owner-only, but a restored backup or a
  // copied data directory reintroduces the permissions the copy was made with,
  // and nothing rewrites a key file afterwards. Located through the constant the
  // services use, so a rename cannot leave this walking a path that never exists.
  it("tightens the security directory that holds signing keys and grant records", () => {
    const root = makeHome();
    const securityRoot = path.join(root, SECURITY_DIR);
    const keyFile = path.join(SECURITY_DIR, "resource-ticket-key");
    const grantsFile = path.join(SECURITY_DIR, "grants.json");
    writeOpen(keyFile, "key-material\n");
    writeOpen(grantsFile, "{}\n");
    fs.chmodSync(securityRoot, 0o755);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(securityRoot)).toBe(0o700);
    expect(modeOf(path.join(root, keyFile))).toBe(0o600);
    expect(modeOf(path.join(root, grantsFile))).toBe(0o600);
    expect(result.healed).toContain(keyFile);
    expect(result.healed).toContain(grantsFile);
  });

  // Only the configuration file is corrected. The rest of a plugin's data
  // directory belongs to other stores and may legitimately carry other modes,
  // so the negative assertion below is as much the contract as the positive
  // ones: this pass must not flatten a neighbour it does not own.
  it("tightens plugin configuration files without touching the rest of a plugin's data", () => {
    const root = makeHome();
    const mcpConfig = path.join(PLUGIN_DATA_DIRNAME, "mcp", PLUGIN_CONFIG_FILENAME);
    const imageConfig = path.join(PLUGIN_DATA_DIRNAME, "image-gen", PLUGIN_CONFIG_FILENAME);
    const neighbour = path.join(PLUGIN_DATA_DIRNAME, "image-gen", "helper.bin");
    writeOpen(mcpConfig);
    writeOpen(imageConfig);
    writeOpen(neighbour);
    fs.chmodSync(path.join(root, neighbour), 0o755);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, mcpConfig))).toBe(0o600);
    expect(modeOf(path.join(root, imageConfig))).toBe(0o600);
    expect(result.healed).toContain(mcpConfig);
    expect(modeOf(path.join(root, neighbour))).toBe(0o755);
  });

  it("tightens agent configuration captured inside migration checkpoints", () => {
    const root = makeHome();
    writeOpen(
      path.join("checkpoints", "session-manifest", "cp-1", "agents", "hanako", "config.yaml"),
      "api:\n  api_key: value\n",
    );

    healCredentialFileModes({ hanakoHome: root });

    expect(
      modeOf(path.join(root, "checkpoints", "session-manifest", "cp-1", "agents", "hanako", "config.yaml")),
    ).toBe(0o600);
  });

  it("reports each correction so the run leaves a trace", () => {
    const root = makeHome();
    writeOpen("provider-catalog.json");
    const lines: string[] = [];

    const result = healCredentialFileModes({ hanakoHome: root, log: (line: string) => lines.push(line) });

    expect(result.healed).toContain("provider-catalog.json");
    expect(lines.join("\n")).toContain("provider-catalog.json");
  });

  it("stays quiet when everything is already owner-only", () => {
    const root = makeHome();
    fs.chmodSync(root, 0o700);
    const target = path.join(root, "provider-catalog.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o600);
    const lines: string[] = [];

    const result = healCredentialFileModes({ hanakoHome: root, log: (line: string) => lines.push(line) });

    expect(result.healed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("refuses a missing data directory instead of reporting a clean run", () => {
    expect(() => healCredentialFileModes({ hanakoHome: "" })).toThrowError(/data directory/);
  });

  it("skips files that are absent instead of failing", () => {
    const root = makeHome();
    fs.chmodSync(root, 0o700);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(result.failed).toEqual([]);
  });

  it("reports a file it could not correct and still handles the rest", () => {
    const root = makeHome();
    fs.chmodSync(root, 0o700);
    writeOpen("provider-catalog.json");
    writeOpen("models.json");
    const realChmod = fs.chmodSync;
    vi.spyOn(fs, "chmodSync").mockImplementation((target: any, mode: any) => {
      if (String(target).endsWith("provider-catalog.json")) {
        const err: any = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return realChmod(target, mode);
    });
    const lines: string[] = [];

    const result = healCredentialFileModes({ hanakoHome: root, log: (line: string) => lines.push(line) });

    expect(result.failed).toContain("provider-catalog.json");
    expect(result.healed).toContain("models.json");
    expect(modeOf(path.join(root, "models.json"))).toBe(0o600);
    expect(lines.join("\n")).toContain("provider-catalog.json");
  });

  // --- Blocker B regression tests: source-qualified Marketplace credential healing ---

  it("heals exact active and retained Marketplace config/secrets identities", () => {
    const root = makeHome();
    const records = new PluginInstallRecords({ hanakoHome: root });
    // The second source becomes active; the first stays retained. Both remain
    // valid credential-storage identities, even though they share pluginId.
    registerMarketplaceInstall(records, "llm-wiki", "skillwiki", digest("a"));
    registerMarketplaceInstall(records, "team-plugins", "skillwiki", digest("b"));
    const identities = [
      { marketplaceId: "llm-wiki", pluginId: "skillwiki" },
      { marketplaceId: "team-plugins", pluginId: "skillwiki" },
    ];
    const configs = identities.map(({ marketplaceId, pluginId }) => marketplaceConfigPath(marketplaceId, pluginId));
    const secrets = identities.map(({ marketplaceId, pluginId }) => marketplaceSecretsPath(marketplaceId, pluginId));
    for (const target of [...configs, ...secrets]) writeOpen(target, '{"api_key":"value"}\n');
    for (const directory of [
      PLUGIN_SECRETS_DIRNAME,
      "llm-wiki",
      "team-plugins",
    ]) {
      const target = directory === PLUGIN_SECRETS_DIRNAME
        ? path.join(root, directory)
        : path.join(root, PLUGIN_SECRETS_DIRNAME, directory);
      fs.chmodSync(target, 0o755);
    }
    for (const { marketplaceId, pluginId } of identities) {
      fs.chmodSync(path.join(root, PLUGIN_SECRETS_DIRNAME, marketplaceId, pluginId), 0o755);
    }

    const result = healCredentialFileModes({ hanakoHome: root, marketplaceInstallRecords: records });

    for (const target of [...configs, ...secrets]) {
      expect(modeOf(path.join(root, target))).toBe(0o600);
      expect(result.healed).toContain(target);
    }
    // The dedicated root, each recognized source, and each recognized plugin
    // directory are private. Public plugin-data parents are intentionally not.
    expect(modeOf(path.join(root, PLUGIN_SECRETS_DIRNAME))).toBe(0o700);
    for (const { marketplaceId, pluginId } of identities) {
      expect(modeOf(path.join(root, PLUGIN_SECRETS_DIRNAME, marketplaceId))).toBe(0o700);
      expect(modeOf(path.join(root, PLUGIN_SECRETS_DIRNAME, marketplaceId, pluginId))).toBe(0o700);
    }
  });

  it("leaves unregistered and runtime paths untouched while retaining the bare MCP config pass", () => {
    const root = makeHome();
    const records = new PluginInstallRecords({ hanakoHome: root });
    registerMarketplaceInstall(records, "registered", "plugin", digest("c"));
    const registeredConfig = marketplaceConfigPath("registered", "plugin");
    const registeredSecrets = marketplaceSecretsPath("registered", "plugin");
    const unregisteredConfig = marketplaceConfigPath("unregistered", "plugin");
    const unregisteredSecrets = marketplaceSecretsPath("unregistered", "plugin");
    const officeJob = path.join(PLUGIN_DATA_DIRNAME, "office", "jobs", PLUGIN_CONFIG_FILENAME);
    const officeGenerated = path.join(PLUGIN_DATA_DIRNAME, "office", "generated", PLUGIN_CONFIG_FILENAME);
    const nestedMcp = path.join(PLUGIN_DATA_DIRNAME, "mcp", "runtime-child", PLUGIN_CONFIG_FILENAME);
    const mcpConfig = path.join(PLUGIN_DATA_DIRNAME, "mcp", PLUGIN_CONFIG_FILENAME);
    const neighbor = path.join(PLUGIN_DATA_DIRNAME, "registered", "plugin", "generated", "output.txt");
    for (const target of [registeredConfig, registeredSecrets, unregisteredConfig, unregisteredSecrets, officeJob, officeGenerated, nestedMcp, mcpConfig, neighbor]) {
      writeOpen(target);
    }
    for (const target of [unregisteredConfig, unregisteredSecrets, officeJob, officeGenerated, nestedMcp, neighbor]) {
      fs.chmodSync(path.join(root, target), 0o755);
    }
    const registeredDataSourceDir = path.join(root, PLUGIN_DATA_DIRNAME, "registered");
    const registeredDataPluginDir = path.join(registeredDataSourceDir, "plugin");
    fs.chmodSync(registeredDataSourceDir, 0o755);
    fs.chmodSync(registeredDataPluginDir, 0o755);

    const result = healCredentialFileModes({ hanakoHome: root, marketplaceInstallRecords: records });

    expect(modeOf(path.join(root, registeredConfig))).toBe(0o600);
    expect(modeOf(path.join(root, registeredSecrets))).toBe(0o600);
    for (const target of [unregisteredConfig, unregisteredSecrets, officeJob, officeGenerated, nestedMcp, neighbor]) {
      expect(modeOf(path.join(root, target))).toBe(0o755);
      expect(result.healed).not.toContain(target);
    }
    expect(modeOf(path.join(root, mcpConfig))).toBe(0o600);
    expect(modeOf(registeredDataSourceDir)).toBe(0o755);
    expect(modeOf(registeredDataPluginDir)).toBe(0o755);
  });

  it("skips source-qualified root symlinks without traversing their external targets", () => {
    const root = makeHome();
    const records = new PluginInstallRecords({ hanakoHome: root });
    registerMarketplaceInstall(records, "root-source", "root-plugin", digest("d"));
    const config = marketplaceConfigPath("root-source", "root-plugin");
    const secrets = marketplaceSecretsPath("root-source", "root-plugin");
    const externalDataRoot = path.join(root, "outside-plugin-data");
    const externalSecretsRoot = path.join(root, "outside-plugin-secrets");
    const externalConfig = writeOpenAt(path.join(externalDataRoot, "root-source", "root-plugin", PLUGIN_CONFIG_FILENAME));
    const externalSecrets = writeOpenAt(path.join(externalSecretsRoot, "root-source", "root-plugin", PLUGIN_SECRETS_FILENAME));
    fs.symlinkSync(externalDataRoot, path.join(root, PLUGIN_DATA_DIRNAME));
    fs.symlinkSync(externalSecretsRoot, path.join(root, PLUGIN_SECRETS_DIRNAME));

    const result = healCredentialFileModes({ hanakoHome: root, marketplaceInstallRecords: records });

    expect(modeOf(externalConfig)).toBe(0o644);
    expect(modeOf(externalSecrets)).toBe(0o644);
    expect(result.healed).not.toContain(config);
    expect(result.healed).not.toContain(secrets);
    expect(result.failed).toEqual([]);
  });

  it("skips Marketplace-parent, plugin-parent, and final-file symlinks for both storage trees", () => {
    const root = makeHome();
    const records = new PluginInstallRecords({ hanakoHome: root });
    const outsideTargets: string[] = [];
    const unsafePaths: string[] = [];
    const trees = [
      { rootName: PLUGIN_DATA_DIRNAME, filename: PLUGIN_CONFIG_FILENAME, pathFor: marketplaceConfigPath },
      { rootName: PLUGIN_SECRETS_DIRNAME, filename: PLUGIN_SECRETS_FILENAME, pathFor: marketplaceSecretsPath },
    ];
    const levels = ["marketplace", "plugin", "file"] as const;

    for (const [treeIndex, tree] of trees.entries()) {
      for (const [levelIndex, level] of levels.entries()) {
        const marketplaceId = `source${treeIndex}${levelIndex}`;
        const pluginId = `plugin${treeIndex}${levelIndex}`;
        registerMarketplaceInstall(records, marketplaceId, pluginId, digest(`${treeIndex + levelIndex + 3}`));
        const treeRoot = path.join(root, tree.rootName);
        const canonicalTarget = path.join(treeRoot, marketplaceId, pluginId, tree.filename);
        const externalTarget = path.join(root, "outside", tree.rootName, level, marketplaceId, pluginId, tree.filename);
        writeOpenAt(externalTarget);
        outsideTargets.push(externalTarget);
        unsafePaths.push(tree.pathFor(marketplaceId, pluginId));

        if (level === "marketplace") {
          fs.mkdirSync(treeRoot, { recursive: true });
          fs.symlinkSync(path.dirname(path.dirname(externalTarget)), path.join(treeRoot, marketplaceId));
        } else if (level === "plugin") {
          fs.mkdirSync(path.join(treeRoot, marketplaceId), { recursive: true });
          fs.symlinkSync(path.dirname(externalTarget), path.join(treeRoot, marketplaceId, pluginId));
        } else {
          fs.mkdirSync(path.dirname(canonicalTarget), { recursive: true });
          fs.symlinkSync(externalTarget, canonicalTarget);
        }
      }
    }

    const result = healCredentialFileModes({ hanakoHome: root, marketplaceInstallRecords: records });

    for (const target of outsideTargets) expect(modeOf(target)).toBe(0o644);
    for (const target of unsafePaths) expect(result.healed).not.toContain(target);
    expect(result.failed).toEqual([]);
  });

  it("skips directories named config.json or secrets.json", () => {
    const root = makeHome();
    const records = new PluginInstallRecords({ hanakoHome: root });
    registerMarketplaceInstall(records, "directory-target", "plugin", digest("e"));
    const config = path.join(root, marketplaceConfigPath("directory-target", "plugin"));
    const secrets = path.join(root, marketplaceSecretsPath("directory-target", "plugin"));
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(secrets, { recursive: true });
    fs.chmodSync(config, 0o755);
    fs.chmodSync(secrets, 0o755);

    const result = healCredentialFileModes({ hanakoHome: root, marketplaceInstallRecords: records });

    expect(modeOf(config)).toBe(0o755);
    expect(modeOf(secrets)).toBe(0o755);
    expect(result.healed).not.toContain(marketplaceConfigPath("directory-target", "plugin"));
    expect(result.healed).not.toContain(marketplaceSecretsPath("directory-target", "plugin"));
    expect(result.failed).toEqual([]);
  });

  it("does not infer Marketplace targets from missing, malformed, or legacy-unqualified records", () => {
    const root = makeHome();
    const malformedConfig = marketplaceConfigPath("malformed-source", "plugin");
    const legacyConfig = marketplaceConfigPath("legacy-unqualified", "legacy-plugin");
    const malformedSecrets = marketplaceSecretsPath("malformed-source", "plugin");
    const legacySecrets = marketplaceSecretsPath("legacy-unqualified", "legacy-plugin");
    for (const target of [malformedConfig, legacyConfig, malformedSecrets, legacySecrets]) writeOpen(target);
    const recordsPath = path.join(root, "plugin-installs.json");
    const recordDigest = digest("f");
    fs.writeFileSync(recordsPath, `${JSON.stringify({
      version: 2,
      plugins: {
        malformed: {
          schemaVersion: 2,
          pluginId: "plugin",
          activeMarketplaceId: "malformed-source",
          activeArtifactDigest: recordDigest,
          retained: {
            "malformed-source": {
              [recordDigest]: { marketplaceId: "different-source", artifactDigest: recordDigest },
            },
          },
          transaction: null,
          history: [],
        },
        legacy: {
          schemaVersion: 2,
          pluginId: "legacy-plugin",
          activeMarketplaceId: "legacy-unqualified",
          activeArtifactDigest: recordDigest,
          retained: {
            "legacy-unqualified": {
              [recordDigest]: { marketplaceId: "legacy-unqualified", artifactDigest: recordDigest },
            },
          },
          transaction: null,
          history: [],
        },
      },
    }, null, 2)}\n`);

    const result = healCredentialFileModes({ hanakoHome: root });

    for (const target of [malformedConfig, legacyConfig, malformedSecrets, legacySecrets]) {
      expect(modeOf(path.join(root, target))).toBe(0o644);
      expect(result.healed).not.toContain(target);
    }
    expect(result.failed).toEqual([]);
  });
});
