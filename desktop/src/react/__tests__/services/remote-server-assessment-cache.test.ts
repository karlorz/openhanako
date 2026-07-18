import { describe, expect, it } from "vitest";
import { assessRemoteServer, type RemoteServerAssessment } from "../../../../../shared/remote-server-assessment";
import {
  readRemoteServerAssessment,
  removeRemoteServerAssessment,
  sanitizeRemoteServerAssessment,
  writeRemoteServerAssessment,
} from "../../services/remote-server-assessment-cache";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function assessment(connectionId: string, assessedAt = "2026-07-18T12:00:00.000Z"): RemoteServerAssessment {
  return assessRemoteServer({
    connectionId,
    assessedAt,
    boundary: { status: "assessed", ok: true, reasonCodes: [], warningCodes: [] },
    server: { connectionKind: "lan", runtimeVersion: "0.346.18", featureContracts: null },
    featureRequirements: [{
      id: "input-drafts",
      contract: "input.drafts",
      minVersion: 1,
      unknownPolicy: "fallback",
      fallback: "memory-only",
    }],
  });
}

describe("remote server assessment cache", () => {
  it("normalizes only schema-version-1 assessment fields", () => {
    const value = {
      ...assessment("lan:a:default"),
      token: "secret",
      authorization: "Bearer secret",
      credential: "device-key",
      headers: { Authorization: "secret" },
      baseUrl: "http://secret.example",
      unknown: { nested: true },
    };

    const sanitized = sanitizeRemoteServerAssessment(value);

    expect(sanitized).toEqual(assessment("lan:a:default"));
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toMatch(/secret|"(?:token|authorization|credential|headers|baseUrl)"\s*:/i);
  });

  it("returns null for malformed, mismatched, or unsupported stored values", () => {
    const storage = new MemoryStorage();
    storage.setItem("hana-remote-server-assessments-v1", "not-json");
    expect(readRemoteServerAssessment("lan:a:default", { storage })).toBeNull();

    storage.setItem("hana-remote-server-assessments-v1", JSON.stringify({
      schemaVersion: 1,
      byConnectionId: { "lan:a:default": { ...assessment("lan:b:default"), schemaVersion: 1 } },
    }));
    expect(readRemoteServerAssessment("lan:a:default", { storage })).toBeNull();

    expect(sanitizeRemoteServerAssessment({ ...assessment("lan:a:default"), schemaVersion: 2 })).toBeNull();
    expect(sanitizeRemoteServerAssessment([])).toBeNull();
  });

  it("preserves other connection entries while updating and removing one", () => {
    const storage = new MemoryStorage();
    writeRemoteServerAssessment(assessment("lan:a:default"), { storage });
    writeRemoteServerAssessment(assessment("lan:b:default"), { storage });
    removeRemoteServerAssessment("lan:a:default", { storage });

    expect(readRemoteServerAssessment("lan:a:default", { storage })).toBeNull();
    expect(readRemoteServerAssessment("lan:b:default", { storage })?.connectionId).toBe("lan:b:default");
  });

  it("marks an old assessment stale without deleting it", () => {
    const storage = new MemoryStorage();
    writeRemoteServerAssessment(assessment("lan:a:default", "2026-07-18T12:00:00.000Z"), { storage });

    const restored = readRemoteServerAssessment("lan:a:default", {
      storage,
      now: () => Date.parse("2026-07-18T12:10:01.000Z"),
    });

    expect(restored).not.toBeNull();
    expect(restored?.freshness.stale).toBe(true);
    expect(storage.getItem("hana-remote-server-assessments-v1")).not.toBeNull();
  });
});
