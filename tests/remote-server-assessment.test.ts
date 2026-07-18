import { describe, expect, it } from "vitest";
import assessmentModule from "../shared/remote-server-assessment.cjs";
import type { RemoteBoundaryEvidence } from "../shared/remote-server-assessment.cjs";
import type { RemoteServerReleaseCheck } from "../shared/remote-server-release-catalog.cjs";

const {
  applyRemoteFeatureObservation,
  assessRemoteServer,
  compareCanonicalRuntimeVersions,
  parseCanonicalRuntimeVersion,
} = assessmentModule;

const boundaryReady: RemoteBoundaryEvidence = {
  status: "assessed",
  ok: true,
  reasonCodes: [],
  warningCodes: [],
};

function releaseCheck(overrides: Partial<RemoteServerReleaseCheck> = {}): RemoteServerReleaseCheck {
  const base: RemoteServerReleaseCheck = {
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
      prerelease: false,
      publishedAt: "2026-07-18T12:00:00.000Z",
      releaseUrl: "https://github.com/karlorz/openhanako/releases/tag/v0.357.17-karlorz.1",
      assets: [{
        platform: "linux",
        arch: "arm64",
        name: "hanaagent-server-v0.357.17-karlorz.1-linux-arm64.tar.gz",
        url: "https://example.test/hanaagent-server-v0.357.17-karlorz.1-linux-arm64.tar.gz",
        checksumName: "hanaagent-server-v0.357.17-karlorz.1-linux-arm64.tar.gz.sha256",
        checksumUrl: "https://example.test/hanaagent-server-v0.357.17-karlorz.1-linux-arm64.tar.gz.sha256",
      }],
      compatibilityManifestName: null,
      featureContracts: null,
      manifestGitSha: null,
      manifestStatus: "missing",
      manifestErrorCode: null,
      reasonCodes: ["release_publication_policy_drift"],
    },
  };
  return { ...base, ...overrides };
}

describe("remote server assessment", () => {
  it("parses and compares only canonical runtime versions", () => {
    expect(parseCanonicalRuntimeVersion("0.407.15")).toEqual([0, 407, 15]);
    expect(parseCanonicalRuntimeVersion("v0.407.15")).toEqual([0, 407, 15]);
    expect(parseCanonicalRuntimeVersion("0.407")).toBeNull();
    expect(parseCanonicalRuntimeVersion("0.407.15-karlorz.1")).toBeNull();
    expect(compareCanonicalRuntimeVersions("0.407.15", "0.357.17")).toBeGreaterThan(0);
    expect(compareCanonicalRuntimeVersions("invalid", "0.357.17")).toBeNull();
  });

  it("reports the screenshot case as core ready with update attention", () => {
    const result = assessRemoteServer({
      connectionId: "lan:sg01:default",
      assessedAt: "2026-07-18T12:00:01.000Z",
      boundary: boundaryReady,
      client: { runtimeVersion: "0.407.15", serverProtocol: 8 },
      server: {
        connectionKind: "lan",
        runtimeVersion: "0.346.18",
        serverProtocol: null,
        runtimeBuild: null,
        featureContracts: null,
        runtimeFacts: null,
      },
      releaseCheck: releaseCheck(),
      featureRequirements: [{
        id: "input-drafts",
        contract: "input.drafts",
        minVersion: 1,
        unknownPolicy: "fallback",
        fallback: "memory-only",
      }],
    });

    expect(result.summary).toBe("attention");
    expect(result.core.status).toBe("ready");
    expect(result.transport.status).toBe("legacy-query-token");
    expect(result.features.summary).toBe("legacy");
    expect(result.features.items[0]).toMatchObject({
      status: "unknown",
      fallback: "memory-only",
      upgradeEvidence: null,
    });
    expect(result.freshness).toMatchObject({
      status: "update-recommended",
      runtimeVersion: "0.346.18",
      recommendedRuntimeVersion: "0.357.17",
      recommendedReleaseTag: "v0.357.17-karlorz.1",
      exactReleaseMatch: false,
    });
    expect(result.deployability.status).toBe("release-only");
    expect(JSON.stringify(result)).not.toContain("0.407.15-karlorz");
  });

  it("does not call equal base versions current without an installed release tag", () => {
    const result = assessRemoteServer({
      connectionId: "lan:a:default",
      boundary: boundaryReady,
      server: { runtimeVersion: "0.407.15", runtimeBuild: null, featureContracts: null },
      releaseCheck: releaseCheck({
        release: {
          ...releaseCheck().release!,
          tag: "v0.407.15-karlorz.6",
          runtimeVersion: "0.407.15",
          forkRevision: 6,
        },
      }),
    });
    expect(result.freshness).toMatchObject({
      status: "unknown",
      baseVersionMatch: true,
      exactReleaseMatch: false,
      reasonCodes: expect.arrayContaining(["server_release_identity_missing"]),
    });
  });

  it("detects same-base fork patch updates and exact current releases", () => {
    const candidate = releaseCheck({
      release: {
        ...releaseCheck().release!,
        tag: "v0.346.18-karlorz.6",
        runtimeVersion: "0.346.18",
        forkRevision: 6,
      },
    });
    const older = assessRemoteServer({
      connectionId: "lan:a:default",
      boundary: boundaryReady,
      server: {
        connectionKind: "lan",
        runtimeVersion: "0.346.18",
        runtimeBuild: { releaseTag: "v0.346.18-karlorz.1" },
        featureContracts: null,
      },
      releaseCheck: candidate,
    });
    const exact = assessRemoteServer({
      connectionId: "lan:a:default",
      boundary: boundaryReady,
      server: {
        connectionKind: "lan",
        runtimeVersion: "0.346.18",
        runtimeBuild: { releaseTag: "v0.346.18-karlorz.6" },
        featureContracts: null,
      },
      releaseCheck: candidate,
    });
    expect(older.freshness.status).toBe("update-recommended");
    expect(exact.freshness).toMatchObject({ status: "current", exactReleaseMatch: true });
  });

  it("keeps LAN core ready when websocket ticket evidence is absent", () => {
    const result = assessRemoteServer({
      connectionId: "lan:a:default",
      boundary: boundaryReady,
      server: {
        connectionKind: "lan",
        runtimeVersion: "0.346.18",
        featureContracts: null,
      },
    });
    expect(result.core.status).toBe("ready");
    expect(result.transport).toMatchObject({
      status: "legacy-query-token",
      reportedTicketContractVersion: null,
    });
  });

  it("leaves installer core evidence not assessed", () => {
    const result = assessRemoteServer({
      connectionId: "host:local",
      boundary: null,
      server: {
        runtimeVersion: "0.346.18",
        runtimeBuild: { releaseTag: "v0.346.18-karlorz.1" },
        runtimeFacts: { platform: "linux", arch: "arm64" },
      },
      releaseCheck: releaseCheck(),
      evidenceSource: "installer",
    });
    expect(result.core.status).toBe("not-assessed");
    expect(result.deployability.status).toBe("eligible");
  });

  it("blocks only when a recognized complete declaration explicitly lacks core chat", () => {
    const result = assessRemoteServer({
      connectionId: "lan:a:default",
      boundary: boundaryReady,
      server: {
        connectionKind: "lan",
        runtimeVersion: "0.407.15",
        featureContracts: {
          schemaVersion: 1,
          complete: true,
          entries: { "input.drafts": 1, "websocket.ticket": 1 },
        },
      },
      coreRequirement: { contract: "chat.core", minVersion: 1 },
    });
    expect(result.core).toMatchObject({
      status: "blocked",
      reasonCodes: expect.arrayContaining(["required_core_contract_missing"]),
    });
  });

  it("uses complete declarations for supported and unavailable feature states", () => {
    const result = assessRemoteServer({
      connectionId: "lan:a:default",
      boundary: boundaryReady,
      server: {
        connectionKind: "lan",
        featureContracts: {
          schemaVersion: 1,
          complete: true,
          entries: { "chat.core": 1, "input.drafts": 1 },
        },
      },
      featureRequirements: [
        { id: "input-drafts", contract: "input.drafts", minVersion: 1, unknownPolicy: "fallback", fallback: "memory-only" },
        { id: "future-feature", contract: "future.feature", minVersion: 1, unknownPolicy: "disable", fallback: null },
      ],
    });
    expect(result.features.summary).toBe("limited");
    expect(result.features.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "input-drafts", status: "supported", reportedVersion: 1 }),
      expect.objectContaining({ id: "future-feature", status: "unavailable", reasonCode: "feature_contract_missing" }),
    ]));
  });

  it("attaches verified target support only as feature-specific upgrade evidence", () => {
    const target = releaseCheck();
    target.release = {
      ...target.release!,
      featureContracts: {
        schemaVersion: 1,
        complete: true,
        entries: { "chat.core": 1, "input.drafts": 1, "websocket.ticket": 1 },
      },
      manifestGitSha: "0123456789abcdef0123456789abcdef01234567",
      manifestStatus: "valid",
      manifestErrorCode: null,
    };
    const result = assessRemoteServer({
      connectionId: "lan:legacy:default",
      boundary: boundaryReady,
      server: { connectionKind: "lan", runtimeVersion: "0.346.18", featureContracts: null },
      releaseCheck: target,
      featureRequirements: [{
        id: "input-drafts",
        contract: "input.drafts",
        minVersion: 1,
        unknownPolicy: "fallback",
        fallback: "memory-only",
      }],
    });

    expect(result.features.items[0]).toMatchObject({
      status: "unknown",
      fallback: "memory-only",
      upgradeEvidence: {
        targetTag: "v0.357.17-karlorz.1",
        targetContractVersion: 1,
        manifestGitSha: "0123456789abcdef0123456789abcdef01234567",
      },
    });
  });

  it("applies a definitive feature observation without changing core state", () => {
    const initial = assessRemoteServer({
      connectionId: "lan:a:default",
      boundary: boundaryReady,
      server: { connectionKind: "lan", featureContracts: null },
      featureRequirements: [
        { id: "input-drafts", contract: "input.drafts", minVersion: 1, unknownPolicy: "fallback", fallback: "memory-only" },
      ],
    });
    const observed = applyRemoteFeatureObservation(initial, {
      featureId: "input-drafts",
      status: "unavailable",
      reasonCode: "feature_route_missing",
    });
    expect(observed.core).toEqual(initial.core);
    expect(observed.features).toMatchObject({
      summary: "limited",
      items: [expect.objectContaining({
        id: "input-drafts",
        status: "unavailable",
        evidenceSource: "probe",
        reasonCode: "feature_route_missing",
      })],
    });
  });
});
