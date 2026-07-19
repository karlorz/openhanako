#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  LEGACY_RAW_PROFILE,
  inspectSigningKeyState,
  normalizeReleaseProfileRequest,
  resolveRequestedReleaseProfile,
} = require("../shared/release-profile.cjs");

function parseArgs(argv) {
  const args = { requested: "auto", githubOutput: null, json: false, profile: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--requested") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new TypeError("--requested requires a value");
      args.requested = value;
    } else if (arg === "--github-output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new TypeError("--github-output requires a path");
      args.githubOutput = value;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--profile") {
      args.profile = true;
    } else {
      throw new TypeError(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const requested = normalizeReleaseProfileRequest(args.requested);
  const keyState = requested === LEGACY_RAW_PROFILE
    ? "absent"
    : inspectSigningKeyState(process.env, fs);
  const result = resolveRequestedReleaseProfile({ requested, keyState });
  if (args.githubOutput) {
    fs.appendFileSync(
      args.githubOutput,
      `release_profile=${result.profile}\nrelease_profile_reason=${result.reason}\n`,
    );
  }
  if (args.profile) {
    process.stdout.write(`${result.profile}\n`);
  } else if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

main();
