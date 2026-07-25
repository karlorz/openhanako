import { describe, expect, it } from "vitest";

import {
  assertPrereleaseMutateAllowed,
  buildConflictPlan,
  buildPrBodyWithDashboard,
  changedDivergingFiles,
  forkOnlyFilePatterns,
  ISSUE_COMMANDS,
  isSyncTargetAlreadyPresent,
  lastSyncedTagFromText,
  loadMigrationContracts,
  loadRules,
  minimatch,
  missingForkOnlyFiles,
  parseMergeTreeConflictingFiles,
  parseSyncArgs,
  PRERELEASE_ACCEPT_FLAG,
  prereleaseSyncPolicy,
  releaseChannelLabel,
  renderPrDashboardBlock,
  renderPostRebaseManualGateReport,
  resolvePrereleaseConfirmTag,
  selectLatestReleaseTag,
  verificationCommands,
} from "../scripts/sync-upstream.mjs";

describe("sync-upstream rule engine", () => {
  it("loads the fork-sync policy rules from YAML", () => {
    const rules = loadRules();

    expect(rules.releaseTarget.stableOnlyDefault).toBe(true);
    expect(rules.releaseTarget.prereleaseFlag).toBe("--include-prerelease");
    expect(rules.conflictRules.divergingFiles).toContain("core/server-auth.ts");
    expect(rules.criticalFileClasses).toContain("lan_connect_auth");
    expect(rules.issueTracking.states).toContain("tracked/no-upstream-issue");
  });

  it("selects stable upstream releases by default", () => {
    const releases = [
      { tagName: "v0.325.0-beta.1", isDraft: false, isPrerelease: true },
      { tagName: "v0.324.0", isDraft: false, isPrerelease: false },
      { tagName: "v0.326.0", isDraft: true, isPrerelease: false },
    ];

    expect(selectLatestReleaseTag(releases)).toBe("v0.324.0");
    expect(releaseChannelLabel(false)).toBe("stable only");
  });

  it("allows prerelease review only when explicitly requested", () => {
    const releases = [
      { tagName: "v0.325.0-beta.1", isDraft: false, isPrerelease: true },
      { tagName: "v0.324.0", isDraft: false, isPrerelease: false },
    ];

    expect(selectLatestReleaseTag(releases, { includePrerelease: true })).toBe("v0.325.0-beta.1");
    expect(releaseChannelLabel(true)).toBe("stable + prerelease");
  });

  it("reads multi-segment train tags from the latest sync-log row", () => {
    const syncLog = [
      "| 2026-07-21 | `train-13` | historical |",
      "| 2026-07-23 | `train-beta-15` / `v0.416.43` | current |",
    ].join("\n");

    expect(lastSyncedTagFromText(syncLog)).toBe("train-beta-15");
  });

  it("treats an exact latest sync-log tag as already synchronized", () => {
    expect(
      isSyncTargetAlreadyPresent({
        latestTag: "v0.416.44",
        lastSyncedTag: "v0.416.44",
        targetIsAncestor: false,
      }),
    ).toBe(true);
  });

  it("does not offer an ancestral stable tag after a later prerelease sync", () => {
    expect(
      isSyncTargetAlreadyPresent({
        latestTag: "v0.416.44",
        lastSyncedTag: "train-beta-17",
        targetIsAncestor: true,
      }),
    ).toBe(true);
  });

  it("still reports a genuinely absent target as available", () => {
    expect(
      isSyncTargetAlreadyPresent({
        latestTag: "v0.416.52",
        lastSyncedTag: "train-beta-17",
        targetIsAncestor: false,
      }),
    ).toBe(false);
  });

  it("reports only upstream changes that intersect configured diverging files", () => {
    const rules = loadRules();

    expect(
      changedDivergingFiles(
        ["README.md", "core/server-auth.ts", "desktop/src/react/services/resource-url.ts"],
        rules,
      ),
    ).toEqual(["core/server-auth.ts", "desktop/src/react/services/resource-url.ts"]);
  });

  it("loads fork-only file patterns for the post-rebase presence gate", () => {
    const patterns = forkOnlyFilePatterns(loadRules());

    expect(patterns).toContain("scripts/sync-upstream.mjs");
    expect(patterns).toContain("FORK_SYNC.md");
    expect(patterns).toContain("docs/upstream-issues/**");
    expect(patterns.some((p) => p.startsWith("examples/plugins/office-workflow"))).toBe(true);
  });

  it("inventories the complete fork-only legacy raw release surface", () => {
    const forkPaths = [
      "build/installer-legacy-raw.nsh",
      "desktop/src/shared/release-runtime-policy.cjs",
      "desktop/src/shared/server-reuse-policy.cjs",
      "scripts/electron-builder-config.cjs",
      "scripts/electron-builder.config.cjs",
      "scripts/guard-release-profile.mjs",
      "scripts/prepare-desktop-package.mjs",
      "scripts/release-desktop-with-profile.mjs",
      "scripts/resolve-release-profile.mjs",
      "shared/release-profile.cjs",
    ];
    const focusedTests = [
      "tests/build-server-mode.test.mjs",
      "tests/desktop-artifact-profile-contract.test.mjs",
      "tests/electron-builder-config.test.mjs",
      "tests/legacy-raw-workflow-contract.test.mjs",
      "tests/prepare-desktop-package.test.mjs",
      "tests/release-desktop-with-profile.test.mjs",
      "tests/release-profile-guard.test.mjs",
      "tests/release-profile.test.mjs",
      "tests/release-runtime-policy.test.mjs",
      "tests/resolve-release-profile.test.mjs",
      "tests/server-reuse-policy.test.mjs",
    ];
    const forkOnlyPatterns = forkOnlyFilePatterns(loadRules());
    const releaseContract = loadMigrationContracts().migrationContracts.find(
      (item) => item.id === "legacy-raw-release-profile",
    );

    expect(forkOnlyPatterns).toEqual(expect.arrayContaining([...forkPaths, ...focusedTests]));
    expect(releaseContract?.forkPaths).toEqual(expect.arrayContaining(forkPaths));
    expect(releaseContract?.focusedTests).toEqual(expect.arrayContaining(focusedTests));
  });

  it("protects the durable installer bootstrap and its status dependencies", () => {
    const forkOnlyPatterns = forkOnlyFilePatterns(loadRules());
    const installerContract = loadMigrationContracts().migrationContracts.find(
      (item) => item.id === "server-installer-artifact-activation",
    );

    expect(forkOnlyPatterns).toContain("scripts/install-server-bootstrap.sh");
    expect(installerContract?.forkPaths).toContain("scripts/install-server-bootstrap.sh");
    expect(installerContract?.liveSmoke).toContain(
      "tag-pinned CLI bootstrap detects installer shared imports and installs the status dependency closure before replacing install-server.mjs",
    );
    expect(installerContract?.stopConditions).toContain(
      "the durable installer cannot load its status or release-assessment dependencies",
    );
  });

  it("records the no-certificate macOS fallback and its upload gate", () => {
    const rules = loadRules();
    const workflowPolicy = rules.conflictRules.policies[".github/workflows/build.yml"];
    const releaseContract = loadMigrationContracts().migrationContracts.find(
      (item) => item.id === "legacy-raw-release-profile",
    );

    expect(workflowPolicy.macosNoCertificateFallback).toMatchObject({
      trigger: "missing Apple Developer ID credentials",
      signingDomain: "Apple Developer ID",
      unrelatedInputs: expect.arrayContaining(["HANA_SIGN_KEY", "HANA_SIGN_KEY_PEM"]),
      credentialInputs: ["CSC_LINK", "CSC_KEY_PASSWORD"],
      activationCondition: "any-input-blank",
      environment: ["SKIP_NOTARIZE=true"],
      electronBuilderFlags: ["-c.mac.identity=-", "-c.mac.hardenedRuntime=false"],
      verification: {
        command: "codesign --verify --deep --strict --verbose=2",
        requireResourceSeal: true,
        beforeArtifactUploads: ["signed", "legacy-raw"],
      },
    });
    expect(releaseContract?.focusedTests).toContain(
      "tests/legacy-raw-workflow-contract.test.mjs",
    );
    expect(releaseContract?.liveSmoke).toEqual(expect.arrayContaining([
      "either CSC_LINK or CSC_KEY_PASSWORD blank activates the no-certificate macOS fallback",
      "complete HanaAgent.app bundles are ad-hoc signed and resource-sealed while DMG and ZIP containers remain unsigned and unnotarized when Apple credentials are absent",
      "strict macOS bundle verification runs before signed and legacy-raw artifact uploads",
    ]));
    expect(releaseContract?.stopConditions).toEqual(expect.arrayContaining([
      "a raw macOS fallback omits SKIP_NOTARIZE=true",
      "a raw macOS fallback uses an identity other than -",
      "a raw macOS fallback leaves hardened runtime enabled",
      "artifact upload starts before strict macOS bundle verification",
      "a raw macOS app has no resource seal",
      "strict macOS codesign verification fails",
    ]));
  });

  it("matches glob patterns with the built-in minimatch helper", () => {
    expect(minimatch("docs/upstream-issues/README.md", "docs/upstream-issues/**")).toBe(true);
    expect(minimatch("docs/upstream-issues/drafts/foo.md", "docs/upstream-issues/**")).toBe(true);
    expect(minimatch("docs/server-install.md", "docs/upstream-issues/**")).toBe(false);
    expect(minimatch("examples/plugins/office-workflow/README.md", "examples/plugins/office-workflow/**")).toBe(true);
    expect(minimatch("examples/plugins/office-workflow/lib/x.js", "examples/plugins/office-workflow/**")).toBe(true);
    expect(minimatch("examples/plugins/other/x.js", "examples/plugins/office-workflow/**")).toBe(false);
    expect(minimatch("scripts/sync-upstream.mjs", "scripts/sync-upstream.mjs")).toBe(true);
    expect(minimatch("scripts/other.mjs", "scripts/sync-upstream.mjs")).toBe(false);
  });

  it("reports fork-only patterns that match zero tracked files after a sync", () => {
    const rules = {
      conflictRules: {
        forkOnlyFiles: [
          "scripts/sync-upstream.mjs",
          "docs/upstream-issues/**",
          "examples/plugins/office-workflow/**",
          "scripts/missing-fork-feature.mjs",
        ],
      },
    };
    const trackedFiles = [
      "scripts/sync-upstream.mjs",
      "docs/upstream-issues/README.md",
      "docs/upstream-issues/drafts/foo.md",
      "examples/plugins/office-workflow/index.js",
      "README.md",
    ];

    expect(missingForkOnlyFiles(rules, trackedFiles)).toEqual([
      "scripts/missing-fork-feature.mjs",
    ]);
  });

  it("returns an empty list when no fork-only patterns are configured", () => {
    expect(missingForkOnlyFiles({ conflictRules: {} }, ["README.md"])).toEqual([]);
    expect(missingForkOnlyFiles({ conflictRules: { forkOnlyFiles: [] } }, [])).toEqual([]);
  });

  it("loads verification commands from the rule file", () => {
    expect(verificationCommands(loadRules())).toContain("npm run build:preload");
  });

  it("prints the local desktop version gate before the live smoke checklist", () => {
    const rules = loadRules();
    const report = renderPostRebaseManualGateReport(rules).join("\n");
    const desktopGateIndex = report.indexOf("Tier 3A - Local desktop install/version gate");
    const liveSmokeIndex = report.indexOf("Tier 3B - Live sg01 smoke checklist");

    expect(desktopGateIndex).toBeGreaterThanOrEqual(0);
    expect(liveSmokeIndex).toBeGreaterThan(desktopGateIndex);
    expect(rules.verification.localDesktopGate.commands).toContain("SKIP_NOTARIZE=true npm run install:local");
    expect(report).toContain("node -p \"require('./package.json').version\"");
    expect(report).toContain("CFBundleShortVersionString");
    expect(report).toContain("/Applications/HanaAgent.app/Contents/Resources/build-info.json");
    expect(report).toContain("Settings -> About");
    expect(report).toContain("node scripts/hana-desktop-smoke-helper.mjs --restart --verify --url http://100.125.173.118:14500");
    expect(report).toContain("HANA_DESKTOP_SMOKE_TOKEN=<device-key>");
    expect(report).toContain("Manual fallback path: Settings -> Access -> Connect LAN Server");
  });

  it("supports local upstream issue review modes without a submit mode", () => {
    expect(ISSUE_COMMANDS).toEqual(["status", "search", "draft"]);
    expect(ISSUE_COMMANDS).not.toContain("submit");
  });

  it("keeps local-only conflict planning free of PR edits and origin/main sync", () => {
    const parsed = parseSyncArgs(["--conflict-plan", "--json", "--local-only"]);

    expect(parsed.args).toEqual(["--conflict-plan"]);
    expect(parsed.conflictOptions).toMatchObject({
      json: true,
      noPrUpdate: true,
      syncMain: false,
    });
  });

  it("allows skipping origin/main sync independently from PR updates", () => {
    const parsed = parseSyncArgs(["--conflict-plan", "--no-main-sync"]);

    expect(parsed.args).toEqual(["--conflict-plan"]);
    expect(parsed.conflictOptions).toMatchObject({
      noPrUpdate: false,
      syncMain: false,
    });
  });

  it("loads optional prerelease sync policy with double-consent defaults", () => {
    const rules = loadRules();
    const policy = prereleaseSyncPolicy(rules);

    expect(rules.releaseTarget.stableOnlyDefault).toBe(true);
    expect(rules.releaseTarget.prereleaseSync).toMatchObject({
      enabled: true,
      defaultChannel: false,
      requireAcceptFlag: true,
      requireConfirmExactTag: true,
      allowMainHead: false,
      githubPrereleaseReleasesOnly: true,
    });
    expect(policy.acceptFlag).toBe(PRERELEASE_ACCEPT_FLAG);
    expect(policy.confirmEnv).toBe("CONFIRM");
    expect(policy.allowMainHead).toBe(false);
  });

  it("parses --i-accept-prerelease-sync for the optional prerelease mutate channel", () => {
    const without = parseSyncArgs(["--include-prerelease"]);
    expect(without.includePrerelease).toBe(true);
    expect(without.acceptPrereleaseSync).toBe(false);

    const withAccept = parseSyncArgs([
      "--include-prerelease",
      PRERELEASE_ACCEPT_FLAG,
    ]);
    expect(withAccept.includePrerelease).toBe(true);
    expect(withAccept.acceptPrereleaseSync).toBe(true);
    expect(withAccept.args).toEqual([]);

    const checkOnly = parseSyncArgs(["--include-prerelease", "--check"]);
    expect(checkOnly.includePrerelease).toBe(true);
    expect(checkOnly.acceptPrereleaseSync).toBe(false);
    expect(checkOnly.args).toEqual(["--check"]);
  });

  it("refuses prerelease mutate without accept flag or exact-tag confirm", () => {
    const rules = loadRules();

    const noAccept = assertPrereleaseMutateAllowed({
      includePrerelease: true,
      acceptPrereleaseSync: false,
      resolvedTag: "train-13",
      confirmTag: "train-13",
      rules,
    });
    expect(noAccept.ok).toBe(false);
    expect(noAccept.reason).toMatch(/--i-accept-prerelease-sync/);
    expect(noAccept.reason).toMatch(/--check/);

    const noConfirm = assertPrereleaseMutateAllowed({
      includePrerelease: true,
      acceptPrereleaseSync: true,
      resolvedTag: "train-13",
      confirmTag: "",
      rules,
    });
    expect(noConfirm.ok).toBe(false);
    expect(noConfirm.reason).toMatch(/CONFIRM=train-13/);

    const wrongConfirm = assertPrereleaseMutateAllowed({
      includePrerelease: true,
      acceptPrereleaseSync: true,
      resolvedTag: "train-13",
      confirmTag: "v0.407.15",
      rules,
    });
    expect(wrongConfirm.ok).toBe(false);
    expect(wrongConfirm.reason).toMatch(/mismatch/);
  });

  it("allows prerelease mutate only with accept flag and exact resolved tag", () => {
    const rules = loadRules();
    const allowed = assertPrereleaseMutateAllowed({
      includePrerelease: true,
      acceptPrereleaseSync: true,
      resolvedTag: "train-13",
      confirmTag: "train-13",
      rules,
    });
    expect(allowed).toEqual({ ok: true });

    // Stable-only mutate path does not require prerelease consent.
    expect(
      assertPrereleaseMutateAllowed({
        includePrerelease: false,
        acceptPrereleaseSync: false,
        resolvedTag: "v0.407.15",
        confirmTag: "",
        rules,
      }),
    ).toEqual({ ok: true });
  });

  it("resolves prerelease confirm tag from CONFIRM or SYNC_UPSTREAM_CONFIRM_TAG", () => {
    expect(resolvePrereleaseConfirmTag({ CONFIRM: "train-13" })).toBe("train-13");
    expect(
      resolvePrereleaseConfirmTag({
        SYNC_UPSTREAM_CONFIRM_TAG: "v0.415.15",
      }),
    ).toBe("v0.415.15");
    expect(
      resolvePrereleaseConfirmTag({
        CONFIRM: "train-13",
        SYNC_UPSTREAM_CONFIRM_TAG: "other",
      }),
    ).toBe("train-13");
    expect(resolvePrereleaseConfirmTag({})).toBe("");
  });

  it("builds a dry-run conflict plan that defaults unknown conflicts to main", () => {
    const plan = buildConflictPlan(["README.md"], {
      conflictRules: {
        defaultResolution: "main",
        dryRunDefault: true,
        divergingFiles: [],
        policies: {},
      },
    });

    expect(plan).toMatchObject({
      kind: "openhanako-fork-conflict-plan",
      dryRun: true,
      defaultResolution: "main",
      conflicts: [{
        file: "README.md",
        strategy: "take-main",
        source: "default",
        plannedAction: "Would accept the origin/main version if a future resolver executes this plan.",
      }],
    });
  });

  it("keeps explicit fork conflict exceptions out of the default main rule", () => {
    const rules = loadRules();

    const plan = buildConflictPlan([
      "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      "package.json",
      "package-lock.json",
      "README.md",
    ], rules);

    expect(plan.defaultResolution).toBe("main");
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        file: "README.md",
        strategy: "take-main",
        source: "default",
      }),
      expect.objectContaining({
        file: "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
        strategy: "preserve-both",
        source: "policy",
      }),
      expect.objectContaining({
        file: "desktop/src/react/services/ws-message-handler.ts",
        strategy: "human-review",
        source: "linked-risk",
        triggeredBy: "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      }),
      expect.objectContaining({
        file: "package-lock.json",
        strategy: "defer-to-stable-production-sync",
        source: "policy",
      }),
      expect.objectContaining({
        file: "package.json",
        strategy: "defer-to-stable-production-sync",
        source: "policy",
      }),
    ]);
  });

  it("links ws-message-handler test conflicts to the production session identity risk", () => {
    const rules = loadRules();

    const plan = buildConflictPlan([
      "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
    ], rules);

    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        file: "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
        strategy: "preserve-both",
        source: "policy",
      }),
      expect.objectContaining({
        file: "desktop/src/react/services/ws-message-handler.ts",
        strategy: "human-review",
        source: "linked-risk",
        risk: "high",
        triggeredBy: "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      }),
    ]);
  });

  it("keeps the resource-url rule explicit about LAN resource transport", () => {
    const rules = loadRules();

    const plan = buildConflictPlan([
      "desktop/src/react/services/resource-url.ts",
    ], rules);

    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        file: "desktop/src/react/services/resource-url.ts",
        strategy: "human-review",
        source: "policy",
        risk: "critical",
        plannedAction: expect.stringContaining("canUseNativeResourcePath"),
      }),
    ]);
    expect(plan.conflicts[0].plannedAction).toContain("sf_*");
    expect(plan.conflicts[0].plannedAction).toContain("LAN device-credential");
    // Must not teach the obsolete kind==='local' transport predicate as the native-path gate.
    expect(plan.conflicts[0].plannedAction).toMatch(/not a bare `kind === 'local'` check/);
  });

  it("parses conflicted files from git merge-tree output", () => {
    const output = [
      "100644 abc 1\tpackage.json",
      "100644 def 2\tpackage.json",
      "100644 ghi 3\tpackage.json",
      "CONFLICT (content): Merge conflict in desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      "Auto-merging server/index.ts",
    ].join("\n");

    expect(parseMergeTreeConflictingFiles(output)).toEqual([
      "desktop/src/react/__tests__/services/ws-message-handler.test.ts",
      "package.json",
    ]);
  });

  it("renders and replaces only the generated PR dashboard block", () => {
    const block = renderPrDashboardBlock({
      generatedAt: "2026-06-20T00:00:00.000Z",
      dryRun: true,
      dashboardBase: {
        upstreamMain: "upstreamsha",
        originMainBefore: "oldmainsha",
        originMainAfter: "newmainsha",
        originMainReplaced: true,
      },
      forkHead: { originDev: "devsha" },
      productionSync: {
        latestStableTag: "v0.331.2",
        lastSyncedTag: "v0.323.0",
        stableSyncAvailable: true,
      },
      pr: {
        number: 1,
        url: "https://github.com/karlorz/openhanako/pull/1",
        mergeable: "CONFLICTING",
      },
      conflicts: [{
        file: "package.json",
        strategy: "defer-to-stable-production-sync",
        source: "policy",
        risk: "medium",
        plannedAction: "Report only. Stable production fork sync owns the package version update.",
      }],
      upstreamSignals: {
        latestCommits: ["abc fix: one"],
        riskyFilesTouched: ["package.json"],
      },
    });

    expect(block).toContain("<!-- openhanako-conflict-dashboard:start -->");
    expect(block).toContain("Permanent draft dashboard. Never merge.");
    expect(block).toContain("package.json");

    const original = [
      "# Human notes",
      "keep this",
      "<!-- openhanako-conflict-dashboard:start -->",
      "old generated text",
      "<!-- openhanako-conflict-dashboard:end -->",
      "tail note",
    ].join("\n");

    const next = buildPrBodyWithDashboard(original, block);

    expect(next).toContain("# Human notes");
    expect(next).toContain("tail note");
    expect(next).not.toContain("old generated text");
    expect(next).toContain("package.json");
  });
});
