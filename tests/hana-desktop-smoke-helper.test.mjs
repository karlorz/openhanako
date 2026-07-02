import { describe, expect, it, vi } from "vitest";

import * as smokeHelper from "../scripts/hana-desktop-smoke-helper.mjs";

const {
  buildConnectionFromProbe,
  connectionVerificationPassed,
  createRestoredConnectionState,
  extractPersistedConnectionStates,
  normalizeBaseUrl,
  summarizePersistedConnectionState,
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
