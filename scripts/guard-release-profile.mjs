#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { normalizeReleaseProfile } = require("../shared/release-profile.cjs");

const MARKER_PREFIX = ".hana-release-profile-";

export function releaseProfileMarkerName(profile) {
  return `${MARKER_PREFIX}${normalizeReleaseProfile(profile)}`;
}

export function assertReleaseProfileCompatibility({ requested, assetNames = [] }) {
  const profile = normalizeReleaseProfile(requested);
  if (!Array.isArray(assetNames) || assetNames.some((name) => typeof name !== "string")) {
    throw new TypeError("Release asset names must be an array of strings.");
  }
  if (assetNames.length === 0) return { profile, marker: releaseProfileMarkerName(profile) };

  const markers = assetNames.filter((name) => name.startsWith(MARKER_PREFIX));
  const expected = releaseProfileMarkerName(profile);
  if (markers.length === 1 && markers[0] === expected) {
    const desktopInstallers = assetNames.filter((name) => /^HanaAgent-.*\.(dmg|zip|exe|AppImage|deb)$/.test(name));
    const oppositeInstallers = profile === "legacy-raw"
      ? desktopInstallers.filter((name) => !name.includes("-legacy-raw."))
      : desktopInstallers.filter((name) => name.includes("-legacy-raw."));
    if (oppositeInstallers.length > 0) {
      throw new Error(`Existing release assets contain opposite-profile installers (${oppositeInstallers.join(", ")}); refusing mixed assets.`);
    }
    if (profile === "legacy-raw") {
      const forbiddenAssets = assetNames.filter((name) => (
        /^latest.*\.yml$/.test(name)
        || /^server-.*\.tar\.gz$/.test(name)
        || /^renderer-.*\.tar\.gz$/.test(name)
        || /seed-train/.test(name)
        || /\.blockmap$/.test(name)
      ));
      if (forbiddenAssets.length > 0) {
        throw new Error(`Existing legacy-raw release contains forbidden updater/train assets (${forbiddenAssets.join(", ")}); refusing mixed assets.`);
      }
    }
    return { profile, marker: expected };
  }

  if (markers.length === 0) {
    throw new Error(`Existing release assets have no profile marker; refusing a non-clean ${profile} upload.`);
  }
  throw new Error(`Existing release profile (${markers.join(", ")}) does not match requested ${profile}; refusing mixed assets.`);
}

function parseArgs(argv) {
  const args = { profile: null, assetNames: null };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--profile" && option !== "--assets-json") throw new TypeError(`Unknown argument: ${option}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
    if (option === "--profile") args.profile = value;
    else args.assetNames = JSON.parse(value);
  }
  if (!args.profile) throw new TypeError("--profile requires a value");
  if (!args.assetNames) throw new TypeError("--assets-json requires a value");
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = assertReleaseProfileCompatibility({ requested: args.profile, assetNames: args.assetNames });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[release-profile-guard] ${error?.message || error}`);
    process.exitCode = 1;
  }
}
