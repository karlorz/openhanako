#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import featureContractsModule from "../shared/remote-feature-contracts.cjs";
import releaseCatalogModule from "../shared/remote-server-release-catalog.cjs";

const { SERVER_FEATURE_CONTRACTS, normalizeFeatureContracts } = featureContractsModule;
const { parseForkReleaseTag, parseServerAssetName } = releaseCatalogModule;
const __filename = fileURLToPath(import.meta.url);
const GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function fail(message) {
  throw new TypeError(`Server compatibility manifest: ${message}`);
}

function collectServerAssetFiles(rootDir) {
  if (typeof rootDir !== "string" || !fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    fail("artifacts directory is missing");
  }
  const files = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const filePath = path.join(directory, name);
      const stat = fs.lstatSync(filePath);
      const bundleName = name.endsWith(".sha256") ? name.slice(0, -7) : name;
      const looksLikeServerAsset = Boolean(parseServerAssetName(bundleName));
      if (stat.isSymbolicLink()) {
        if (looksLikeServerAsset) fail(`matching asset must not be a symlink: ${name}`);
        continue;
      }
      if (stat.isDirectory()) {
        if (looksLikeServerAsset) fail(`matching asset must be a regular file: ${name}`);
        visit(filePath);
        continue;
      }
      if (!stat.isFile()) {
        if (looksLikeServerAsset) fail(`matching asset must be a regular file: ${name}`);
        continue;
      }
      if (looksLikeServerAsset) files.push({ name, path: filePath });
    }
  };
  visit(rootDir);
  return files;
}

export function buildServerCompatibilityManifest({
  artifactsDir,
  tag,
  gitSha,
  sourceRepository,
  featureContracts = SERVER_FEATURE_CONTRACTS,
} = {}) {
  const parsedTag = parseForkReleaseTag(tag);
  if (!parsedTag) fail(`invalid fork release tag: ${tag}`);
  if (typeof gitSha !== "string" || !GIT_SHA_RE.test(gitSha)) fail("invalid full Git SHA");
  if (typeof sourceRepository !== "string" || !REPOSITORY_RE.test(sourceRepository)) fail("invalid source repository");
  const normalizedContracts = normalizeFeatureContracts(featureContracts);
  if (!normalizedContracts) fail("invalid feature contracts");

  const files = collectServerAssetFiles(artifactsDir);
  const fileNames = new Set(files.map((item) => item.name));
  const assets = new Map();
  let matchingBundles = 0;

  for (const file of files) {
    if (file.name.endsWith(".sha256")) continue;
    const parsedAsset = parseServerAssetName(file.name);
    if (!parsedAsset) continue;
    if (parsedAsset.tag !== tag) fail(`asset tag ${parsedAsset.tag} does not match ${tag}`);
    matchingBundles += 1;
    const checksum = `${file.name}.sha256`;
    if (!fileNames.has(checksum)) fail(`asset is not checksum-paired: ${file.name}`);
    const key = `${parsedAsset.platform}-${parsedAsset.arch}`;
    if (assets.has(key)) fail(`duplicate platform architecture pair: ${key}`);
    assets.set(key, { bundle: file.name, checksum });
  }

  for (const file of files) {
    if (!file.name.endsWith(".sha256")) continue;
    const bundleName = file.name.slice(0, -7);
    const parsedAsset = parseServerAssetName(bundleName);
    if (parsedAsset && parsedAsset.tag !== tag) fail(`asset tag ${parsedAsset.tag} does not match ${tag}`);
    if (parsedAsset?.tag === tag && !fileNames.has(bundleName)) {
      fail(`checksum is not checksum-paired: ${file.name}`);
    }
  }
  if (matchingBundles === 0 || assets.size === 0) fail("no checksum-paired server assets found");

  return {
    schemaVersion: 1,
    tag,
    runtimeVersion: parsedTag.runtimeVersion,
    sourceRepository,
    gitSha: gitSha.toLowerCase(),
    featureContracts: JSON.parse(JSON.stringify(normalizedContracts)),
    assets: Object.fromEntries([...assets.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function writeServerCompatibilityManifest({ outputPath, ...options } = {}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) fail("output path is required");
  const manifest = buildServerCompatibilityManifest(options);
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputPath, manifest };
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`invalid CLI argument: ${flag || "(missing)"}`);
    values[flag.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] === __filename) {
  const values = parseCli(process.argv.slice(2));
  const result = writeServerCompatibilityManifest({
    artifactsDir: values.artifacts,
    outputPath: values.output,
    tag: values.tag,
    gitSha: values["git-sha"],
    sourceRepository: values["source-repository"],
  });
  console.log(JSON.stringify(result, null, 2));
}
