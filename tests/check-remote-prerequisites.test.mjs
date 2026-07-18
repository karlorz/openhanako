import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  evaluateRemotePrerequisites,
  readAssessmentEvidence,
  readWorkItemRemoteRequirements,
} from "../scripts/check-remote-prerequisites.mjs";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const validWorkItem = `---\nremote_requirements:\n  core: chat.core@1\n  features:\n    - input.drafts@1\n  deployment_coupled: true\n---\n# Work item\n`;

function tempFiles(workItem = validWorkItem, assessment = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-prereq-"));
  const workPath = path.join(dir, "work.md");
  const assessmentPath = path.join(dir, "assessment.json");
  fs.writeFileSync(workPath, workItem);
  if (assessment !== null) fs.writeFileSync(assessmentPath, typeof assessment === "string" ? assessment : JSON.stringify(assessment));
  return { dir, workPath, assessmentPath };
}

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-18T23:45:00.000Z",
    expiresAt: "2026-07-19T00:15:00.000Z",
    source: "hana-desktop-smoke-helper",
    functional: { status: "pass" },
    environment: { status: "ready", assessment: { summary: "ready", freshness: { status: "current" }, deployability: { status: "eligible" } } },
    prerequisites: {
      status: "pass",
      requirements: [
        { contract: "chat.core", minVersion: 1, status: "satisfied", reportedVersion: 1, reasonCode: null, targetTag: null },
        { contract: "input.drafts", minVersion: 1, status: "satisfied", reportedVersion: 1, reasonCode: null, targetTag: null },
      ],
    },
    ...overrides,
  };
}

describe("remote prerequisite work-item parser", () => {
  it("parses the exact remote_requirements frontmatter shape", () => {
    const { workPath } = tempFiles();
    expect(readWorkItemRemoteRequirements(workPath)).toEqual({ core: "chat.core@1", features: ["input.drafts@1"], deploymentCoupled: true });
  });

  it.each([
    ["missing closing delimiter", "---\nremote_requirements:\n  core: chat.core@1\n"],
    ["malformed yaml", "---\nremote_requirements: [\n---\n"],
    ["non-array features", validWorkItem.replace("features:\n    - input.drafts@1", "features: input.drafts@1")],
    ["non-boolean deployment flag", validWorkItem.replace("deployment_coupled: true", "deployment_coupled: yes")],
    ["invalid contract", validWorkItem.replace("chat.core@1", "Chat.core@1")],
    ["duplicate feature", validWorkItem.replace("    - input.drafts@1", "    - input.drafts@1\n    - input.drafts@1")],
    ["duplicate core and feature", validWorkItem.replace("    - input.drafts@1", "    - chat.core@1\n    - input.drafts@1")],
    ["duplicate YAML field", validWorkItem.replace("  features:\n", "  core: chat.core@1\n  features:\n")],
  ])("rejects %s", (_name, workItem) => {
    const { workPath } = tempFiles(workItem);
    expect(() => readWorkItemRemoteRequirements(workPath)).toThrow();
  });

  it("returns not-required requirements when the frontmatter has no remote_requirements", () => {
    const { workPath } = tempFiles("---\ntitle: local-only\n---\n");
    expect(readWorkItemRemoteRequirements(workPath)).toEqual({ core: null, features: [], deploymentCoupled: false });
  });
});

describe("assessment evidence freshness", () => {
  it("reads valid evidence and derives the 30-minute expiry", () => {
    const { assessmentPath } = tempFiles(validWorkItem, evidence());
    expect(readAssessmentEvidence(assessmentPath, NOW)).toMatchObject({ generatedAt: "2026-07-18T23:45:00.000Z", expiresAt: "2026-07-19T00:15:00.000Z", freshness: "fresh" });
  });

  it("classifies missing, malformed, expired, and future evidence", () => {
    const missing = tempFiles();
    expect(readAssessmentEvidence(missing.assessmentPath, NOW)).toMatchObject({ freshness: "missing" });
    const invalid = tempFiles(validWorkItem, "not-json");
    expect(readAssessmentEvidence(invalid.assessmentPath, NOW)).toMatchObject({ freshness: "invalid" });
    const stale = tempFiles(validWorkItem, { ...evidence(), generatedAt: "2026-07-18T23:29:59.000Z", expiresAt: "2026-07-18T23:59:59.000Z" });
    expect(readAssessmentEvidence(stale.assessmentPath, NOW)).toMatchObject({ freshness: "stale" });
    const future = tempFiles(validWorkItem, { ...evidence(), generatedAt: "2026-07-19T00:06:00.000Z", expiresAt: "2026-07-19T00:36:00.000Z" });
    expect(readAssessmentEvidence(future.assessmentPath, NOW)).toMatchObject({ freshness: "invalid" });
  });

  it.each([
    ["missing source", (value) => { delete value.source; }],
    ["invalid functional status", (value) => { value.functional.status = "maybe"; }],
    ["invalid environment status", (value) => { value.environment.status = "maybe"; }],
    ["missing environment assessment", (value) => { delete value.environment.assessment; }],
    ["invalid prerequisites status", (value) => { value.prerequisites.status = "maybe"; }],
    ["malformed prerequisites requirements", (value) => { value.prerequisites.requirements = {}; }],
    ["malformed current feature declaration", (value) => { value.functional.verification = { identity: { featureContracts: { schemaVersion: 1, complete: true, entries: [] } } }; }],
    ["non-ISO generated timestamp", (value) => { value.generatedAt = "2026-07-18"; value.expiresAt = "2026-07-18T00:30:00.000Z"; }],
    ["non-ISO expiry timestamp", (value) => { value.expiresAt = "2026-07-19 00:15:00"; }],
  ])("rejects %s as assessment-invalid instead of fresh", (_name, mutate) => {
    const value = evidence();
    mutate(value);
    const { assessmentPath } = tempFiles(validWorkItem, value);
    expect(readAssessmentEvidence(assessmentPath, NOW)).toMatchObject({ freshness: "invalid", reasonCode: expect.stringMatching(/^assessment_invalid/) });
  });
});

describe("remote prerequisite states", () => {
  it("maps required state precedence and exit classes", () => {
    const requirements = { core: "chat.core@1", features: ["input.drafts@1"], deploymentCoupled: true };
    expect(evaluateRemotePrerequisites({ core: null, features: [], deploymentCoupled: false }, { freshness: "missing" }).status).toBe("not-required");
    expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value: { functional: { status: "fail" } } }).status).toBe("blocked");
    expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value: evidence({ environment: { status: "attention", assessment: { summary: "attention", freshness: { status: "current" }, deployability: { status: "eligible" } } } }) }).status).toBe("verified-with-attention");
    const future = evidence({
      environment: { status: "attention", assessment: {
        summary: "attention",
        freshness: { status: "update-recommended", recommendedReleaseTag: "v0.1.0-karlorz.1" },
        deployability: { status: "eligible" },
        manifest: { status: "valid", targetTag: "v0.1.0-karlorz.1", manifestGitSha: "a".repeat(40), featureContracts: { schemaVersion: 1, complete: true, entries: { "chat.core": 1 } } },
      } },
      prerequisites: { status: "deployment-coupled", requirements: [{ contract: "chat.core", status: "deployment-coupled", targetTag: "v0.1.0-karlorz.1" }, { contract: "input.drafts", status: "satisfied", targetTag: null }] },
    });
    expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value: future }).status).toBe("deployment-coupled");
    expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value: evidence({ prerequisites: { status: "fail", requirements: [{ contract: "chat.core", status: "missing", targetTag: null }, { contract: "input.drafts", status: "missing", targetTag: null }] } }) }).status).toBe("release-blocked");
    expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value: evidence({ environment: { status: "attention", assessment: { freshness: { status: "update-recommended" }, deployability: { status: "release-only" } } }, prerequisites: { status: "pass", requirements: [{ contract: "chat.core", status: "satisfied" }, { contract: "input.drafts", status: "satisfied" }] } }) }).status).toBe("deploy-blocked");
    for (const freshness of ["missing", "invalid", "stale"]) {
      expect(evaluateRemotePrerequisites(requirements, { freshness }).status).toBe("unknown");
    }
    expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value: evidence() }).status).toBe("ready");
  });

  it("uses current declarations and accepts future targets only from a validated manifest", () => {
    const requirements = { core: "chat.core@1", features: ["input.drafts@1"], deploymentCoupled: true };
    const declared = evidence({
      functional: { status: "pass", verification: { identity: { featureContracts: { schemaVersion: 1, complete: true, entries: { "chat.core": 1, "input.drafts": 1 } } } } },
      prerequisites: { status: "not-requested", requirements: [] },
    });
    expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value: declared }).status).toBe("ready");

    const untrusted = evidence({ prerequisites: { status: "deployment-coupled", requirements: [
      { contract: "chat.core", status: "deployment-coupled", targetTag: "v0.1.0-karlorz.1" },
      { contract: "input.drafts", status: "satisfied" },
    ] } });
    expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value: untrusted }).status).toBe("release-blocked");
  });

  it("does not let an older prerequisite row override a current declaration omission or lower version", () => {
    const requirements = { core: "chat.core@1", features: ["input.drafts@1"], deploymentCoupled: false };
    for (const entries of [{ "chat.core": 1 }, { "chat.core": 1, "input.drafts": 0 }]) {
      const value = evidence({
        functional: { status: "pass", verification: { identity: { featureContracts: { schemaVersion: 1, complete: true, entries } } } },
        prerequisites: { status: "pass", requirements: [
          { contract: "chat.core", minVersion: 1, status: "satisfied", reportedVersion: 1 },
          { contract: "input.drafts", minVersion: 1, status: "satisfied", reportedVersion: 1 },
        ] },
      });
      expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value }).status).toBe("release-blocked");
      expect(evaluateRemotePrerequisites(requirements, { freshness: "fresh", value }).features[0]).toMatchObject({ status: "missing", reasonCode: "required_contract_missing" });
    }
  });
});

describe("checker CLI boundary", () => {
  it("emits JSON and does not contact a supplied URL or write outside evidence", () => {
    const current = new Date();
    const generatedAt = new Date(current.getTime() - 60_000).toISOString();
    const expiresAt = new Date(current.getTime() + 29 * 60_000).toISOString();
    const { workPath, assessmentPath, dir } = tempFiles(validWorkItem, evidence({ generatedAt, expiresAt }));
    const result = spawnSync(process.execPath, ["scripts/check-remote-prerequisites.mjs", "--work-item", workPath, "--assessment", assessmentPath, "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, status: "ready", evidence: { path: assessmentPath } });
    expect(fs.readdirSync(dir).sort()).toEqual(["assessment.json", "work.md"]);
  });
});
