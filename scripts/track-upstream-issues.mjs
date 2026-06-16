#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const UPSTREAM_REPO = "liliMozi/openhanako";
export const ISSUE_DOCS_DIR = path.join(ROOT, "docs", "upstream-issues");
export const DRAFTS_DIR = path.join(ISSUE_DOCS_DIR, "drafts");

export const TRACKED_FIXES = [
  {
    id: "lan-csp-ws-auth",
    title: "LAN/Tailscale desktop connect fails due to CSP bootstrapping and WebSocket auth",
    classification: "upstream",
    status: "existing/open",
    commits: ["80ea81ae", "ae7fd31c"],
    grouping: "LAN query-token/auth bug fix",
    existingIssue: {
      number: 1749,
      url: "https://github.com/liliMozi/openhanako/issues/1749",
      state: "OPEN",
    },
    searches: [
      "LAN WebSocket query token CSP auth",
      "Tailscale desktop CSP WebSocket 403",
      "connect:probe device_credential query token",
    ],
    resultMustInclude: /LAN|Tailscale|WebSocket|CSP|Electron|connect:probe|device_credential/i,
    notes: [
      "Existing upstream issue covers the LAN connect regression boundary.",
      "Check this issue during every upstream release-tag sync.",
    ],
  },
  {
    id: "remote-attachment-preview-persistence",
    title: "Remote desktop session attachments lose preview after chat switch",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["434c3e30"],
    grouping: "fix: preserve remote session attachment previews",
    searches: [
      "remote attachment preview upload Conversation Files",
      "session files preview remote desktop upload blob",
      "remote resource preview chat switch Conversation Files",
    ],
    resultMustInclude: /remote|attachment|preview|Conversation Files|session files|resource|upload/i,
    notes: [
      "No exact upstream issue found in the 2026-06-16 search.",
      "Draft only; do not submit until the fork owner approves the exact upstream wording.",
    ],
    draft: {
      file: "remote-attachment-preview-persistence.md",
      title: "[Bug] Remote desktop session attachments lose previews after switching chats",
      body: [
        "## Summary",
        "",
        "When the macOS desktop app is connected to a remote Hana server, pasted or uploaded local files can be persisted in a form that the remote Linux server cannot later resolve. The current chat can show transient inline bytes, but after switching chats and returning, chat thumbnails and Conversation Files previews can disappear.",
        "",
        "## Expected",
        "",
        "- Local desktop-owned files are uploaded to the active remote server before send.",
        "- Persisted remote session files resolve through server resource URLs.",
        "- Runtime CSP allows only the active remote HTTP(S) origin for image and media previews.",
        "- Chat thumbnails and Conversation Files previews survive chat switching.",
        "",
        "## Actual",
        "",
        "- The remote server can receive local macOS paths it cannot import.",
        "- Previews may rely on transient inline bytes that disappear after the active chat changes.",
        "- Older session attachments may no longer render in Conversation Files.",
        "",
        "## Local fork fix",
        "",
        "- Upload client-owned desktop files through `/api/upload-blob` when connected to a remote server.",
        "- Synthesize `/api/resources/res_<fileId>/content` URLs for remote session files when no explicit resource link exists.",
        "- Scope the active remote HTTP(S) origin into runtime CSP `img-src` and `media-src` without widening to bare `http:` or `https:`.",
        "",
        "## Verification",
        "",
        "- Paste or upload an image through a remote desktop connection.",
        "- Send it, switch to another chat, then return.",
        "- Confirm both the chat thumbnail and Conversation Files preview still render.",
      ],
    },
  },
  {
    id: "plugin-iframe-remote-credential-query-leak",
    title: "Remote plugin iframe URL leaks device credential in query token",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["uncommitted"],
    grouping: "fold into LAN query-token/auth bug fix unless reviewed separately",
    searches: [
      "plugin iframe token credential leak remote",
      "pluginIframeTicket pluginSurfaceSession token",
      "remote plugin iframe device credential query",
    ],
    resultMustInclude: /plugin|iframe|credential|token|pluginIframeTicket|pluginSurfaceSession/i,
    relatedIssues: [
      {
        number: 1493,
        url: "https://github.com/liliMozi/openhanako/issues/1493",
        state: "OPEN",
        relation: "local plugin iframe missing credentials",
      },
      {
        number: 1546,
        url: "https://github.com/liliMozi/openhanako/issues/1546",
        state: "CLOSED",
        relation: "older community plugin iframe load failure",
      },
    ],
    notes: [
      "No exact upstream issue found in the 2026-06-16 search.",
      "This is related to iframe auth, but it is not a duplicate of the local-loopback missing credential issue.",
    ],
    draft: {
      file: "plugin-iframe-remote-credential-query-leak.md",
      title: "[Bug] Remote plugin iframe URLs expose device credentials in query strings",
      body: [
        "## Summary",
        "",
        "After LAN query-token support, the desktop plugin surface URL builder can place the remote device credential into a plugin iframe URL as `token=[REDACTED:device-credential]`. Query strings are visible through browser history, logs, screenshots, and referrer-adjacent tooling, so remote device credentials should not be carried this way.",
        "",
        "## Expected",
        "",
        "- Local owner connections may continue using the local loopback query token path required for iframe loading.",
        "- Remote plugin iframe URLs should use scoped iframe/session credentials such as `pluginIframeTicket` and `pluginSurfaceSession`.",
        "- Remote device credentials should not appear in plugin iframe query strings.",
        "",
        "## Actual",
        "",
        "- Remote plugin iframe URLs can include `token=[REDACTED:device-credential]`.",
        "- The hook already has scoped plugin iframe/session values available, but the generic query-token path can override the safer remote behavior.",
        "",
        "## Related issues",
        "",
        "- #1493 covers missing credentials for local plugin iframe surfaces.",
        "- #1546 is an older plugin iframe loading bug.",
        "- #1749 covers the LAN query-token/CSP/WebSocket regression boundary.",
        "",
        "## Local fork fix",
        "",
        "In `buildPluginSurfaceUrl`, append a query `token` only for `isLocalOwnerConnection(connection)`. Remote plugin iframe URLs keep using the issued plugin iframe ticket/session fields.",
      ],
    },
  },
  {
    id: "local-build-identity-disable-auto-update",
    title: "Local fork builds identify source and disable upstream auto-update",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["uncommitted"],
    grouping: "chore: identify local fork builds and disable local auto-update",
    searches: [],
    notes: [
      "Fork maintenance behavior, not an upstream bug.",
      "Do not draft or submit an upstream issue unless the project later wants an official local-build channel feature.",
    ],
  },
  {
    id: "fork-sync-issue-tracking-prerelease-policy",
    title: "Fork sync tracks upstream issues and ignores prereleases by default",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["uncommitted"],
    grouping: "docs: add fork sync policy and upstream issue helper",
    searches: [],
    notes: [
      "Fork maintenance workflow for karlorz/openhanako, not an upstream product bug.",
      "Default sync follows stable upstream releases only; --include-prerelease is explicit candidate review.",
    ],
  },
];

export function markdownTable(rows) {
  const lines = [
    "| fix | classification | status | upstream | grouping |",
    "|---|---|---|---|---|",
  ];
  for (const fix of rows) {
    const upstream = fix.existingIssue
      ? `[#${fix.existingIssue.number}](${fix.existingIssue.url})`
      : fix.relatedIssues?.length
        ? fix.relatedIssues.map((issue) => `[#${issue.number}](${issue.url})`).join(", ")
        : "none";
    lines.push(
      `| ${escapeCell(fix.id)} | ${escapeCell(fix.classification)} | ${escapeCell(fix.status)} | ${upstream} | ${escapeCell(fix.grouping)} |`,
    );
  }
  return lines.join("\n");
}

export function renderStatusMarkdown(rows = TRACKED_FIXES) {
  return [
    "# Upstream Issue Tracking",
    "",
    "This file tracks local fork fixes against upstream GitHub issues. The source of truth for the tracked fix list is `scripts/track-upstream-issues.mjs`.",
    "",
    markdownTable(rows),
    "",
    "## Rules",
    "",
    "- Track every local fix or maintenance slice.",
    "- Search upstream for every `upstream` or `needs-triage` item.",
    "- Keep `fork-only` items documented without upstream issue noise.",
    "- Draft issue bodies locally first. Submit only after explicit owner approval.",
    "- Do not store live credentials, tokens, cookies, or server secrets in drafts.",
    "",
    "## Commands",
    "",
    "```bash",
    "node scripts/track-upstream-issues.mjs status",
    "node scripts/track-upstream-issues.mjs search",
    "node scripts/track-upstream-issues.mjs draft",
    "```",
    "",
  ].join("\n");
}

export function renderDraftIssue(fix) {
  if (!fix.draft) {
    throw new Error(`${fix.id} does not have a draft issue`);
  }
  const related = [
    ...(fix.existingIssue ? [fix.existingIssue] : []),
    ...(fix.relatedIssues ?? []),
  ];
  return [
    `# ${fix.draft.title}`,
    "",
    "> Local draft only. Do not submit upstream until the fork owner approves.",
    "",
    `Tracked fix: \`${fix.id}\``,
    `Classification: \`${fix.classification}\``,
    `Current status: \`${fix.status}\``,
    `Suggested grouping: \`${fix.grouping}\``,
    `Commits: ${fix.commits.map((commit) => `\`${commit}\``).join(", ")}`,
    "",
    ...(related.length
      ? [
          "Related upstream issues:",
          "",
          ...related.map((issue) => `- #${issue.number}: ${issue.url}`),
          "",
        ]
      : []),
    ...fix.draft.body,
    "",
  ].join("\n");
}

export function writeDrafts(rows = TRACKED_FIXES) {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const written = [];
  for (const fix of rows) {
    if (!fix.draft) continue;
    const outPath = path.join(DRAFTS_DIR, fix.draft.file);
    fs.writeFileSync(outPath, renderDraftIssue(fix), "utf8");
    written.push(outPath);
  }
  return written;
}

export function writeReadme(rows = TRACKED_FIXES) {
  fs.mkdirSync(ISSUE_DOCS_DIR, { recursive: true });
  const outPath = path.join(ISSUE_DOCS_DIR, "README.md");
  fs.writeFileSync(outPath, renderStatusMarkdown(rows), "utf8");
  return outPath;
}

export function searchableFixes(rows = TRACKED_FIXES) {
  return rows.filter((fix) => fix.classification !== "fork-only" && fix.searches.length > 0);
}

export function runGhIssueSearch(query, repo = UPSTREAM_REPO) {
  const output = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--search",
      query,
      "--state",
      "all",
      "--json",
      "number,title,state,url,labels",
      "--limit",
      "10",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

export function collectSearchResults(rows = TRACKED_FIXES) {
  return searchableFixes(rows).map((fix) => ({
    id: fix.id,
    queries: fix.searches.map((query) => ({
      query,
      results: filterIssueResults(fix, runGhIssueSearch(query)),
    })),
  }));
}

export function filterIssueResults(fix, results) {
  if (!fix.resultMustInclude) return results;
  return results.filter((issue) => fix.resultMustInclude.test(`${issue.title} ${issue.url}`));
}

export function renderSearchResults(results) {
  const lines = ["# Upstream Issue Search Results", ""];
  for (const fix of results) {
    lines.push(`## ${fix.id}`, "");
    for (const query of fix.queries) {
      lines.push(`Query: \`${query.query}\``);
      if (!query.results.length) {
        lines.push("", "- No results.", "");
        continue;
      }
      lines.push("");
      for (const issue of query.results) {
        lines.push(`- #${issue.number} ${issue.state}: ${issue.title} (${issue.url})`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function printHelp() {
  console.log(`Usage: node scripts/track-upstream-issues.mjs <command>

Commands:
  status   Print the tracked local-fix issue table
  search   Query upstream issues with gh and print matches
  draft    Write docs/upstream-issues/README.md and local draft issue files

This script never submits upstream issues. Drafts are local files only.`);
}

function main(argv) {
  const command = argv[2] ?? "status";
  if (command === "status") {
    console.log(renderStatusMarkdown().trimEnd());
    return;
  }
  if (command === "search") {
    console.log(renderSearchResults(collectSearchResults()).trimEnd());
    return;
  }
  if (command === "draft") {
    const readme = writeReadme();
    const drafts = writeDrafts();
    console.log(`Wrote ${path.relative(ROOT, readme)}`);
    for (const draft of drafts) {
      console.log(`Wrote ${path.relative(ROOT, draft)}`);
    }
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
