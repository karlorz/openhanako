const defaultPolicy = require("./remote-server-policy.json");

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid remote server release policy field: ${name}`);
  }
}

function compilePolicy(policy) {
  if (!isRecord(policy) || policy.schemaVersion !== 1) {
    throw new TypeError("Invalid remote server release policy schema");
  }
  if (policy.repository !== "karlorz/openhanako") {
    throw new TypeError("Invalid remote server release policy repository");
  }
  if (policy.releaseEligibility !== "stable-and-prerelease") {
    throw new TypeError("Invalid remote server release eligibility");
  }
  if (typeof policy.expectedPublicationPrerelease !== "boolean") {
    throw new TypeError("Invalid expected publication policy");
  }
  if (!isRecord(policy.github)) {
    throw new TypeError("Invalid remote server GitHub policy");
  }
  requirePositiveInteger(policy.github.perPage, "github.perPage");
  requirePositiveInteger(policy.github.maxPages, "github.maxPages");
  requirePositiveInteger(policy.github.requestTimeoutMs, "github.requestTimeoutMs");
  requirePositiveInteger(policy.github.maxReleasesBodyBytes, "github.maxReleasesBodyBytes");
  requirePositiveInteger(policy.github.maxManifestBodyBytes, "github.maxManifestBodyBytes");
  requirePositiveInteger(policy.github.cacheTtlMs, "github.cacheTtlMs");
  requirePositiveInteger(policy.github.forceRefreshMinIntervalMs, "github.forceRefreshMinIntervalMs");

  const patterns = {};
  for (const key of ["forkTagPattern", "serverAssetPattern", "compatibilityManifestPattern"]) {
    if (typeof policy[key] !== "string" || policy[key].length === 0) {
      throw new TypeError(`Invalid remote server release policy pattern: ${key}`);
    }
    try {
      patterns[key] = new RegExp(policy[key]);
    } catch (error) {
      throw new TypeError(`Invalid remote server release policy regex: ${key}`, { cause: error });
    }
  }
  return { policy, ...patterns };
}

const defaultCompiledPolicy = compilePolicy(defaultPolicy);

function dedupe(values) {
  return [...new Set(values)];
}

function parseForkReleaseTagWith(value, compiled) {
  if (typeof value !== "string") return null;
  const match = compiled.forkTagPattern.exec(value);
  if (!match) return null;
  const version = match.slice(1, 4).map(Number);
  const forkRevision = Number(match[4]);
  if (!version.every(Number.isSafeInteger) || !Number.isSafeInteger(forkRevision)) return null;
  return {
    tag: value,
    runtimeVersion: version.join("."),
    version,
    forkRevision,
  };
}

function parseForkReleaseTag(value) {
  return parseForkReleaseTagWith(value, defaultCompiledPolicy);
}

function compareForkReleaseTags(left, right) {
  const leftTag = parseForkReleaseTag(left);
  const rightTag = parseForkReleaseTag(right);
  if (!leftTag || !rightTag) return null;
  const leftParts = [...leftTag.version, leftTag.forkRevision];
  const rightParts = [...rightTag.version, rightTag.forkRevision];
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function parseServerAssetNameWith(name, compiled) {
  if (typeof name !== "string") return null;
  const match = compiled.serverAssetPattern.exec(name);
  if (!match || !parseForkReleaseTagWith(match[1], compiled)) return null;
  return {
    tag: match[1],
    platform: match[2],
    arch: match[3],
  };
}

function parseServerAssetName(name) {
  return parseServerAssetNameWith(name, defaultCompiledPolicy);
}

function normalizeServerPlatformArch(platform, arch) {
  if (typeof platform !== "string" || typeof arch !== "string") return null;
  const normalizedPlatform = {
    darwin: "mac",
    linux: "linux",
    mac: "mac",
    win: "win",
    win32: "win",
  }[platform.trim().toLowerCase()];
  const normalizedArch = {
    aarch64: "arm64",
    amd64: "x64",
    arm64: "arm64",
    x64: "x64",
  }[arch.trim().toLowerCase()];
  if (!normalizedPlatform || !normalizedArch) return null;
  return { platform: normalizedPlatform, arch: normalizedArch };
}

function normalizeGithubServerRelease(value, policy = defaultPolicy) {
  const compiled = policy === defaultPolicy ? defaultCompiledPolicy : compilePolicy(policy);
  if (!isRecord(value) || value.draft === true) return null;
  const parsedTag = parseForkReleaseTagWith(value.tag_name, compiled);
  if (!parsedTag || !Array.isArray(value.assets)) return null;

  const assetsByName = new Map();
  for (const asset of value.assets) {
    if (!isRecord(asset) || typeof asset.name !== "string") continue;
    if (typeof asset.browser_download_url !== "string" || asset.browser_download_url.length === 0) continue;
    assetsByName.set(asset.name, asset);
  }

  const normalizedAssets = [];
  for (const asset of assetsByName.values()) {
    const parsedAsset = parseServerAssetNameWith(asset.name, compiled);
    if (!parsedAsset || parsedAsset.tag !== parsedTag.tag) continue;
    const checksumName = asset.name + ".sha256";
    const checksum = assetsByName.get(checksumName);
    if (!checksum) continue;
    normalizedAssets.push({
      platform: parsedAsset.platform,
      arch: parsedAsset.arch,
      name: asset.name,
      url: asset.browser_download_url,
      checksumName,
      checksumUrl: checksum.browser_download_url,
    });
  }
  if (normalizedAssets.length === 0) return null;
  normalizedAssets.sort((left, right) =>
    left.platform.localeCompare(right.platform) ||
    left.arch.localeCompare(right.arch) ||
    left.name.localeCompare(right.name));

  let compatibilityManifestName = null;
  for (const asset of assetsByName.values()) {
    const match = compiled.compatibilityManifestPattern.exec(asset.name);
    if (match && match[1] === parsedTag.tag) {
      compatibilityManifestName = asset.name;
      break;
    }
  }

  const prerelease = value.prerelease === true;
  const reasonCodes = [];
  if (prerelease !== compiled.policy.expectedPublicationPrerelease) {
    reasonCodes.push("release_publication_policy_drift");
  }

  return {
    tag: parsedTag.tag,
    runtimeVersion: parsedTag.runtimeVersion,
    forkRevision: parsedTag.forkRevision,
    prerelease,
    publishedAt: typeof value.published_at === "string" ? value.published_at : null,
    releaseUrl: typeof value.html_url === "string" ? value.html_url : null,
    assets: normalizedAssets,
    compatibilityManifestName,
    featureContracts: null,
    manifestGitSha: null,
    reasonCodes: dedupe(reasonCodes),
  };
}

function selectRecommendedServerRelease(values, policy = defaultPolicy) {
  if (!Array.isArray(values)) return null;
  const releases = values
    .map((value) => normalizeGithubServerRelease(value, policy))
    .filter(Boolean);
  releases.sort((left, right) => compareForkReleaseTags(right.tag, left.tag) ?? 0);
  return releases[0] ?? null;
}

module.exports = {
  compareForkReleaseTags,
  normalizeGithubServerRelease,
  normalizeServerPlatformArch,
  parseForkReleaseTag,
  parseServerAssetName,
  selectRecommendedServerRelease,
};
