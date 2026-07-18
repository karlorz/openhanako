import { describe, expect, it, vi } from "vitest";
import { assessRemoteServer, type RemoteServerAssessment } from "../../../../../shared/remote-server-assessment";
import type { RemoteServerReleaseCheck } from "../../../../../shared/remote-server-release-catalog.cjs";
import type { RemoteBoundaryCompatibility } from "../../services/remote-boundary-contract";
import {
  createRemoteServerAssessmentCoordinator,
  type CoordinatorDependencies,
} from "../../services/remote-server-assessment-coordinator";
import type { ServerConnection, ServerIdentity } from "../../services/server-connection";

function connection(connectionId = "lan:a:default", kind: ServerConnection["kind"] = "lan"): ServerConnection {
  return {
    connectionId,
    kind,
    serverId: "server-a",
    studioId: "default",
    label: "Studio",
    baseUrl: kind === "local" ? "http://127.0.0.1:14500" : "http://server-a.test:14500",
    wsUrl: kind === "local" ? "ws://127.0.0.1:14500" : "ws://server-a.test:14500",
    token: kind === "local" ? "local-token" : "device-token",
    authState: "paired",
    trustState: kind === "local" ? "local" : "lan",
    credentialKind: kind === "local" ? "loopback_token" : "device_credential",
    capabilities: ["chat"],
  };
}

function identity(version = "0.346.18"): ServerIdentity {
  return {
    connectionKind: "lan",
    serverId: "server-a",
    studioId: "default",
    label: "Studio",
    version,
    capabilities: ["chat"],
  };
}

const boundaryReady: RemoteBoundaryCompatibility = { ok: true, reasonCodes: [], warningCodes: [] };

function releaseCheck(): RemoteServerReleaseCheck {
  return {
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
        url: "https://example.test/server.tar.gz",
        checksumName: "hanaagent-server-v0.357.17-karlorz.1-linux-arm64.tar.gz.sha256",
        checksumUrl: "https://example.test/server.tar.gz.sha256",
      }],
      compatibilityManifestName: null,
      featureContracts: null,
      manifestGitSha: null,
      reasonCodes: ["release_publication_policy_drift"],
    },
  };
}

function dependencies(overrides: Partial<CoordinatorDependencies> = {}) {
  let activeConnectionId: string | null = "lan:a:default";
  const applyAssessment = vi.fn<(value: RemoteServerAssessment | null) => void>();
  const persistAssessment = vi.fn<(value: RemoteServerAssessment) => void>();
  const deps: CoordinatorDependencies = {
    getActiveConnectionId: () => activeConnectionId,
    fetchIdentity: vi.fn().mockResolvedValue(identity()),
    loadRelease: vi.fn().mockResolvedValue(releaseCheck()),
    evaluate: assessRemoteServer,
    applyAssessment,
    persistAssessment,
    now: () => new Date("2026-07-18T12:00:01.000Z"),
    ...overrides,
  };
  return {
    deps,
    applyAssessment,
    persistAssessment,
    setActiveConnectionId(value: string | null) { activeConnectionId = value; },
  };
}

describe("remote server assessment coordinator", () => {
  it("applies identity evidence before release loading resolves", async () => {
    let resolveRelease!: (value: RemoteServerReleaseCheck) => void;
    const pendingRelease = new Promise<RemoteServerReleaseCheck>((resolve) => { resolveRelease = resolve; });
    const setup = dependencies({ loadRelease: vi.fn().mockReturnValue(pendingRelease) });
    const coordinator = createRemoteServerAssessmentCoordinator(setup.deps);

    const pending = coordinator.assessConnection(connection(), { initialIdentity: identity(), initialBoundary: boundaryReady });
    expect(setup.applyAssessment).toHaveBeenCalledTimes(1);
    expect(setup.applyAssessment.mock.calls[0][0]).toMatchObject({ core: { status: "ready" }, freshness: { status: "unknown" } });

    resolveRelease(releaseCheck());
    await pending;
    expect(setup.applyAssessment).toHaveBeenCalledTimes(2);
    expect(setup.applyAssessment.mock.calls[1][0]).toMatchObject({ freshness: { status: "update-recommended" } });
  });

  it("discards a late response after the active connection changes", async () => {
    let resolveIdentity!: (value: ServerIdentity) => void;
    const pendingIdentity = new Promise<ServerIdentity>((resolve) => { resolveIdentity = resolve; });
    const setup = dependencies({ fetchIdentity: vi.fn().mockReturnValue(pendingIdentity) });
    const coordinator = createRemoteServerAssessmentCoordinator(setup.deps);
    const pending = coordinator.assessConnection(connection());
    setup.setActiveConnectionId("lan:b:default");
    resolveIdentity(identity());

    await expect(pending).resolves.toBeNull();
    expect(setup.applyAssessment).not.toHaveBeenCalled();
    expect(setup.persistAssessment).not.toHaveBeenCalled();
  });

  it("lets a newer request for the same connection supersede the first", async () => {
    let resolveFirst!: (value: ServerIdentity) => void;
    let resolveSecond!: (value: ServerIdentity) => void;
    const fetchIdentity = vi.fn()
      .mockReturnValueOnce(new Promise<ServerIdentity>((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise<ServerIdentity>((resolve) => { resolveSecond = resolve; }));
    const setup = dependencies({ fetchIdentity });
    const coordinator = createRemoteServerAssessmentCoordinator(setup.deps);
    const first = coordinator.assessConnection(connection());
    const second = coordinator.assessConnection(connection());
    resolveFirst(identity("0.346.18"));
    resolveSecond(identity("0.350.0"));

    await Promise.all([first, second]);
    expect(setup.applyAssessment).toHaveBeenCalled();
    expect(setup.applyAssessment.mock.calls.every(([value]) => value === null || value.build.runtimeVersion === "0.350.0")).toBe(true);
  });

  it("force refreshes both identity and release evidence", async () => {
    const setup = dependencies();
    const coordinator = createRemoteServerAssessmentCoordinator(setup.deps);

    await coordinator.assessConnection(connection(), {
      force: true,
      initialIdentity: identity("0.100.0"),
      initialBoundary: boundaryReady,
    });

    expect(setup.deps.fetchIdentity).toHaveBeenCalledTimes(1);
    expect(setup.deps.loadRelease).toHaveBeenCalledWith({ force: true });
  });

  it("keeps core ready when release loading fails", async () => {
    const setup = dependencies({ loadRelease: vi.fn().mockRejectedValue(new Error("offline")) });
    const coordinator = createRemoteServerAssessmentCoordinator(setup.deps);

    const result = await coordinator.assessConnection(connection(), {
      initialIdentity: identity(),
      initialBoundary: boundaryReady,
    });

    expect(result).toMatchObject({ core: { status: "ready" }, freshness: { status: "unknown" } });
  });

  it("clears local-owner assessment without identity or release calls", async () => {
    const setup = dependencies();
    setup.setActiveConnectionId("local");
    const coordinator = createRemoteServerAssessmentCoordinator(setup.deps);

    await expect(coordinator.assessConnection(connection("local", "local"))).resolves.toBeNull();
    expect(setup.applyAssessment).toHaveBeenCalledWith(null);
    expect(setup.deps.fetchIdentity).not.toHaveBeenCalled();
    expect(setup.deps.loadRelease).not.toHaveBeenCalled();
  });
});
