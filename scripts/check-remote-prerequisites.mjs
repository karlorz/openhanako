#!/usr/bin/env node
import fs from "node:fs";
import yaml from "js-yaml";

const SCHEMA_VERSION = 1;
const EVIDENCE_TTL_MS = 30 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const CONTRACT_RE = /^([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*)@([1-9]\d*)$/;
const CONTRACT_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const FULL_ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FUNCTIONAL_STATUSES = new Set(["not-run", "pass", "fail"]);
const ENVIRONMENT_STATUSES = new Set(["ready", "attention", "unknown"]);
const PREREQUISITE_STATUSES = new Set(["not-requested", "pass", "fail", "deployment-coupled"]);
const REQUIREMENT_STATUSES = new Set(["satisfied", "missing", "unconfirmed", "deployment-coupled"]);
const ASSESSMENT_SUMMARIES = new Set(["not-assessed", "ready", "attention", "blocked"]);
const FRESHNESS_STATUSES = new Set(["unknown", "current", "update-recommended", "ahead-or-custom"]);
const DEPLOYABILITY_STATUSES = new Set(["not-assessed", "unknown", "release-only", "unavailable", "eligible"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseContract(value, label) {
  if (value === null && label === "core") return null;
  if (typeof value !== "string") throw new Error(`${label} must be a NAME@VERSION string`);
  const match = CONTRACT_RE.exec(value);
  if (!match) throw new Error(`invalid ${label} contract: ${value}`);
  return value;
}

function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(normalized)) return null;
  const lines = normalized.split(/\r?\n/);
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      closing = index;
      break;
    }
  }
  if (closing === -1) throw new Error("frontmatter closing delimiter missing");
  const source = lines.slice(1, closing).join("\n");
  try {
    return yaml.load(source);
  } catch (error) {
    throw new Error(`invalid frontmatter YAML: ${error.message}`);
  }
}

export function readWorkItemRemoteRequirements(workItemPath) {
  if (typeof workItemPath !== "string" || !workItemPath) throw new Error("work-item path required");
  const text = fs.readFileSync(workItemPath, "utf8");
  const frontmatter = parseFrontmatter(text);
  if (frontmatter === null) return { core: null, features: [], deploymentCoupled: false };
  if (!record(frontmatter)) throw new Error("frontmatter must be a mapping");
  if (!("remote_requirements" in frontmatter)) return { core: null, features: [], deploymentCoupled: false };
  const raw = frontmatter.remote_requirements;
  if (!record(raw)) throw new Error("remote_requirements must be a mapping");
  const allowed = new Set(["core", "features", "deployment_coupled"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`unknown remote_requirements field: ${key}`);
  const core = parseContract(raw.core ?? null, "core");
  const features = raw.features ?? [];
  if (!Array.isArray(features)) throw new Error("remote_requirements.features must be an array");
  const parsedFeatures = features.map((value) => parseContract(value, "feature"));
  const all = core ? [core, ...parsedFeatures] : parsedFeatures;
  if (new Set(all).size !== all.length) throw new Error("duplicate remote contract requirement");
  if (raw.deployment_coupled !== undefined && typeof raw.deployment_coupled !== "boolean") {
    throw new Error("remote_requirements.deployment_coupled must be boolean");
  }
  return { core, features: parsedFeatures, deploymentCoupled: raw.deployment_coupled ?? false };
}

function parseTimestamp(value, field) {
  if (typeof value !== "string" || !FULL_ISO_TIMESTAMP_RE.test(value)) throw new Error(`${field} must be a full ISO timestamp`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error(`${field} must be a full ISO timestamp`);
  return { value, time };
}

function invalidEvidence(pathname, reasonCode) {
  return { path: pathname, generatedAt: null, expiresAt: null, freshness: "invalid", reasonCode, value: null };
}

export function readAssessmentEvidence(assessmentPath, now = new Date()) {
  if (typeof assessmentPath !== "string" || !assessmentPath) throw new Error("assessment path required");
  const pathname = assessmentPath;
  let raw;
  try {
    raw = fs.readFileSync(pathname, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { path: pathname, generatedAt: null, expiresAt: null, freshness: "missing", reasonCode: "assessment_missing", value: null };
    throw error;
  }
  let value;
  try { value = JSON.parse(raw); } catch { return invalidEvidence(pathname, "assessment_invalid_json"); }
  if (!isAssessmentEnvelope(value)) {
    return invalidEvidence(pathname, "assessment_invalid_schema");
  }
  let generated;
  let expires;
  try {
    generated = parseTimestamp(value.generatedAt, "generatedAt");
    expires = parseTimestamp(value.expiresAt, "expiresAt");
  } catch (error) {
    return invalidEvidence(pathname, "assessment_invalid_timestamp");
  }
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowTime)) throw new Error("now must be a valid date");
  if (generated.time > nowTime + FUTURE_TOLERANCE_MS) return invalidEvidence(pathname, "assessment_generated_in_future");
  if (expires.time !== generated.time + EVIDENCE_TTL_MS) return invalidEvidence(pathname, "assessment_invalid_ttl");
  return {
    path: pathname,
    checkedAt: new Date(nowTime).toISOString(),
    generatedAt: generated.value,
    expiresAt: expires.value,
    freshness: expires.time <= nowTime ? "stale" : "fresh",
    reasonCode: expires.time <= nowTime ? "assessment_stale" : null,
    value,
  };
}

function isAssessmentEnvelope(value) {
  if (!record(value) || value.schemaVersion !== SCHEMA_VERSION || value.source !== "hana-desktop-smoke-helper") return false;
  if (!record(value.functional) || !FUNCTIONAL_STATUSES.has(value.functional.status)) return false;
  if (!record(value.environment) || !ENVIRONMENT_STATUSES.has(value.environment.status) || !record(value.environment.assessment)) return false;
  if (!record(value.prerequisites) || !PREREQUISITE_STATUSES.has(value.prerequisites.status) || !Array.isArray(value.prerequisites.requirements)) return false;
  if (!value.prerequisites.requirements.every(isAssessmentRequirement)) return false;
  if (!validFunctionalShape(value.functional) || !validEnvironmentAssessmentShape(value.environment.assessment)) return false;
  return true;
}

function isAssessmentRequirement(value) {
  if (!record(value) || typeof value.contract !== "string" || !CONTRACT_NAME_RE.test(value.contract)) return false;
  if (!REQUIREMENT_STATUSES.has(value.status)) return false;
  if (value.minVersion !== undefined && (!Number.isSafeInteger(value.minVersion) || value.minVersion < 1)) return false;
  if (value.reportedVersion !== undefined && value.reportedVersion !== null
    && (!Number.isSafeInteger(value.reportedVersion) || value.reportedVersion < 0)) return false;
  if (value.reasonCode !== undefined && value.reasonCode !== null && typeof value.reasonCode !== "string") return false;
  if (value.targetTag !== undefined && value.targetTag !== null && typeof value.targetTag !== "string") return false;
  return true;
}

function validFunctionalShape(functional) {
  if (functional.verification === undefined || functional.verification === null) return true;
  if (!record(functional.verification)) return false;
  const identity = functional.verification.identity;
  if (identity === undefined || identity === null) return true;
  if (!record(identity)) return false;
  return identity.featureContracts === undefined || identity.featureContracts === null
    || isFeatureContractDeclaration(identity.featureContracts);
}

function validEnvironmentAssessmentShape(assessment) {
  if (assessment.summary !== undefined && !ASSESSMENT_SUMMARIES.has(assessment.summary)) return false;
  if (assessment.featureContracts !== undefined && assessment.featureContracts !== null
    && !isFeatureContractDeclaration(assessment.featureContracts)) return false;
  if (assessment.freshness !== undefined) {
    if (!record(assessment.freshness) || !FRESHNESS_STATUSES.has(assessment.freshness.status)) return false;
    if (assessment.freshness.recommendedReleaseTag !== undefined && assessment.freshness.recommendedReleaseTag !== null
      && typeof assessment.freshness.recommendedReleaseTag !== "string") return false;
  }
  if (assessment.deployability !== undefined
    && (!record(assessment.deployability) || !DEPLOYABILITY_STATUSES.has(assessment.deployability.status))) return false;
  if (assessment.manifest !== undefined && assessment.manifest !== null) {
    if (!record(assessment.manifest) || assessment.manifest.status !== "valid") return false;
    if (typeof assessment.manifest.targetTag !== "string" || typeof assessment.manifest.manifestGitSha !== "string") return false;
    if (!isFeatureContractDeclaration(assessment.manifest.featureContracts)) return false;
  }
  return true;
}

function isFeatureContractDeclaration(value) {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.complete !== "boolean" || !record(value.entries)) return false;
  return Object.entries(value.entries).every(([contract, version]) => CONTRACT_NAME_RE.test(contract)
    && Number.isSafeInteger(version) && version >= 0);
}

function contractParts(requirement) {
  const match = CONTRACT_RE.exec(requirement);
  return { contract: match[1], minVersion: Number(match[2]) };
}

function assessmentRequirementMap(value) {
  const map = new Map();
  const declaration = value?.functional?.verification?.identity?.featureContracts
    || value?.environment?.assessment?.featureContracts;
  const hasCurrentDeclaration = record(declaration)
    && declaration.schemaVersion === 1
    && typeof declaration.complete === "boolean"
    && record(declaration.entries);
  if (hasCurrentDeclaration) {
    for (const [contract, reportedVersion] of Object.entries(declaration.entries)) {
      if (Number.isSafeInteger(reportedVersion)) {
        map.set(contract, { status: declaration.complete === true ? "satisfied" : "unconfirmed", reportedVersion });
      }
    }
    return map;
  }
  const items = value?.prerequisites?.requirements;
  if (Array.isArray(items)) {
    for (const item of items) if (record(item) && typeof item.contract === "string") map.set(item.contract, item);
  }
  const nested = value?.environment?.assessment;
  for (const item of (Array.isArray(nested?.features?.items) ? nested.features.items : [])) {
    if (record(item) && typeof item.contract === "string" && !map.has(item.contract)) map.set(item.contract, item);
  }
  return map;
}

function validFutureManifest(value) {
  const manifest = value?.environment?.assessment?.manifest;
  const freshness = value?.environment?.assessment?.freshness;
  if (!record(manifest) || manifest.status !== "valid" || typeof manifest.targetTag !== "string") return null;
  if (!/^[a-f0-9]{40}$/i.test(String(manifest.manifestGitSha || ""))) return null;
  if (!record(freshness) || freshness.status !== "update-recommended" || freshness.recommendedReleaseTag !== manifest.targetTag) return null;
  const declaration = manifest.featureContracts;
  if (!record(declaration) || declaration.schemaVersion !== 1 || declaration.complete !== true || !record(declaration.entries)) return null;
  return manifest;
}

function targetFor(value, contract, minVersion) {
  const manifest = validFutureManifest(value);
  const version = manifest?.featureContracts?.entries?.[contract];
  return Number.isSafeInteger(version) && version >= minVersion ? manifest.targetTag : null;
}

export function evaluateRemotePrerequisites(requirements, evidence) {
  const normalized = requirements || { core: null, features: [], deploymentCoupled: false };
  const required = [normalized.core, ...(normalized.features || [])].filter(Boolean);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: evidence?.checkedAt || new Date().toISOString(),
    status: "unknown",
    reasonCodes: [],
    core: { required: normalized.core || null, status: normalized.core ? "unknown" : "not-required", reasonCode: normalized.core ? "assessment_unknown" : null },
    features: (normalized.features || []).map((item) => ({ required: item, status: "unknown", reasonCode: "assessment_unknown", targetTag: null })),
    evidence: { path: evidence?.path || null, generatedAt: evidence?.generatedAt || null, expiresAt: evidence?.expiresAt || null },
  };
  if (required.length === 0) return { ...base, status: "not-required", reasonCodes: [] };
  if (!evidence || evidence.freshness !== "fresh") return { ...base, status: "unknown", reasonCodes: [evidence?.reasonCode || "assessment_missing"] };
  const value = evidence.value;
  const functionalStatus = value?.functional?.status;
  if (functionalStatus === "fail") return { ...base, status: "blocked", reasonCodes: ["functional_failure"] };
  if (functionalStatus !== "pass") return { ...base, status: "unknown", reasonCodes: ["functional_not_passed"] };
  const map = assessmentRequirementMap(value);
  const contracts = required.map((requirement) => {
    const parts = contractParts(requirement);
    const item = map.get(parts.contract);
    const reportedMeetsRequirement = item?.reportedVersion == null || item.reportedVersion >= parts.minVersion;
    const requestedVersionMeetsRequirement = item?.minVersion == null || item.minVersion >= parts.minVersion;
    const satisfied = (item?.status === "satisfied" || item?.status === "supported" || item?.status === "pass")
      && reportedMeetsRequirement && requestedVersionMeetsRequirement;
    const targetTag = satisfied ? null : targetFor(value, parts.contract, parts.minVersion);
    const deployment = normalized.deploymentCoupled && !satisfied && Boolean(targetTag);
    const status = satisfied ? "satisfied" : deployment ? "deployment-coupled" : "missing";
    return {
      ...parts,
      required: requirement,
      status,
      reasonCode: satisfied ? null : item?.reasonCode || (deployment ? "future_manifest_only" : "required_contract_missing"),
      targetTag: deployment ? targetTag : null,
    };
  });
  base.core = normalized.core ? { required: normalized.core, status: contracts[0].status, reasonCode: contracts[0].reasonCode } : base.core;
  base.features = contracts.slice(normalized.core ? 1 : 0).map((item) => ({ required: item.required, status: item.status, reasonCode: item.reasonCode, targetTag: item.targetTag }));
  const allSatisfied = contracts.every((item) => item.status === "satisfied");
  const anyDeployment = contracts.some((item) => item.status === "deployment-coupled");
  const environment = value?.environment?.assessment;
  const attention = value?.environment?.status === "attention" || environment?.summary === "attention";
  const deployability = environment?.deployability?.status;
  let status = allSatisfied ? (attention ? "verified-with-attention" : "ready") : anyDeployment ? "deployment-coupled" : "release-blocked";
  if (anyDeployment && deployability && deployability !== "eligible") status = "deploy-blocked";
  if (allSatisfied && ["release-only", "unavailable"].includes(deployability)) status = "deploy-blocked";
  const reasonCodes = status === "ready" ? [] : [
    status === "blocked" ? "functional_failure" :
      status === "verified-with-attention" ? "assessment_attention" :
        status === "deployment-coupled" ? "future_manifest_only" :
          status === "deploy-blocked" ? "host_asset_unconfirmed" :
            status === "release-blocked" ? "required_contract_missing" : status,
  ];
  return { ...base, status, reasonCodes };
}

function parseArgs(argv) {
  const options = { json: false, workItem: null, assessment: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--work-item") options.workItem = argv[++index];
    else if (arg === "--assessment") options.assessment = argv[++index];
    else if (arg === "--json") options.json = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!options.workItem || !options.assessment) throw new Error("--work-item and --assessment are required");
  return options;
}

export function exitCodeForStatus(status) {
  if (["not-required", "ready", "verified-with-attention"].includes(status)) return 0;
  if (["unknown", "blocked", "deployment-coupled", "release-blocked", "deploy-blocked"].includes(status)) return 3;
  return 1;
}

export function run(argv = process.argv.slice(2), now = new Date()) {
  const options = parseArgs(argv);
  const requirements = readWorkItemRemoteRequirements(options.workItem);
  const evidence = readAssessmentEvidence(options.assessment, now);
  const result = evaluateRemotePrerequisites(requirements, evidence);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${result.status}\n`);
  return exitCodeForStatus(result.status);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = run(); } catch (error) {
    process.stderr.write(`check-remote-prerequisites: ${error.message}\n`);
    process.exitCode = 1;
  }
}
