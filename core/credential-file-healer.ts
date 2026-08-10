/**
 * Startup pass that brings existing credential files up to the owner-only
 * storage contract.
 *
 * Writing new files with the right permissions only covers files written after
 * an upgrade. Anything already on disk keeps whatever permissions it was
 * created with, and a file that is never rewritten would keep them forever.
 * This runs on every startup rather than once, because permissions can also
 * drift afterwards: restoring from a backup, copying a data directory between
 * machines, or syncing it all reintroduce the original permissions long after
 * a one-shot migration would have finished.
 *
 * Running every time is safe because the pass is idempotent and silent when
 * there is nothing to correct. Every correction is logged, so this is a stated
 * contract about how the data directory is kept rather than an invisible fixup.
 *
 * Deleting this module means dropping its single call in the engine startup
 * sequence; nothing else depends on it.
 */
import fs from "fs";
import path from "path";

import { PluginInstallRecords, type MarketplaceStorageIdentity } from "../lib/plugin-install-records.ts";
import { marketplacePluginDataDir, marketplacePluginSecretsDir } from "../lib/plugin-trust-store.ts";
import { AppError } from "../shared/errors.ts";
import { errorBus } from "../shared/error-bus.ts";
import { CONFIG_SCOPE_BACKUP_SUFFIX } from "../shared/migrate-config-scope.ts";
import {
  ensureSecretDirectoryModeNoFollowSync,
  ensureSecretDirModeSync,
  ensureSecretFileModeSync,
  ensureSecretRegularFileModeNoFollowSync,
  SECRET_TMP_SUFFIX,
} from "../shared/secret-fs.ts";
import { LOCAL_PROVIDER_PLUGINS_DIR } from "./local-provider-plugin-store.ts";
import { MIGRATION_BACKUPS_DIR } from "./migration-backups.ts";
import {
  PLUGIN_CONFIG_FILENAME,
  PLUGIN_DATA_DIRNAME,
  PLUGIN_SECRETS_DIRNAME,
  PLUGIN_SECRETS_FILENAME,
} from "./plugin-config.ts";
import { SECURITY_DIR } from "./security-dir.ts";

/** Files directly under the data directory that hold credentials. */
export const TOP_LEVEL_SECRET_FILES = [
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

/**
 * Directory trees whose contents are credential material throughout.
 * The local provider plugin tree holds each locally defined provider, whose
 * definition carries that provider's key. The security tree holds the signing
 * keys behind resource tickets and plugin sessions, plus the grant and lease
 * records those keys authorise; they are written owner-only, but nothing else
 * ever rewrites a key file, so permissions a backup restore or a copied data
 * directory reintroduces would stay loose for good.
 *
 * Every directory name is taken from the module that owns it rather than
 * repeated here. Spelling one out once cost real coverage: this list said
 * "providers" while the store wrote to "provider-plugins", so the healer walked
 * a path that never existed and silently corrected nothing.
 */
export const SECRET_TREES = [MIGRATION_BACKUPS_DIR, LOCAL_PROVIDER_PLUGINS_DIR, SECURITY_DIR];

const AGENT_CONFIG_FILE = "config.yaml";
/**
 * The scope migration keeps a one-time copy of each agent configuration, taken
 * before it strips the global fields out. That copy holds the same credentials
 * as the original and is written once and never rewritten, so nothing else
 * would ever bring an older one up to the current contract.
 */
const AGENT_CONFIG_BACKUP_FILE = `${AGENT_CONFIG_FILE}${CONFIG_SCOPE_BACKUP_SUFFIX}`;
/**
 * Older versions rewrote agent configuration by writing a temporary copy with
 * whatever permissions the system hands out by default and then renaming it
 * over the original. A crash in between leaves that copy sitting there with the
 * whole configuration in it, and nothing ever rewrites it, so it would keep
 * those permissions for as long as the data directory exists.
 */
const AGENT_CONFIG_TMP_FILE = `${AGENT_CONFIG_FILE}${SECRET_TMP_SUFFIX}`;
const MAX_TREE_DEPTH = 6;

interface HealOptions {
  hanakoHome: string;
  /**
   * The install-record owner is the sole source of Marketplace storage
   * identities. Passing Engine's existing instance avoids a second reader at
   * startup; the standalone healer falls back to a local reader for tests and
   * direct maintenance calls.
   */
  marketplaceInstallRecords?: Pick<PluginInstallRecords, "listMarketplaceStorageIdentities">;
  log?: (line: string) => void;
}

export interface CredentialHealResult {
  /** Paths relative to the data directory that were tightened this run. */
  healed: string[];
  /** Paths that could not be tightened; each one was reported. */
  failed: string[];
}

export function healCredentialFileModes({
  hanakoHome,
  marketplaceInstallRecords,
  log = () => {},
}: HealOptions): CredentialHealResult {
  const result: CredentialHealResult = { healed: [], failed: [] };
  // Refuse rather than quietly do nothing: without a data directory there is
  // no work to skip, only a caller passing the wrong thing, and silently
  // succeeding would hide that the files were never protected at all.
  if (!hanakoHome) throw new Error("credential file healer requires a data directory");

  const relative = (target: string) => path.relative(hanakoHome, target) || ".";

  const apply = (target: string, tighten: (p: string) => boolean) => {
    try {
      if (tighten(target)) {
        const rel = relative(target);
        result.healed.push(rel);
        log(`[credential-custody] tightened ${rel}`);
      }
    } catch (err: any) {
      const rel = relative(target);
      result.failed.push(rel);
      log(`[credential-custody] could not tighten ${rel}: ${err?.code || err?.message || "unknown error"}`);
      // Logged, never surfaced: a file whose mode could not be tightened is
      // worth a record, but the application still works and interrupting the
      // user over it would be out of proportion. Some filesystems (removable
      // media, network mounts) reject the change outright and would otherwise
      // complain on every single launch.
      errorBus.report(
        new AppError("FS_PERMISSION", { cause: err, context: { relativePath: rel } }),
        { route: "silent", dedupeKey: `credential-custody:${rel}` },
      );
    }
  };

  const healFile = (target: string) => apply(target, ensureSecretFileModeSync);
  const healDir = (target: string) => apply(target, ensureSecretDirModeSync);
  // Source-qualified Marketplace paths have stricter ownership and symlink
  // requirements than the established generic healer paths. Their final
  // component is tightened through an O_NOFOLLOW descriptor after the exact
  // root/intermediate lstat guards below have passed.
  const healManagedCredentialFile = (target: string) => apply(target, ensureSecretRegularFileModeNoFollowSync);
  const healManagedCredentialDir = (target: string) => apply(target, ensureSecretDirectoryModeNoFollowSync);

  healDir(hanakoHome);

  for (const name of TOP_LEVEL_SECRET_FILES) {
    healFile(path.join(hanakoHome, name));
  }

  for (const agentDir of subdirectories(path.join(hanakoHome, "agents"))) {
    healFile(path.join(agentDir, AGENT_CONFIG_FILE));
    healFile(path.join(agentDir, AGENT_CONFIG_BACKUP_FILE));
    healFile(path.join(agentDir, AGENT_CONFIG_TMP_FILE));
  }

  for (const tree of SECRET_TREES) {
    healTree(path.join(hanakoHome, tree), 0, healDir, healFile);
  }

  // Plugin configuration can hold connector and service credentials. The
  // direct bare-plugin pass remains for legacy/unqualified directories such
  // as plugin-data/mcp/config.json, but now gives its root, plugin directory,
  // and final file the same no-follow/type safeguards as Marketplace paths.
  const pluginDataRoot = path.join(hanakoHome, PLUGIN_DATA_DIRNAME);
  const pluginSecretsRoot = path.join(hanakoHome, PLUGIN_SECRETS_DIRNAME);
  healBarePluginConfigs(pluginDataRoot, healManagedCredentialFile);

  // Marketplace storage ownership comes exclusively from validated install
  // records. There is intentionally no directory-depth fallback: runtime data
  // under office, mcp, generated output, or an unregistered source must stay
  // outside this custody pass.
  const installRecords = marketplaceInstallRecords || new PluginInstallRecords({ hanakoHome });
  const listedMarketplaceIdentities = installRecords.listMarketplaceStorageIdentities();
  const marketplaceIdentities = Array.isArray(listedMarketplaceIdentities)
    ? listedMarketplaceIdentities
    : [];
  healMarketplacePluginConfigs(pluginDataRoot, marketplaceIdentities, healManagedCredentialFile);
  healMarketplacePluginSecrets(
    pluginSecretsRoot,
    marketplaceIdentities,
    healManagedCredentialFile,
    healManagedCredentialDir,
  );

  // Migration checkpoints copy the agents directory wholesale, so the same
  // configuration files exist a second time inside each checkpoint.
  const checkpointRoot = path.join(hanakoHome, "checkpoints", "session-manifest");
  for (const checkpoint of subdirectories(checkpointRoot)) {
    for (const agentDir of subdirectories(path.join(checkpoint, "agents"))) {
      healFile(path.join(agentDir, AGENT_CONFIG_FILE));
      healFile(path.join(agentDir, AGENT_CONFIG_BACKUP_FILE));
      healFile(path.join(agentDir, AGENT_CONFIG_TMP_FILE));
    }
  }

  return result;
}

function healTree(
  root: string,
  depth: number,
  healDir: (target: string) => void,
  healFile: (target: string) => void,
): void {
  if (depth > MAX_TREE_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // absent or unreadable: nothing to correct here
  }
  healDir(root);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) healTree(target, depth + 1, healDir, healFile);
    else if (entry.isFile()) healFile(target);
  }
}

function subdirectories(root: string): string[] {
  if (!isRealDirectory(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/**
 * `lstat` guards for paths the credential healer owns directly. `isFile()`
 * and `isDirectory()` are false for symlinks when the metadata came from
 * lstat, so links and wrong types are both skipped before a mode operation.
 */
function isRealDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The same lstat behavior gives a no-follow regular-file check for the final
 * credential target before its descriptor-based chmod is attempted.
 */
function isRealRegularFile(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile();
  } catch {
    return false;
  }
}

function healBarePluginConfigs(
  pluginDataRoot: string,
  healFile: (target: string) => void,
): void {
  for (const pluginDir of subdirectories(pluginDataRoot)) {
    if (!isRealDirectory(pluginDir)) continue;
    const target = path.join(pluginDir, PLUGIN_CONFIG_FILENAME);
    if (!isRealRegularFile(target)) continue;
    healFile(target);
  }
}

interface MarketplaceStorageDirectories {
  marketplaceDir: string;
  pluginDir: string;
}

function marketplaceStorageDirectories(
  root: string,
  identity: MarketplaceStorageIdentity,
  buildPluginDir: (rootDir: string, marketplaceId: string, pluginId: string) => string,
): MarketplaceStorageDirectories | null {
  try {
    const pluginDir = buildPluginDir(root, identity.marketplaceId, identity.pluginId);
    const marketplaceDir = path.dirname(pluginDir);
    // Validate every component immediately before any descriptor is opened or
    // directory mode is changed. The canonical builder rejects dangerous path
    // segments; lstat rejects a root, Marketplace parent, or plugin directory
    // that has been replaced by a link or another file type.
    if (!isRealDirectory(root) || !isRealDirectory(marketplaceDir) || !isRealDirectory(pluginDir)) {
      return null;
    }
    return { marketplaceDir, pluginDir };
  } catch {
    // Install-record enumeration already validates identities, but refusing an
    // unexpected value here keeps this safety boundary fail-closed when the
    // healer is called with another implementation of the narrow interface.
    return null;
  }
}

/**
 * Heal the exact `config.json` files for validated Marketplace install
 * identities. This deliberately iterates records, never directory entries.
 */
function healMarketplacePluginConfigs(
  pluginDataRoot: string,
  identities: readonly MarketplaceStorageIdentity[],
  healFile: (target: string) => void,
): void {
  for (const identity of identities) {
    const directories = marketplaceStorageDirectories(pluginDataRoot, identity, marketplacePluginDataDir);
    if (!directories) continue;
    const target = path.join(directories.pluginDir, PLUGIN_CONFIG_FILENAME);
    if (!isRealRegularFile(target)) continue;
    healFile(target);
  }
}

/**
 * Heal the exact `secrets.json` files for validated Marketplace install
 * identities. The dedicated secrets root and the two recognized parents are
 * owner-only directories; public plugin-data parents are deliberately not.
 */
function healMarketplacePluginSecrets(
  pluginSecretsRoot: string,
  identities: readonly MarketplaceStorageIdentity[],
  healFile: (target: string) => void,
  healDir: (target: string) => void,
): void {
  for (const identity of identities) {
    const directories = marketplaceStorageDirectories(pluginSecretsRoot, identity, marketplacePluginSecretsDir);
    if (!directories) continue;
    const target = path.join(directories.pluginDir, PLUGIN_SECRETS_FILENAME);
    if (!isRealRegularFile(target)) continue;

    // All roots/intermediates and the final target above have been lstat'd
    // before any change. These helpers additionally use O_NOFOLLOW for their
    // final component; Node cannot make parent traversal atomic without an
    // openat-style API, so a concurrent parent swap remains outside this
    // best-effort startup healer's platform contract.
    healDir(pluginSecretsRoot);
    healDir(directories.marketplaceDir);
    healDir(directories.pluginDir);
    healFile(target);
  }
}
