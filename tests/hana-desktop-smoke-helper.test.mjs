import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as smokeHelper from "../scripts/hana-desktop-smoke-helper.mjs";

const {
  buildConnectionFromProbe,
  buildSmokeReport,
  connectionVerificationPassed,
  createRestoredConnectionState,
  extractPersistedConnectionStates,
  normalizeBaseUrl,
  sanitizeSmokeIdentity,
  smokeExitCode,
  summarizePersistedConnectionState,
  evaluateContractRequirements,
  parseContractRequirement,
  parseArgs,
  writeRedactedAssessmentEvidence,
} = smokeHelper;

const savedConnection = {
  connectionId: "lan:server_a:studio_b",
  kind: "lan",
  serverId: "server_a",
  serverNodeId: "server_a",
  userId: "user_a",
  studioId: "studio_b",
  label: "Personal Studio",
  baseUrl: "http://100.125.173.118:14500",
  wsUrl: "ws://100.125.173.118:14500",
  token: "hana_dev_secret",
  authState: "paired",
  trustState: "lan",
  credentialKind: "device_credential",
  capabilities: ["chat", "resources"],
};

describe("hana desktop smoke helper", () => {
  it.each(["chat.core@1", "input.drafts@1", "websocket.ticket@1"])("parses supported contract requirement %s", (value) => {
    expect(parseContractRequirement(value)).toEqual({ contract: value.split("@")[0], minVersion: 1 });
  });

  it.each(["Chat.core@1", "chat-core@1", "chat.core@0", "chat.core@1.1", "chat.core", "chat.core@1@2", "future.contract@01"])("rejects invalid contract requirement %s", (value) => {
    expect(() => parseContractRequirement(value)).toThrow();
  });

  it("parses repeatable contract flags and rejects unknown CLI flags", () => {
    expect(parseArgs([
      "--require-contract", "chat.core@1",
      "--require-contract", "input.drafts@2",
    ]).contractRequirements).toEqual([
      { contract: "chat.core", minVersion: 1 },
      { contract: "input.drafts", minVersion: 2 },
    ]);
    expect(() => parseArgs(["--not-a-real-flag"])).toThrow("unknown flag: --not-a-real-flag");
  });

  it("evaluates declared, legacy, and deployment-coupled contract evidence without using freshness", () => {
    const requirements = [
      { contract: "chat.core", minVersion: 1 },
      { contract: "input.drafts", minVersion: 1 },
      { contract: "websocket.ticket", minVersion: 1 },
    ];
    const declared = evaluateContractRequirements({
      functional: { verification: { identity: { featureContracts: { schemaVersion: 1, complete: true, entries: { "chat.core": 1, "input.drafts": 1, "websocket.ticket": 1 } } } } },
      environment: { assessment: { freshness: { status: "current" } } },
    }, requirements);
    expect(declared.status).toBe("pass");
    expect(declared.requirements.every((item) => item.status === "satisfied")).toBe(true);

    const legacy = evaluateContractRequirements({
      functional: { verification: { identity: { featureContracts: { schemaVersion: 1, complete: false, entries: { "chat.core": 1 } } } } },
      environment: { assessment: { freshness: { status: "current" } } },
    }, requirements);
    expect(legacy.status).toBe("fail");
    expect(legacy.requirements.find((item) => item.contract === "chat.core").status).toBe("unconfirmed");

    const untrustedUpgradeEvidence = evaluateContractRequirements({
      functional: { verification: { identity: { featureContracts: null } } },
      environment: { assessment: { features: { items: [{ contract: "input.drafts", status: "unknown", upgradeEvidence: { targetTag: "v0.1.0-karlorz.1", targetContractVersion: 1, manifestGitSha: "abc" } }] }, freshness: { status: "current" } } },
    }, [{ contract: "input.drafts", minVersion: 1 }]);
    expect(untrustedUpgradeEvidence.status).toBe("fail");
    expect(untrustedUpgradeEvidence.requirements[0]).toMatchObject({ status: "unconfirmed", targetTag: null });
  });

  it("requires a valid future manifest identity instead of arbitrary upgrade metadata", () => {
    const requirement = [{ contract: "input.drafts", minVersion: 1 }];
    const legacy = { functional: { verification: { identity: { featureContracts: null } } } };
    const currentTarget = evaluateContractRequirements({
      ...legacy,
      environment: { assessment: {
        manifest: { status: "valid", targetTag: "v0.357.17-karlorz.1", manifestGitSha: "0123456789abcdef0123456789abcdef01234567", featureContracts: { schemaVersion: 1, complete: true, entries: { "input.drafts": 1 } } },
        freshness: { status: "current", recommendedReleaseTag: "v0.357.17-karlorz.1" },
      } },
    }, requirement);
    const malformedTarget = evaluateContractRequirements({
      ...legacy,
      environment: { assessment: {
        manifest: { status: "valid", targetTag: "v0.357.17-karlorz.1", featureContracts: { schemaVersion: 1, complete: true, entries: { "input.drafts": 1 } } },
        freshness: { status: "update-recommended", recommendedReleaseTag: "v0.357.17-karlorz.1" },
      } },
    }, requirement);

    expect(currentTarget.requirements[0]).toMatchObject({ status: "unconfirmed", reasonCode: "legacy_contract_unconfirmed" });
    expect(malformedTarget.requirements[0]).toMatchObject({ status: "unconfirmed", reasonCode: "legacy_contract_unconfirmed" });
  });

  it("reports lower and absent versions in complete declarations as missing", () => {
    const result = evaluateContractRequirements({
      functional: { verification: { identity: { featureContracts: { schemaVersion: 1, complete: true, entries: { "chat.core": 1 } } } } },
    }, [{ contract: "chat.core", minVersion: 2 }, { contract: "input.drafts", minVersion: 1 }]);
    expect(result).toEqual({
      status: "fail",
      requirements: [
        { contract: "chat.core", minVersion: 2, status: "missing", reportedVersion: 1, reasonCode: "contract_version_too_low", targetTag: null },
        { contract: "input.drafts", minVersion: 1, status: "missing", reportedVersion: null, reasonCode: "contract_declaration_missing", targetTag: null },
      ],
    });
  });

  it("marks a valid future release manifest as deployment-coupled for the built report", () => {
    const report = buildSmokeReport({
      verification: {
        ok: true,
        hasToken: true,
        identityOk: true,
        wsOk: true,
        identity: sanitizeSmokeIdentity({
          runtimeBuild: { runtimeVersion: "0.346.18", releaseTag: "v0.346.18-karlorz.1" },
          featureContracts: { schemaVersion: 1, complete: false, entries: {} },
        }),
      },
      releaseCheck: {
        status: "ready",
        release: {
          tag: "v0.357.17-karlorz.1",
          runtimeVersion: "0.357.17",
          manifestStatus: "valid",
          featureContracts: { schemaVersion: 1, complete: true, entries: { "chat.core": 1 } },
          manifestGitSha: "0123456789abcdef0123456789abcdef01234567",
        },
      },
      requirements: [{ contract: "chat.core", minVersion: 1 }],
    });
    expect(report.prerequisites).toMatchObject({
      status: "deployment-coupled",
      requirements: [{ status: "deployment-coupled", targetTag: "v0.357.17-karlorz.1" }],
    });
  });

  it("uses exit 3 only after functional verification passes", () => {
    expect(smokeExitCode({ ok: true, functional: { status: "pass" }, environment: { status: "attention" }, prerequisites: { status: "not-requested" } })).toBe(0);
    expect(smokeExitCode({ ok: true, functional: { status: "pass" }, prerequisites: { status: "pass" } })).toBe(0);
    expect(smokeExitCode({ ok: true, functional: { status: "pass" }, prerequisites: { status: "fail" } })).toBe(3);
    expect(smokeExitCode({ ok: true, functional: { status: "pass" }, prerequisites: { status: "deployment-coupled" } })).toBe(3);
    expect(smokeExitCode({ ok: true, functional: { status: "not-run" }, prerequisites: { status: "fail" } })).toBe(0);
    expect(smokeExitCode({ ok: false, functional: { status: "fail" }, prerequisites: { status: "fail" } })).toBe(1);
  });

  it("writes a redacted, expiring evidence envelope atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-smoke-") );
    const output = path.join(dir, "nested", "evidence.json");
    const report = { ok: true, functional: { status: "pass", verification: { baseUrl: "https://secret.test", hasToken: true, identity: { runtimeBuild: { sourceRepository: "https://secret.test/repo" }, capabilities: ["chat", "Bearer real-secret"] }, diagnostic: "Authorization: Bearer real-secret" } }, environment: { assessment: { freshness: { status: "current" }, opaque: "credential=real-secret", unlabelled: "apiToken=real-secret" } }, reset: { userDataDir: "/Users/me/Library/Application Support/Hanako", wsUrl: "ws://secret.test" } };
    const envelope = writeRedactedAssessmentEvidence(output, report, { now: () => new Date("2026-07-18T12:00:00.000Z") });
    expect(envelope).toMatchObject({ schemaVersion: 1, generatedAt: "2026-07-18T12:00:00.000Z", expiresAt: "2026-07-18T12:30:00.000Z", source: "hana-desktop-smoke-helper" });
    // POSIX: writer requests 0600. Windows ACLs do not map to Unix modes, so
    // only assert the restrictive mask where the platform honors it.
    if (process.platform !== "win32") {
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    } else {
      expect(fs.existsSync(output)).toBe(true);
    }
    const raw = fs.readFileSync(output, "utf8");
    expect(raw).not.toMatch(/https?:|ws:|token|credential|authorization|cookie|headers|cdp|user-data|localStorage|bearer|real-secret/i);
    expect(JSON.parse(raw)).toEqual(expect.objectContaining({ functional: expect.any(Object), environment: expect.any(Object), prerequisites: expect.any(Object) }));
    expect(fs.readdirSync(path.dirname(output)).filter((name) => name.includes(".tmp.")).length).toBe(0);
  });

  it("removes the same-directory temporary evidence file when rename fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-smoke-failure-"));
    const output = path.join(dir, "evidence.json");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed"); });
    try {
      expect(() => writeRedactedAssessmentEvidence(output, { functional: {}, environment: {}, prerequisites: {} })).toThrow("rename failed");
    } finally {
      rename.mockRestore();
    }
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("normalizes sg01 desktop URLs to the base server URL", () => {
    expect(normalizeBaseUrl("100.125.173.118:14500/desktop?x=1#top")).toBe("http://100.125.173.118:14500");
  });

  it.each([
    ["http://[::1]:14500/desktop", "http://[::1]:14500"],
    ["http://100.125.173.118:14500/", "http://100.125.173.118:14500"],
    ["https://hana.example.com/mobile?x=1", "https://hana.example.com"],
    ["hana.example.com", "http://hana.example.com"],
    ["http://100.125.173.118:14500/mobile", "http://100.125.173.118:14500"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it("restores only the selected LAN connection after clearing localStorage", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      serverConnections: {
        [savedConnection.connectionId]: savedConnection,
        "custom:other:studio": {
          ...savedConnection,
          connectionId: "custom:other:studio",
          kind: "custom_remote",
          baseUrl: "https://example.invalid",
        },
      },
      activeServerConnectionId: null,
    });

    const restored = createRestoredConnectionState(raw, {
      baseUrl: "http://100.125.173.118:14500",
    });

    expect(restored.activeServerConnectionId).toBe(savedConnection.connectionId);
    expect(Object.keys(restored.serverConnections)).toEqual([savedConnection.connectionId]);
    expect(restored.serverConnections[savedConnection.connectionId]).toEqual(savedConnection);
  });

  it("builds a device connection from probe identity when no saved connection exists", () => {
    const connection = buildConnectionFromProbe({
      baseUrl: "https://hana.example.com/desktop",
      credential: "desktop_key",
      identity: {
        connectionKind: "custom_remote",
        serverId: "server_remote",
        serverNodeId: "node_remote",
        studioId: "studio_remote",
        label: "Remote Studio",
        authState: "paired",
        trustState: "tunnel",
        capabilities: ["chat"],
      },
    });

    expect(connection).toMatchObject({
      connectionId: "custom_remote:node_remote:studio_remote",
      kind: "custom_remote",
      baseUrl: "https://hana.example.com",
      wsUrl: "wss://hana.example.com",
      token: "desktop_key",
      trustState: "tunnel",
      credentialKind: "device_credential",
    });
  });

  it("summarizes connection state without exposing stored tokens", () => {
    const summary = summarizePersistedConnectionState(JSON.stringify({
      schemaVersion: 1,
      serverConnections: { [savedConnection.connectionId]: savedConnection },
      activeServerConnectionId: savedConnection.connectionId,
    }));

    expect(JSON.stringify(summary)).not.toContain("hana_dev_secret");
    expect(summary).toEqual({
      activeServerConnectionId: savedConnection.connectionId,
      connections: [{
        connectionId: savedConnection.connectionId,
        kind: "lan",
        baseUrl: "http://100.125.173.118:14500",
        wsUrl: "ws://100.125.173.118:14500",
        credentialKind: "device_credential",
        hasToken: true,
      }],
    });
  });

  it("extracts persisted connection states from LevelDB-like text", () => {
    const rawState = JSON.stringify({
      schemaVersion: 1,
      serverConnections: { [savedConnection.connectionId]: savedConnection },
      activeServerConnectionId: savedConnection.connectionId,
    });
    const states = extractPersistedConnectionStates(`prefix ${rawState}\nsuffix`);

    expect(states).toEqual([JSON.parse(rawState)]);
  });

  it("preserves balanced braces when JSON strings contain escaped quotes and braces", () => {
    const trickyConnection = {
      ...savedConnection,
      label: 'Studio "quoted \\\\ \\"escaped\\" }',
    };
    const rawState = JSON.stringify({
      schemaVersion: 1,
      serverConnections: { [trickyConnection.connectionId]: trickyConnection },
      activeServerConnectionId: trickyConnection.connectionId,
    });
    const states = extractPersistedConnectionStates(`junk{partial ${rawState} more}}`);

    expect(states).toHaveLength(1);
    expect(states[0].serverConnections[trickyConnection.connectionId].label).toBe(trickyConnection.label);
  });

  it("requires identity and WebSocket verification to pass", () => {
    expect(connectionVerificationPassed({
      ok: true,
      hasToken: true,
      identityOk: true,
      wsOk: true,
    })).toBe(true);
    expect(connectionVerificationPassed({
      ok: true,
      hasToken: true,
      identityOk: false,
      wsOk: true,
    })).toBe(false);
  });

  it("sanitizes renderer identity evidence without retaining credentials or unknown fields", () => {
    const identity = sanitizeSmokeIdentity({
      connectionKind: "lan",
      version: "0.346.18",
      serverProtocol: 3,
      runtimeBuild: { schemaVersion: 1, runtimeVersion: "0.346.18", releaseTag: null },
      featureContracts: { schemaVersion: 1, complete: false, entries: { "chat.core": 1 } },
      runtimeFacts: { platform: "linux", arch: "arm64" },
      capabilities: ["chat", "resources"],
      executionBoundary: { kind: "remote_process", serverNodeId: "node", studioId: "studio", workbench: { kind: "server_managed" }, token: "nested-secret" },
      token: "secret",
      headers: { Authorization: "Bearer secret" },
      baseUrl: "http://secret.test",
      unknown: true,
    });

    expect(identity).toEqual({
      connectionKind: "lan",
      version: "0.346.18",
      serverProtocol: 3,
      runtimeBuild: { schemaVersion: 1, runtimeVersion: "0.346.18", releaseTag: null },
      featureContracts: { schemaVersion: 1, complete: false, entries: { "chat.core": 1 } },
      runtimeFacts: { platform: "linux", arch: "arm64" },
      capabilities: ["chat", "resources"],
      executionBoundary: { kind: "remote_process", serverNodeId: "node", studioId: "studio", workbench: { kind: "server_managed" } },
    });
    expect(JSON.stringify(identity)).not.toMatch(/secret|token|authorization|headers|baseUrl/i);
  });

  it("reports functional pass separately from an outdated environment", () => {
    const report = buildSmokeReport({
      verification: {
        ok: true,
        baseUrl: "http://100.125.173.118:14500",
        hasToken: true,
        identityStatus: 200,
        identityOk: true,
        identityError: null,
        identity: sanitizeSmokeIdentity({ connectionKind: "lan", version: "0.346.18", capabilities: ["chat"] }),
        wsOk: true,
      },
      releaseCheck: {
        status: "ready",
        checkedAt: "2026-07-18T12:00:00.000Z",
        source: "online",
        stale: false,
        errorCode: null,
        reasonCodes: [],
        release: {
          tag: "v0.357.17-karlorz.1",
          runtimeVersion: "0.357.17",
          forkRevision: 1,
          prerelease: true,
          publishedAt: null,
          releaseUrl: null,
          assets: [],
          compatibilityManifestName: null,
          featureContracts: null,
          manifestGitSha: null,
          reasonCodes: [],
        },
      },
      assessedAt: "2026-07-18T12:00:01.000Z",
    });

    expect(report).toMatchObject({
      schemaVersion: 2,
      ok: true,
      functional: { status: "pass" },
      environment: {
        status: "attention",
        assessment: {
          core: { status: "ready" },
          freshness: { status: "update-recommended" },
        },
      },
    });
  });

  it("keeps release lookup failure non-fatal but functional failure fatal", () => {
    const verification = {
      ok: true,
      hasToken: true,
      identityStatus: 200,
      identityOk: true,
      identityError: null,
      identity: sanitizeSmokeIdentity({ connectionKind: "lan", version: "0.346.18", capabilities: ["chat"] }),
      wsOk: true,
    };
    const unavailable = buildSmokeReport({
      verification,
      releaseCheck: { status: "unavailable", checkedAt: "2026-07-18T12:00:00.000Z", source: "none", stale: false, release: null, errorCode: "offline", reasonCodes: ["offline"] },
    });
    expect(unavailable).toMatchObject({ ok: true, functional: { status: "pass" }, environment: { status: "unknown" } });

    const failed = buildSmokeReport({ verification: { ...verification, identityOk: false, wsOk: false } });
    expect(failed).toMatchObject({ ok: false, functional: { status: "fail" } });
  });

  it("never places supplied tokens in smoke report JSON or errors", () => {
    const report = buildSmokeReport({
      verification: {
        ok: true,
        baseUrl: "http://server.test",
        hasToken: true,
        identityStatus: 200,
        identityOk: true,
        identityError: "request failed",
        identity: sanitizeSmokeIdentity({ version: "0.346.18", token: "hana_dev_secret" }),
        wsOk: true,
      },
      reset: summarizePersistedConnectionState(JSON.stringify({
        schemaVersion: 1,
        serverConnections: { [savedConnection.connectionId]: savedConnection },
        activeServerConnectionId: savedConnection.connectionId,
      })),
    });
    expect(JSON.stringify(report)).not.toContain("hana_dev_secret");
  });

  it("keeps the Phase 1 LAN query-token WebSocket verification path", () => {
    const expression = smokeHelper.rendererVerificationExpression();
    expect(expression).toContain("connection.wsUrl + '/ws?token=' + encodeURIComponent(connection.token)");
    expect(expression).not.toContain("require-contract");
  });

  it("retries renderer connection verification while the reloaded app settles", async () => {
    expect(smokeHelper.waitForRendererConnectionVerification).toBeTypeOf("function");

    const attempts = [];
    const retryDelays = [];
    const result = await smokeHelper.waitForRendererConnectionVerification({ timeoutMs: 5000 }, {
      retryDelayMs: 25,
      delayFn: async (ms) => {
        retryDelays.push(ms);
      },
      verify: async () => {
        attempts.push(Date.now());
        return attempts.length === 1
          ? {
              ok: true,
              hasToken: true,
              identityOk: false,
              identityError: "Failed to fetch",
              wsOk: false,
            }
          : {
              ok: true,
              hasToken: true,
              identityOk: true,
              identityError: null,
              wsOk: true,
            };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      hasToken: true,
      identityOk: true,
      wsOk: true,
    });
    expect(attempts).toHaveLength(2);
    expect(retryDelays).toEqual([25]);
  });

  it("times out CDP commands and removes message listeners", async () => {
    expect(smokeHelper.cdpCommand).toBeTypeOf("function");

    vi.useFakeTimers();
    try {
      const messageListeners = new Set();
      const sentPayloads = [];
      const ws = {
        on(event, listener) {
          expect(event).toBe("message");
          messageListeners.add(listener);
        },
        off(event, listener) {
          expect(event).toBe("message");
          messageListeners.delete(listener);
        },
        send(payload, callback) {
          sentPayloads.push(JSON.parse(payload));
          callback();
        },
      };

      const command = smokeHelper.cdpCommand(ws, "Runtime.evaluate", {}, { timeoutMs: 25 });
      const rejection = expect(command).rejects.toThrow("CDP Runtime.evaluate timed out after 25ms");
      await vi.advanceTimersByTimeAsync(25);
      await rejection;

      expect(sentPayloads).toHaveLength(1);
      expect(messageListeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
