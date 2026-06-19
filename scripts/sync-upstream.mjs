#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_RULES_PATH = path.join(ROOT, "docs", "fork-sync", "rules.yml");

export const ISSUE_COMMANDS = ["status", "search", "draft"];

const color = (code, message) => `\u001b[${code}m${message}\u001b[0m`;
const red = (message) => color(31, message);
const green = (message) => color(32, message);
const yellow = (message) => color(33, message);
const blue = (message) => color(34, message);
const bold = (message) => color(1, message);

function print(message = "") {
  process.stdout.write(`${message}\n`);
}

function die(message) {
  print(red(`x ${message}`));
  process.exit(1);
}

function ok(message) {
  print(green(`ok ${message}`));
}

function info(message) {
  print(blue(`-> ${message}`));
}

function warn(message) {
  print(yellow(`! ${message}`));
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.error) {
    return { status: 1, stdout: "", stderr: result.error.message };
  }
  return result;
}

function runShell(command, options = {}) {
  const result = spawnSync("sh", ["-c", command], {
    cwd: ROOT,
    encoding: "utf8",
    input: options.input,
    stdio: options.capture || options.input ? "pipe" : "inherit",
  });
  if (result.error) {
    return { status: 1, stdout: "", stderr: result.error.message };
  }
  return result;
}

export function loadRules(rulesPath = DEFAULT_RULES_PATH) {
  return yaml.load(fs.readFileSync(rulesPath, "utf8"));
}

export function releaseChannelLabel(includePrerelease = false) {
  return includePrerelease ? "stable + prerelease" : "stable only";
}

function releaseTagName(release) {
  return release.tagName ?? release.tag_name ?? release.name ?? release.tag ?? "";
}

export function selectLatestReleaseTag(releases, options = {}) {
  const includePrerelease = Boolean(options.includePrerelease);
  const match = releases.find((release) => {
    if (release.isDraft || release.draft) {
      return false;
    }
    if (!includePrerelease && (release.isPrerelease || release.prerelease)) {
      return false;
    }
    return Boolean(releaseTagName(release));
  });
  return match ? releaseTagName(match) : "";
}

export function changedDivergingFiles(upstreamChangedFiles, rules = loadRules()) {
  const diverging = new Set(rules.conflictRules?.divergingFiles ?? []);
  return upstreamChangedFiles.filter((file) => diverging.has(file));
}

export function verificationCommands(rules = loadRules()) {
  const tests = rules.verification?.tier1Tests?.map((testPath) => `npx vitest run ${testPath}`) ?? [];
  return [...tests, ...(rules.verification?.commands ?? [])];
}

export function conflictPolicyForFile(file, rules = loadRules()) {
  const conflictRules = rules.conflictRules ?? {};
  const policy = conflictRules.policies?.[file];
  const defaultResolution = conflictRules.defaultResolution ?? "main";
  if (policy?.strategy) {
    return {
      file,
      strategy: policy.strategy,
      source: "policy",
      class: policy.class ?? null,
      risk: policy.risk ?? null,
      resolution: policy.resolution ?? "",
      plannedAction: policy.plannedAction ?? policy.resolution ?? "",
    };
  }
  if (policy) {
    return {
      file,
      strategy: "human-review",
      source: "policy",
      class: policy.class ?? null,
      risk: policy.risk ?? null,
      resolution: policy.resolution ?? "",
      plannedAction: policy.plannedAction ?? "Would require human review before any future resolver acts.",
    };
  }
  if ((conflictRules.divergingFiles ?? []).includes(file)) {
    return {
      file,
      strategy: "human-review",
      source: "diverging-file",
      class: null,
      risk: "high",
      resolution: "Diverging fork file without an explicit strategy; inspect both sides before resolving.",
      plannedAction: "Would stop for human review because this is a known diverging fork file.",
    };
  }
  return {
    file,
    strategy: defaultResolution === "main" ? "take-main" : `take-${defaultResolution}`,
    source: "default",
    class: null,
    risk: "low",
    resolution: `Default dry-run policy: resolve to ${defaultResolution}.`,
    plannedAction: `Would accept the origin/${defaultResolution} version if a future resolver executes this plan.`,
  };
}

export function buildConflictPlan(conflictingFiles, rules = loadRules(), options = {}) {
  const files = [...new Set(conflictingFiles)].filter(Boolean).sort();
  return {
    kind: "openhanako-fork-conflict-plan",
    dryRun: options.dryRun ?? rules.conflictRules?.dryRunDefault ?? true,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    defaultResolution: rules.conflictRules?.defaultResolution ?? "main",
    conflicts: files.map((file) => conflictPolicyForFile(file, rules)),
  };
}

export function parseMergeTreeConflictingFiles(output) {
  const files = new Set();
  for (const line of output.split("\n")) {
    const stageMatch = line.match(/^\d{6} [0-9a-f]+ [123]\t(.+)$/);
    if (stageMatch) {
      files.add(stageMatch[1]);
      continue;
    }
    const conflictMatch = line.match(/^CONFLICT \([^)]+\): .* in (.+)$/);
    if (conflictMatch) {
      files.add(conflictMatch[1]);
    }
  }
  return [...files].sort();
}

const DASHBOARD_START = "<!-- openhanako-conflict-dashboard:start -->";
const DASHBOARD_END = "<!-- openhanako-conflict-dashboard:end -->";

function shortSha(sha) {
  return sha ? sha.slice(0, 8) : "<unknown>";
}

function bulletList(items, fallback = "None") {
  if (!items?.length) {
    return `- ${fallback}`;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderPrDashboardBlock(report) {
  const conflicts = report.conflicts?.length
    ? report.conflicts.map((item) => [
      `- \`${item.file}\``,
      `  - strategy: \`${item.strategy}\` (${item.source}${item.risk ? `, ${item.risk}` : ""})`,
      `  - planned action: ${item.plannedAction}`,
    ].join("\n")).join("\n")
    : "- No merge-tree conflicts detected.";
  const latestCommits = (report.upstreamSignals?.latestCommits ?? []).map((line) => `\`${line}\``);
  const riskyFiles = (report.upstreamSignals?.riskyFilesTouched ?? []).map((file) => `\`${file}\``);

  return [
    DASHBOARD_START,
    "## Fork Sync Dashboard",
    "",
    `Updated: ${report.generatedAt}`,
    "",
    "### Human Gate",
    "",
    "**Permanent draft dashboard. Never merge. Never close unless replaced by another numbered dashboard PR.**",
    "",
    "### Base State",
    "",
    `- upstream/main: \`${shortSha(report.dashboardBase?.upstreamMain)}\``,
    `- origin/main before: \`${shortSha(report.dashboardBase?.originMainBefore)}\``,
    `- origin/main after: \`${shortSha(report.dashboardBase?.originMainAfter)}\``,
    `- origin/main replaced from upstream/main: \`${Boolean(report.dashboardBase?.originMainReplaced)}\``,
    `- origin/dev: \`${shortSha(report.forkHead?.originDev)}\``,
    "",
    "### Production Sync",
    "",
    `- latest stable tag: \`${report.productionSync?.latestStableTag || "<none>"}\``,
    `- last synced stable tag: \`${report.productionSync?.lastSyncedTag || "<none>"}\``,
    `- stable sync available: \`${Boolean(report.productionSync?.stableSyncAvailable)}\``,
    "",
    "### PR State",
    "",
    `- PR: #${report.pr?.number ?? 1}`,
    `- URL: ${report.pr?.url ?? "https://github.com/karlorz/openhanako/pull/1"}`,
    `- mergeability: \`${report.pr?.mergeable ?? "UNKNOWN"}\``,
    "",
    "### Conflict Plan",
    "",
    conflicts,
    "",
    "### Latest Upstream Signals",
    "",
    "Latest commits in `origin/dev..origin/main`:",
    "",
    bulletList(latestCommits, "No commits ahead of dev."),
    "",
    "Risky fork files touched by upstream:",
    "",
    bulletList(riskyFiles, "No configured risky files touched."),
    "",
    "### Agent Drilldown",
    "",
    "```bash",
    "gh pr view 1 --json mergeable,statusCheckRollup",
    "gh pr diff 1 --name-only",
    "git log --oneline origin/dev..origin/main",
    "git diff --stat origin/main...origin/dev",
    "node scripts/sync-upstream.mjs --conflict-plan --no-pr-update",
    "node scripts/sync-upstream.mjs --conflict-plan --json --no-pr-update",
    "```",
    DASHBOARD_END,
  ].join("\n");
}

export function buildPrBodyWithDashboard(existingBody, dashboardBlock) {
  const startIndex = existingBody.indexOf(DASHBOARD_START);
  const endIndex = existingBody.indexOf(DASHBOARD_END);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return [
      existingBody.slice(0, startIndex).trimEnd(),
      dashboardBlock,
      existingBody.slice(endIndex + DASHBOARD_END.length).trimStart(),
    ].filter(Boolean).join("\n\n");
  }
  return [existingBody.trimEnd(), dashboardBlock].filter(Boolean).join("\n\n");
}

function preflight(rules) {
  for (const command of ["git", "node", "npx"]) {
    if (!commandExists(command)) {
      die(`${command} not found`);
    }
  }

  const upstreamRemote = rules.releaseTarget.upstreamRemote;
  if (run("git", ["remote", "get-url", upstreamRemote], { capture: true }).status !== 0) {
    die(`remote '${upstreamRemote}' not configured. Run: git remote add upstream https://github.com/liliMozi/openhanako.git`);
  }

  for (const requiredFile of [rules.releaseTarget.syncLog, rules.issueTracking.tracker]) {
    if (!fs.existsSync(path.join(ROOT, requiredFile))) {
      die(`${requiredFile} not found at repo root`);
    }
  }

  info(`preflight ok (repo: ${ROOT})`);
}

function issueTrackingReport(rules) {
  print();
  print(bold("Upstream issue tracking"));
  if (!commandExists("gh")) {
    warn(`gh not found - skip live issue search. Run 'node ${rules.issueTracking.tracker} search' after GitHub CLI is available.`);
    return;
  }

  const result = run("node", [rules.issueTracking.tracker, "search"]);
  if (result.status === 0) {
    ok("issue search complete");
  } else {
    warn(`issue search failed - continue only after manually reviewing docs/upstream-issues/README.md and ${rules.releaseTarget.syncLog}`);
  }
}

function latestUpstreamTagFromGh(rules, includePrerelease) {
  if (!commandExists("gh")) {
    warn("gh not found - cannot filter draft/prerelease releases; falling back to local git tags.");
    return "";
  }

  const result = run(
    "gh",
    [
      "release",
      "list",
      "--repo",
      rules.releaseTarget.upstreamRepo,
      "--json",
      "tagName,isPrerelease,isDraft,publishedAt",
      "--limit",
      "50",
    ],
    { capture: true },
  );
  if (result.status !== 0) {
    warn("GitHub release lookup failed; falling back to local git tags.");
    return "";
  }

  try {
    return selectLatestReleaseTag(JSON.parse(result.stdout), { includePrerelease });
  } catch {
    warn("GitHub release lookup returned invalid JSON; falling back to local git tags.");
    return "";
  }
}

function latestUpstreamTagFromGit(rules, includePrerelease) {
  const remoteBranch = `${rules.releaseTarget.upstreamRemote}/${rules.releaseTarget.upstreamBranch}`;
  const result = run("git", ["tag", "--sort=-creatordate", "--list", "v*", "--merged", remoteBranch], { capture: true });
  if (result.status !== 0) {
    return "";
  }
  const tags = result.stdout
    .trim()
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (includePrerelease) {
    return tags[0] ?? "";
  }
  return tags.find((tag) => !/[A-Za-z-]/.test(tag.replace(/^v[0-9.]+/, ""))) ?? "";
}

function latestUpstreamTag(rules, includePrerelease) {
  return latestUpstreamTagFromGh(rules, includePrerelease) || latestUpstreamTagFromGit(rules, includePrerelease);
}

function lastSyncedTag(rules) {
  const syncLogPath = path.join(ROOT, rules.releaseTarget.syncLog);
  const rows = fs
    .readFileSync(syncLogPath, "utf8")
    .split("\n")
    .filter((line) => /^\| [0-9]{4}-[0-9]{2}-[0-9]{2} /.test(line));
  const tags = rows.map((row) => row.match(/v[0-9]+(?:\.[0-9]+)+(?:[-.][A-Za-z0-9]+)*/)?.[0]).filter(Boolean);
  return tags.at(-1) ?? "";
}

function filesChangedByUpstreamSinceForkPoint(rules) {
  const remoteBranch = `${rules.releaseTarget.upstreamRemote}/${rules.releaseTarget.upstreamBranch}`;
  const forkPoint = run("git", ["merge-base", remoteBranch, "HEAD"], { capture: true }).stdout?.trim();
  if (!forkPoint) {
    return [];
  }
  const result = run("git", ["diff", "--name-only", `${forkPoint}..${remoteBranch}`], { capture: true });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .trim()
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function doCheck(rules, includePrerelease) {
  info("fetching upstream tags...");
  if (run("git", ["fetch", rules.releaseTarget.upstreamRemote, "--tags", "--quiet"]).status !== 0) {
    die("fetch failed");
  }

  issueTrackingReport(rules);

  const latest = latestUpstreamTag(rules, includePrerelease);
  if (!latest) {
    die("no upstream tags found");
  }
  const taggedLast = lastSyncedTag(rules);

  print();
  print(bold("Upstream sync status"));
  print(`  Release channel:       ${releaseChannelLabel(includePrerelease)}`);
  print(`  Latest upstream tag:   ${latest}`);
  print(`  Last synced tag:       ${taggedLast || "<none - baseline>"}`);
  print();

  if (latest === taggedLast) {
    ok("Already up to date - no new release to sync.");
    return 0;
  }

  warn(`New upstream tag available: ${latest}`);
  print();

  const touched = changedDivergingFiles(filesChangedByUpstreamSinceForkPoint(rules), rules);
  print(bold("Files upstream changed since fork point (intersection with our diverging files):"));
  if (touched.length === 0) {
    print(green("  ok None of the diverging files touched upstream - rebase should be clean."));
  } else {
    for (const file of touched) {
      print(red(`  x ${file} - CONFLICT LIKELY, see ${rules.releaseTarget.syncLog} policy`));
    }
  }

  print();
  print(bold("Next step:"));
  print(`  Run ${bold("node scripts/sync-upstream.mjs")} (no --check) to sync.`);
  print(`  Use ${bold("node scripts/sync-upstream.mjs --include-prerelease --check")} only for prerelease candidate review.`);
  print("  Check issue #1749 status: https://github.com/liliMozi/openhanako/issues/1749");
  return 1;
}

function printConflictPolicy(rules) {
  print();
  print(bold(`Per-file conflict policy (from ${rules.releaseTarget.syncLog}):`));
  const syncDoc = fs.readFileSync(path.join(ROOT, rules.releaseTarget.syncLog), "utf8");
  const match = syncDoc.match(/^## Diverging files[\s\S]*?(?=^## The fixed commits)/m);
  print(match ? match[0].trimEnd() : "No diverging-file policy section found.");
  print();
}

function gitRevParse(ref) {
  const result = run("git", ["rev-parse", "--verify", ref], { capture: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

function gitLines(args) {
  const result = run("git", args, { capture: true });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function mergeTreeConflictingFiles(baseRef, headRef) {
  const result = run("git", ["merge-tree", "--write-tree", baseRef, headRef], { capture: true });
  return parseMergeTreeConflictingFiles(`${result.stdout ?? ""}${result.stderr ?? ""}`);
}

function readPr(rules, prNumber) {
  if (!commandExists("gh")) {
    return { number: prNumber, url: `https://github.com/karlorz/openhanako/pull/${prNumber}`, mergeable: "GH_UNAVAILABLE", body: "" };
  }
  const result = run("gh", ["pr", "view", String(prNumber), "--json", "number,url,mergeable,body"], { capture: true });
  if (result.status !== 0) {
    return { number: prNumber, url: `https://github.com/karlorz/openhanako/pull/${prNumber}`, mergeable: "UNKNOWN", body: "" };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { number: prNumber, url: `https://github.com/karlorz/openhanako/pull/${prNumber}`, mergeable: "UNKNOWN", body: "" };
  }
}

function ensurePrLabels(labels) {
  if (!commandExists("gh")) {
    return;
  }
  for (const label of labels) {
    run("gh", ["label", "create", label, "--force", "--color", "6f42c1", "--description", "OpenHanako fork sync dashboard"], { capture: true });
  }
}

function updatePrDashboard(rules, dashboardBlock, options) {
  if (options.noPrUpdate || !commandExists("gh")) {
    return false;
  }
  const prNumber = options.prNumber ?? rules.dashboard?.prNumber ?? 1;
  const pr = readPr(rules, prNumber);
  const body = buildPrBodyWithDashboard(pr.body ?? "", dashboardBlock);
  const title = rules.dashboard?.title ?? "DRAFT: permanent fork-vs-upstream review dashboard";
  const labels = rules.dashboard?.labels ?? [];
  ensurePrLabels(labels);
  const args = ["pr", "edit", String(prNumber), "--title", title, "--body-file", "-"];
  for (const label of labels) {
    args.push("--add-label", label);
  }
  const result = runShell(`gh ${args.map((arg) => JSON.stringify(arg)).join(" ")}`, { capture: true, input: body });
  return result.status === 0;
}

function buildConflictReport(rules, options = {}) {
  const prNumber = options.prNumber ?? rules.dashboard?.prNumber ?? 1;
  const upstreamMainRef = `${rules.releaseTarget.upstreamRemote}/${rules.releaseTarget.upstreamBranch}`;
  const originMainRef = `origin/${rules.releaseTarget.upstreamBranch}`;
  const originDevRef = `origin/${rules.releaseTarget.forkBranch}`;

  if (options.fetch !== false) {
    run("git", ["fetch", rules.releaseTarget.upstreamRemote, rules.releaseTarget.upstreamBranch, "--quiet"]);
    run("git", ["fetch", "origin", rules.releaseTarget.upstreamBranch, rules.releaseTarget.forkBranch, "--quiet"]);
  }

  const upstreamMain = gitRevParse(upstreamMainRef);
  const originMainBefore = gitRevParse(originMainRef);
  if (options.syncMain !== false && upstreamMain) {
    const lease = originMainBefore ? `--force-with-lease=${rules.releaseTarget.upstreamBranch}:${originMainBefore}` : "--force-with-lease";
    const pushResult = run(
      "git",
      ["push", lease, "origin", `${upstreamMainRef}:refs/heads/${rules.releaseTarget.upstreamBranch}`],
      { capture: true },
    );
    if (pushResult.status !== 0) {
      warn(`origin/main replacement failed; continuing with fetched refs only. ${pushResult.stderr?.trim() || pushResult.stdout?.trim() || ""}`);
    } else if (options.fetch !== false) {
      run("git", ["fetch", "origin", rules.releaseTarget.upstreamBranch, "--quiet"]);
    }
  }

  const originMainAfter = gitRevParse(originMainRef);
  const originDev = gitRevParse(originDevRef);
  const conflicts = mergeTreeConflictingFiles(originMainRef, originDevRef);
  const conflictPlan = buildConflictPlan(conflicts, rules, { generatedAt: options.generatedAt });
  const latestStableTag = latestUpstreamTag(rules, false);
  const syncedTag = lastSyncedTag(rules);
  const pr = readPr(rules, prNumber);
  const latestCommits = gitLines(["log", "--oneline", "--max-count=10", `${originDevRef}..${originMainRef}`]);
  const riskyFilesTouched = changedDivergingFiles(gitLines(["diff", "--name-only", `${originDevRef}..${originMainRef}`]), rules);
  return {
    ...conflictPlan,
    dashboardBase: {
      upstreamMain,
      originMainBefore,
      originMainAfter,
      originMainReplaced: Boolean(upstreamMain && originMainAfter && upstreamMain === originMainAfter && originMainBefore !== originMainAfter),
    },
    forkHead: {
      originDev,
    },
    productionSync: {
      latestStableTag,
      lastSyncedTag: syncedTag,
      stableSyncAvailable: Boolean(latestStableTag && latestStableTag !== syncedTag),
    },
    pr: {
      number: pr.number ?? prNumber,
      url: pr.url ?? `https://github.com/karlorz/openhanako/pull/${prNumber}`,
      mergeable: pr.mergeable ?? "UNKNOWN",
    },
    upstreamSignals: {
      latestCommits,
      riskyFilesTouched,
    },
  };
}

function renderConflictPlanText(report) {
  const lines = [
    `Conflict plan (${report.dryRun ? "dry-run" : "execute"}, default: ${report.defaultResolution})`,
    `  upstream/main: ${shortSha(report.dashboardBase?.upstreamMain)}`,
    `  origin/main:   ${shortSha(report.dashboardBase?.originMainAfter)}`,
    `  origin/dev:    ${shortSha(report.forkHead?.originDev)}`,
    `  PR #${report.pr?.number ?? 1}: ${report.pr?.mergeable ?? "UNKNOWN"}`,
    "",
  ];
  if (!report.conflicts.length) {
    lines.push("  ok No merge-tree conflicts detected.");
    return lines.join("\n");
  }
  for (const item of report.conflicts) {
    const risk = item.risk ? `, risk: ${item.risk}` : "";
    lines.push(`  - ${item.file}: ${item.strategy}${risk}, source: ${item.source}`);
    lines.push(`    ${item.plannedAction}`);
  }
  return lines.join("\n");
}

function doConflictPlan(rules, options) {
  const report = buildConflictReport(rules, options);
  const dashboardBlock = renderPrDashboardBlock(report);
  const updatedPr = updatePrDashboard(rules, dashboardBlock, options);
  if (options.json) {
    print(JSON.stringify({ ...report, prUpdated: updatedPr }, null, 2));
  } else {
    print(renderConflictPlanText(report));
    if (!options.noPrUpdate) {
      print(updatedPr ? green("ok PR dashboard updated") : yellow("! PR dashboard not updated"));
    }
  }
}

function doSync(rules, includePrerelease) {
  preflight(rules);

  info("verifying working tree clean...");
  if (run("git", ["diff", "--quiet"], { capture: true }).status !== 0) {
    die("working tree dirty - commit or stash first");
  }
  if (run("git", ["diff", "--cached", "--quiet"], { capture: true }).status !== 0) {
    die("index has staged changes - commit or stash first");
  }

  const branch = run("git", ["branch", "--show-current"], { capture: true }).stdout.trim();
  info(`current branch: ${branch}`);
  if (branch !== rules.releaseTarget.forkBranch) {
    die(`not on '${rules.releaseTarget.forkBranch}' - checkout ${rules.releaseTarget.forkBranch} first`);
  }

  info("fetching upstream tags + main...");
  if (run("git", ["fetch", rules.releaseTarget.upstreamRemote, "--tags", "--quiet"]).status !== 0) {
    die("fetch failed");
  }
  issueTrackingReport(rules);

  const latest = latestUpstreamTag(rules, includePrerelease);
  if (!latest) {
    die("no upstream tags found");
  }
  info(`latest upstream tag: ${latest} (${releaseChannelLabel(includePrerelease)} mode)`);
  printConflictPolicy(rules);

  info(`rebasing ${rules.releaseTarget.forkBranch} onto ${latest}...`);
  print();
  if (run("git", ["rebase", latest]).status !== 0) {
    print(red("x Rebase stopped - conflicts detected."));
    print();
    print(bold("Conflicting files:"));
    runShell("git diff --name-only --diff-filter=U | sed 's/^/  /'");
    print();
    warn("Resolve each conflict per the policy above. For HUMAN-REVIEW files, inspect both sides carefully.");
    print();
    print(bold("When done:"));
    print("  git add <resolved-files>");
    print("  git rebase --continue");
    print();
    print("Then re-run: node scripts/sync-upstream.mjs --post-rebase");
    process.exit(1);
  }

  ok("rebase clean");
  postRebaseVerify(rules);
}

function grepCheck(check) {
  const filePath = path.join(ROOT, check.file);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const content = fs.readFileSync(filePath, "utf8");
  const patterns = check.patterns ?? [check.pattern];
  return patterns.every((pattern) => content.includes(pattern));
}

function postRebaseVerify(rules) {
  print();
  print(bold("Tier 1 - Unit tests"));
  let testFail = false;
  for (const testPath of rules.verification.tier1Tests) {
    info(`running: ${testPath}`);
    const result = run("npx", ["vitest", "run", testPath], { capture: true });
    if (result.status === 0) {
      ok(`${testPath} passed`);
    } else {
      print(red(`x ${testPath} FAILED`));
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n");
      print(output.replace(/^/gm, "    "));
      testFail = true;
    }
  }
  if (testFail) {
    print();
    die("Tier 1 failed - do NOT deploy. Resolve test failures, then re-run with --post-rebase.");
  }

  print();
  print(bold("Tier 2 - Bundle content grep"));
  for (const command of rules.verification.commands) {
    info(`running: ${command}`);
    if (runShell(command).status !== 0) {
      die(`${command} failed`);
    }
  }

  let bundleFail = false;
  for (const check of rules.verification.bundleGreps) {
    if (grepCheck(check)) {
      ok(check.label);
    } else {
      print(red(`x ${check.label}`));
      bundleFail = true;
    }
  }
  if (bundleFail) {
    print();
    die("Tier 2 failed - fix is absent from bundles. Do NOT deploy.");
  }

  print();
  print(bold("Tier 3 - Live smoke checklist (MANUAL)"));
  for (const [index, step] of rules.verification.liveSmoke.entries()) {
    print(`  ${index + 1}. ${step}`);
  }
  print();
  warn(`Do NOT mark sync complete in ${rules.releaseTarget.syncLog} until all live smoke steps pass.`);
  print();
  print(bold("After manual verification:"));
  print("  - Rebuild server through the unified install/upgrade flow when that design is implemented");
  print("  - Rebuild desktop package and replace /Applications/HanaAgent.app");
  print(`  - Append a row to the sync log in ${rules.releaseTarget.syncLog}`);
  print();
  ok("sync-upstream.mjs complete - awaiting manual Tier 3 + deploy");
}

function usage() {
  print(`sync-upstream.mjs - sync this fork with upstream release tags

Usage:
  node scripts/sync-upstream.mjs --check
  node scripts/sync-upstream.mjs --include-prerelease --check
  node scripts/sync-upstream.mjs --conflict-plan [--json] [--no-pr-update] [--pr <number>]
  node scripts/sync-upstream.mjs
  node scripts/sync-upstream.mjs --include-prerelease
  node scripts/sync-upstream.mjs --post-rebase
  node scripts/sync-upstream.mjs --help

The default release channel is stable only. Prerelease review requires --include-prerelease.
Conflict planning is dry-run for dev, replaces origin/main from upstream/main, and updates PR #1 unless --no-pr-update is set.
The issue workflow supports status/search/draft only and never submits GitHub issues.`);
}

function main(argv) {
  const args = [];
  let includePrerelease = false;
  const conflictOptions = {
    json: false,
    noPrUpdate: false,
    prNumber: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--include-prerelease") {
      includePrerelease = true;
    } else if (arg === "--json") {
      conflictOptions.json = true;
    } else if (arg === "--no-pr-update") {
      conflictOptions.noPrUpdate = true;
    } else if (arg === "--pr") {
      const next = argv[index + 1];
      if (!next || !/^\d+$/.test(next)) {
        die("--pr requires a numeric PR number");
      }
      conflictOptions.prNumber = Number(next);
      index += 1;
    } else {
      args.push(arg);
    }
  }

  const rules = loadRules();
  switch (args[0] ?? "") {
    case "":
      doSync(rules, includePrerelease);
      break;
    case "--check":
      preflight(rules);
      process.exit(doCheck(rules, includePrerelease));
      break;
    case "--conflict-plan":
      doConflictPlan(rules, conflictOptions);
      break;
    case "--post-rebase":
      postRebaseVerify(rules);
      break;
    case "--help":
    case "-h":
      usage();
      break;
    default:
      die(`unknown flag: ${args[0]} (try --help)`);
  }
}

if (process.argv[1] === __filename) {
  main(process.argv.slice(2));
}
