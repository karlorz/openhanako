#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const VALID_OS = new Set(["linux", "mac", "win"]);
const VALID_ARCH = new Set(["arm64", "x64"]);
const TAG_RE = /^[A-Za-z0-9._-]+$/;

const __filename = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error(message);
}

// Stream-style sha256 via `sha256sum` so large tarballs (server bundles
// include the Node runtime + node_modules, routinely 80-150MB) are not
// read fully into memory. Matches how install-server.mjs verifies on the
// consume side — producer and consumer share the same algorithm.
function sha256OfFile(filePath) {
  const result = spawnSync("sha256sum", [filePath], { stdio: "pipe" });
  if (result.status !== 0) {
    fail(`packServerBundle: sha256sum failed: ${result.stderr?.toString() || `exit ${result.status}`}`);
  }
  return result.stdout.toString().trim().split(/\s+/)[0];
}

export function packServerBundle(distServerDir, { tag, os, arch } = {}) {
  if (!distServerDir || !fs.existsSync(distServerDir) || !fs.statSync(distServerDir).isDirectory()) {
    fail(`packServerBundle: dist-server dir not found: ${distServerDir}`);
  }
  if (!tag) fail("packServerBundle: tag is required");
  if (!TAG_RE.test(tag)) fail(`packServerBundle: tag has unsupported characters: ${tag}`);
  if (!VALID_OS.has(os)) fail(`packServerBundle: invalid os "${os}" (expected linux|mac|win)`);
  if (!VALID_ARCH.has(arch)) fail(`packServerBundle: invalid arch "${arch}" (expected arm64|x64)`);

  const name = `hanaagent-server-${tag}-${os}-${arch}.tar.gz`;
  const parent = path.dirname(distServerDir);
  const basename = path.basename(distServerDir);
  const assetPath = path.join(parent, name);

  // tar from the parent so the archive root is the dist-server basename dir
  const result = spawnSync("tar", ["-czpf", assetPath, "-C", parent, basename], { stdio: "pipe" });
  if (result.status !== 0) {
    fail(`packServerBundle: tar failed: ${result.stderr?.toString() || `exit ${result.status}`}`);
  }
  const sha256 = sha256OfFile(assetPath);
  // Write a <asset>.sha256 sidecar so install-server upgrade can verify the
  // download without an inline sha256 (GitHub Releases exposes none). Format
  // matches `sha256sum` output so the consume side parses the first token.
  const sidecarPath = `${assetPath}.sha256`;
  fs.writeFileSync(sidecarPath, `${sha256}  ${name}\n`);
  return { assetPath, sidecarPath, name, sha256 };
}

if (process.argv[1] === __filename) {
  const [, , distDir, tag, os, arch] = process.argv;
  if (!distDir || !tag || !os || !arch) {
    console.error("usage: pack-server-bundle.mjs <dist-server-dir> <tag> <os> <arch>");
    process.exit(2);
  }
  console.log(JSON.stringify(packServerBundle(distDir, { tag, os, arch }), null, 2));
}
