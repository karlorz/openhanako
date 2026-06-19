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
    relatedIssues: [
      {
        number: 1811,
        url: "https://github.com/liliMozi/openhanako/issues/1811",
        state: "OPEN",
        relation: "newer LAN WebSocket auth and CSP reconnect report",
      },
    ],
    searches: [
      "LAN WebSocket query token CSP auth",
      "Tailscale desktop CSP WebSocket 403",
      "connect:probe device_credential query token",
    ],
    resultMustInclude: /LAN|Tailscale|WebSocket|CSP|Electron|connect:probe|device_credential/i,
    notes: [
      "Existing upstream issues cover the LAN connect regression boundary.",
      "Check this issue during every upstream release-tag sync.",
    ],
  },
  {
    id: "lan-query-token-network-hardening",
    title: "LAN query-token URLs need no-referrer and non-following connection probes",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["7ff3ac38"],
    grouping: "fold into LAN query-token/auth bug fix unless reviewed separately",
    searches: [
      "Referrer-Policy token query credential",
      "LAN query token Referer credential leak",
      "connect probe redirect SSRF Electron",
    ],
    resultMustInclude: /Referrer|Referer|token|credential|redirect|SSRF|Electron|LAN|CSP/i,
    relatedIssues: [
      {
        number: 1749,
        url: "https://github.com/liliMozi/openhanako/issues/1749",
        state: "OPEN",
        relation: "LAN/Tailscale CSP and WebSocket auth bug",
      },
      {
        number: 1811,
        url: "https://github.com/liliMozi/openhanako/issues/1811",
        state: "OPEN",
        relation: "newer LAN WebSocket auth and CSP reconnect report",
      },
    ],
    notes: [
      "No exact upstream issue found in the 2026-06-19 search.",
      "This is a hardening companion to LAN query-token support; submit separately only if upstream does not want it folded into the LAN auth fix.",
    ],
    draft: {
      file: "lan-query-token-network-hardening.md",
      title: "[Bug] LAN query-token URLs need referrer and redirect hardening",
      body: [
        "## Summary",
        "",
        "LAN desktop connections need query-token fallback for browser `WebSocket` and other browser-loadable URLs, because those APIs cannot attach an `Authorization` header. Once a device credential can appear in URLs, renderer pages and server responses should prevent `Referer` leakage. Any Electron main-process connection probe used to work around renderer CSP should also block redirects so an initial trusted probe cannot silently expand to another network target.",
        "",
        "## Expected",
        "",
        "- Renderer HTML uses `Referrer-Policy: no-referrer` or an equivalent referrer policy.",
        "- Server responses set `Referrer-Policy: no-referrer` or an equivalent header.",
        "- Main-process connection probes use non-following fetches and reject redirects.",
        "- LAN query-token support does not introduce credential leakage through browser referrers or redirect-following probes.",
        "",
        "## Actual",
        "",
        "- LAN query-token support can place a device credential in URL query strings for WebSocket/resource-style browser loads.",
        "- Without a referrer policy, any future external navigation or third-party subresource path can leak the credential-bearing URL.",
        "- A main-process probe that follows redirects can be turned into a broader network probe than the user-entered server URL.",
        "",
        "## Related issues",
        "",
        "- #1749 covers the original LAN/Tailscale CSP and WebSocket auth regression.",
        "- #1811 is a newer LAN WebSocket auth and CSP reconnect report.",
        "",
        "## Local fork fix",
        "",
        "- Add `<meta name=\"referrer\" content=\"no-referrer\">` to renderer HTML entry points.",
        "- Add `Referrer-Policy: no-referrer` to server responses before route handling.",
        "- Use `redirect: \"manual\"` in the Electron `connect:probe` login and identity fetches and reject 3xx responses.",
      ],
    },
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
    id: "desktop-temp-upload-session-cache-materialization",
    title: "Desktop temp upload attachments should be materialized into session cache",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["ce498f68"],
    grouping: "fix: materialize temp uploads to session cache before send",
    searches: [
      "temp upload session cache attachment preview",
      "upload attachment preview temp file deleted",
      "session-files attachment materialize upload",
    ],
    resultMustInclude: /temp|upload|attachment|preview|session-files|cache|file/i,
    notes: [
      "No exact upstream issue found in the 2026-06-19 search.",
      "This is adjacent to remote attachment persistence but covers local desktop temp-upload paths before send.",
    ],
    draft: {
      file: "desktop-temp-upload-session-cache-materialization.md",
      title: "[Bug] Desktop temp upload attachments can outlive their source temp files",
      body: [
        "## Summary",
        "",
        "Desktop upload flows can pass display attachments backed by temporary upload paths. If those paths are later cleaned up or are not stable for the session lifecycle, message attachment previews and prompt file references can point at files that no longer exist.",
        "",
        "## Expected",
        "",
        "- Files selected or pasted through desktop upload flows are copied into the session-owned cache before send.",
        "- Display attachment paths and session file refs point at stable session-cache paths.",
        "- The original temp upload path is not required after the message is submitted.",
        "- Materialization refuses symlink sources and avoids clobbering existing cached files.",
        "",
        "## Actual",
        "",
        "- A display attachment can retain its original temp upload path.",
        "- Later cleanup of the temp location can break preview rendering or downstream file reference resolution.",
        "",
        "## Local fork fix",
        "",
        "- Copy temp upload display attachments into the session-files cache during desktop session submission.",
        "- Use exclusive copies and a bounded unique-name loop to avoid overwriting existing files.",
        "- Reject symlink temp upload sources and fall back to the original path on materialization failure so sending does not regress.",
      ],
    },
  },
  {
    id: "plugin-iframe-remote-credential-query-leak",
    title: "Remote plugin iframe URL leaks device credential in query token",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["7370276c"],
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
    commits: ["d39fae81"],
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
    commits: ["f7b26a2f"],
    grouping: "docs: add fork sync policy and upstream issue helper",
    searches: [],
    notes: [
      "Fork maintenance workflow for karlorz/openhanako, not an upstream product bug.",
      "Default sync follows stable upstream releases only; --include-prerelease is explicit candidate review.",
    ],
  },
  {
    id: "fork-dev-loop-maintenance-runbooks",
    title: "Fork dev-loop and sg01 maintenance runbooks",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["e35b4969", "62908b57", "4dd0f429", "fc39a87e"],
    grouping: "docs/chore: dev-loop setup and retired sg01 deploy helper",
    searches: [],
    notes: [
      "Fork operator documentation and local automation hygiene.",
      "The old sg01 SSH deploy helper was intentionally retired in favor of the unified install-server flow.",
    ],
  },
  {
    id: "server-install-upgrade-release-safety",
    title: "Fork server install and upgrade release safety",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: [
      "bf7e0750",
      "628d493c",
      "7ff3ac38",
      "82675262",
      "3039571a",
      "662bf15c",
      "4123c604",
      "74ae705b",
      "80373bcb",
      "b942d866",
      "45c5d651",
      "89488752",
      "7160bacd",
      "f246d977",
      "7cd6c725",
      "84e930d6",
      "306c33d6",
      "c46359d1",
    ],
    grouping: "install-server: verified release assets, safe upgrade, preserved service context",
    searches: [],
    notes: [
      "Fork-only Linux server installer and release packaging flow; upstream v0.323.0 does not ship scripts/install-server.mjs.",
      "Covers release asset selection, sha256 sidecars, checksum verification without shell interpolation, native bundle runners, client assets in server bundles, release-root extraction, metadata-file loading, systemd directive preservation, and upgrade rollback behavior.",
    ],
  },
  {
    id: "server-reinit-data-failsafe",
    title: "Fork server reinit-data failsafe, operational preserve, and restore",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["4204ad27", "c00551da", "03d8c06e", "6a004b3e", "15d27acd"],
    grouping: "install-server: backup-gated reinit-data with operational preserve and latest full-state restore",
    searches: [],
    notes: [
      "Fork-only operational reset/import workflow for first-run and new-user testing on managed Linux server installs.",
      "Covers dry-run planning, backup/confirm/restore flows, provider/device/server-network preserve, studio access preserve, and latest-full-state restore selection.",
    ],
  },
  {
    id: "server-reinit-restore-backup-verification",
    title: "Fork server reinit-data restore verifies backup target before mutation",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["dc8bae99"],
    grouping: "install-server: reject wrong-root restore backups before data-root replacement",
    searches: [],
    notes: [
      "Found during the v0.323.0..dev code review and fixed locally before handoff.",
      "Explicit restore backups now fail verification when the manifest dataRoot differs from the requested data root or the archive omits the expected data-root directory.",
    ],
  },
  {
    id: "node-test-ci-file-mode-hygiene",
    title: "Node test and CI file mode hygiene for fork tooling",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["84a405a3", "7160bacd"],
    grouping: "tests/lint: .mjs node tests, LF enforcement, and eslint coverage",
    searches: [],
    notes: [
      "Fork maintenance for Node ESM test execution and cross-platform line-ending stability.",
      "Included because it protects the fork-only install-server/upstream-issue tooling tests.",
    ],
  },
];

export function markdownTable(rows) {
  const lines = [
    "| fix | classification | status | upstream | grouping |",
    "|---|---|---|---|---|",
  ];
  for (const fix of rows) {
    const upstreamIssues = [
      ...(fix.existingIssue ? [fix.existingIssue] : []),
      ...(fix.relatedIssues ?? []),
    ];
    const upstream = upstreamIssues.length
      ? upstreamIssues.map((issue) => `[#${issue.number}](${issue.url})`).join(", ")
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
