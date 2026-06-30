import { describe, expect, it } from "vitest";

import {
  TRACKED_FIXES,
  filterIssueResults,
  markdownTable,
  renderDraftIssue,
  renderStatusMarkdown,
  searchableFixes,
} from "../scripts/track-upstream-issues.mjs";

describe("upstream issue tracker", () => {
  it("tracks every current local divergence cluster", () => {
    expect(TRACKED_FIXES.map((fix) => fix.id)).toEqual([
      "lan-csp-ws-auth",
      "lan-query-token-network-hardening",
      "remote-attachment-preview-persistence",
      "desktop-temp-upload-session-cache-materialization",
      "session-replay-marker-only-image-regenerate",
      "toolgroup-file-detail-link-context",
      "remote-skill-viewer-local-file-ipc",
      "remote-skill-install-client-local-path",
      "plugin-iframe-remote-credential-query-leak",
      "local-build-identity-disable-auto-update",
      "fork-sync-issue-tracking-prerelease-policy",
      "fork-dev-loop-maintenance-runbooks",
      "office-workflow-example-plugin",
      "office-workflow-resourceio-session-permission",
      "server-install-upgrade-release-safety",
      "server-reinit-data-failsafe",
      "server-reinit-restore-backup-verification",
      "node-test-ci-file-mode-hygiene",
    ]);
  });

  it("keeps fork-only maintenance out of upstream searches", () => {
    expect(searchableFixes().map((fix) => fix.id)).not.toContain(
      "local-build-identity-disable-auto-update",
    );
    expect(searchableFixes().map((fix) => fix.id)).not.toContain(
      "fork-sync-issue-tracking-prerelease-policy",
    );
  });

  it("renders the issue status table with existing and draft states", () => {
    const status = renderStatusMarkdown();

    expect(status).toContain("lan-csp-ws-auth");
    expect(status).toContain("[#1749](https://github.com/liliMozi/openhanako/issues/1749)");
    expect(status).toContain("[#1811](https://github.com/liliMozi/openhanako/issues/1811)");
    expect(status).toContain("[#1811](https://github.com/liliMozi/openhanako/issues/1811) CLOSED");
    expect(status).toContain("desktop-temp-upload-session-cache-materialization");
    expect(status).toContain("office-workflow-example-plugin");
    expect(status).toContain("office-workflow-resourceio-session-permission");
    expect(status).toContain("server-reinit-data-failsafe");
    expect(status).toContain("server-reinit-restore-backup-verification");
    expect(status).toContain("draft/pending-approval");
    expect(status).toContain("tracked/no-upstream-issue");
  });

  it("escapes markdown table cells", () => {
    expect(
      markdownTable([
        {
          id: "a|b",
          classification: "upstream",
          status: "draft",
          grouping: "one\ntwo",
        },
      ]),
    ).toContain("a\\|b");
    expect(markdownTable([{ id: "x", classification: "y", status: "z", grouping: "one\ntwo" }])).toContain(
      "one two",
    );
  });

  it("redacts credential examples in plugin iframe draft text", () => {
    const fix = TRACKED_FIXES.find((item) => item.id === "plugin-iframe-remote-credential-query-leak");

    const draft = renderDraftIssue(fix);

    expect(draft).toContain("[REDACTED:device-credential]");
    expect(draft).not.toMatch(/token=[A-Za-z0-9_-]{12,}/);
  });

  it("filters unrelated fuzzy GitHub search matches", () => {
    const fix = TRACKED_FIXES.find((item) => item.id === "lan-csp-ws-auth");

    expect(
      filterIssueResults(fix, [
        {
          number: 403,
          title: "[Feature] social platform QQ image aggregation",
          url: "https://github.com/liliMozi/openhanako/issues/403",
        },
        {
          number: 1749,
          title: "[Bug] Electron LAN/Tailscale CSP WebSocket 403",
          url: "https://github.com/liliMozi/openhanako/issues/1749",
        },
      ]).map((issue) => issue.number),
    ).toEqual([1749]);
  });
});
