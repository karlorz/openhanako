const {
  compareForkReleaseTags,
  normalizeServerPlatformArch,
  parseForkReleaseTag,
} = require("./remote-server-release-catalog.cjs");
const policy = require("./remote-server-policy.json");

const EXPECTED_PUBLICATION_PRERELEASE = policy.expectedPublicationPrerelease;
const DEFAULT_CORE_REQUIREMENT = { contract: "chat.core", minVersion: 1 };
const REMOTE_INPUT_DRAFT_FEATURE_REQUIREMENTS = Object.freeze([Object.freeze({
  id: "input-drafts",
  contract: "input.drafts",
  minVersion: 1,
  unknownPolicy: "fallback",
  fallback: "memory-only",
})]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dedupe(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function parseCanonicalRuntimeVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  const version = match.slice(1).map(Number);
  if (!version.every(Number.isSafeInteger)) return null;
  return version;
}

function compareCanonicalRuntimeVersions(left, right) {
  const leftVersion = parseCanonicalRuntimeVersion(left);
  const rightVersion = parseCanonicalRuntimeVersion(right);
  if (!leftVersion || !rightVersion) return null;
  for (let index = 0; index < leftVersion.length; index += 1) {
    if (leftVersion[index] !== rightVersion[index]) {
      return leftVersion[index] < rightVersion[index] ? -1 : 1;
    }
  }
  return 0;
}

function normalizeContractDeclaration(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.entries)) {
    return { recognized: false, complete: false, entries: {} };
  }
  const entries = {};
  for (const [name, version] of Object.entries(value.entries)) {
    if (typeof name === "string" && Number.isSafeInteger(version) && version >= 0) {
      entries[name] = version;
    }
  }
  return { recognized: true, complete: value.complete === true, entries };
}

function coreEvidenceSource(input) {
  if (input.evidenceSource === "installer") return "installer";
  if (input.evidenceSource === "smoke") return "smoke";
  if (input.boundary && input.boundary.status === "assessed") return "remote-boundary";
  return "none";
}

function assessCore(input, declaration) {
  const reasonCodes = [];
  const warningCodes = [];
  let status = "not-assessed";
  if (input.boundary && input.boundary.status === "assessed") {
    reasonCodes.push(...(Array.isArray(input.boundary.reasonCodes) ? input.boundary.reasonCodes : []));
    warningCodes.push(...(Array.isArray(input.boundary.warningCodes) ? input.boundary.warningCodes : []));
    status = input.boundary.ok ? "ready" : "blocked";
  } else if (input.boundary && input.boundary.status === "not-assessed") {
    reasonCodes.push(input.boundary.reasonCode);
  } else if (input.evidenceSource === "installer") {
    reasonCodes.push("core_not_assessed_by_installer");
  } else {
    reasonCodes.push("remote_boundary_not_assessed");
  }

  const requirement = input.coreRequirement ?? DEFAULT_CORE_REQUIREMENT;
  if (declaration.recognized && declaration.complete) {
    const reported = declaration.entries[requirement.contract];
    if (!Number.isSafeInteger(reported) || reported < requirement.minVersion) {
      status = "blocked";
      reasonCodes.push("required_core_contract_missing");
    }
  }
  return {
    status,
    evidenceSource: coreEvidenceSource(input),
    reasonCodes: dedupe(reasonCodes),
    warningCodes: dedupe(warningCodes),
  };
}

function assessTransport(input, declaration) {
  const reported = declaration.recognized && Number.isSafeInteger(declaration.entries["websocket.ticket"])
    ? declaration.entries["websocket.ticket"]
    : null;
  if (reported !== null && reported >= 1) {
    return { status: "ticket-ready", reportedTicketContractVersion: reported, reasonCodes: [] };
  }
  if (input.server?.connectionKind === "lan") {
    return {
      status: "legacy-query-token",
      reportedTicketContractVersion: reported,
      reasonCodes: ["websocket_ticket_not_confirmed"],
    };
  }
  if (input.evidenceSource === "installer") {
    return { status: "not-assessed", reportedTicketContractVersion: reported, reasonCodes: ["transport_not_assessed"] };
  }
  return { status: "unknown", reportedTicketContractVersion: reported, reasonCodes: ["transport_contract_unknown"] };
}

function assessFeatures(input, declaration) {
  const requirements = Array.isArray(input.featureRequirements) ? input.featureRequirements : [];
  if (requirements.length === 0) {
    return { summary: "not-assessed", items: [] };
  }
  const items = requirements.map((requirement) => {
    const reportedVersion = declaration.recognized && Number.isSafeInteger(declaration.entries[requirement.contract])
      ? declaration.entries[requirement.contract]
      : null;
    if (reportedVersion !== null) {
      const supported = reportedVersion >= requirement.minVersion;
      return {
        id: requirement.id,
        contract: requirement.contract,
        requiredVersion: requirement.minVersion,
        reportedVersion,
        status: supported ? "supported" : "unavailable",
        fallback: supported ? null : requirement.fallback ?? null,
        evidenceSource: "declared",
        reasonCode: supported ? null : "feature_contract_version_too_low",
        upgradeEvidence: null,
      };
    }
    if (declaration.recognized && declaration.complete) {
      return {
        id: requirement.id,
        contract: requirement.contract,
        requiredVersion: requirement.minVersion,
        reportedVersion: null,
        status: "unavailable",
        fallback: requirement.fallback ?? null,
        evidenceSource: "declared",
        reasonCode: "feature_contract_missing",
        upgradeEvidence: null,
      };
    }
    return {
      id: requirement.id,
      contract: requirement.contract,
      requiredVersion: requirement.minVersion,
      reportedVersion: null,
      status: "unknown",
      fallback: requirement.fallback ?? null,
      evidenceSource: "legacy",
      reasonCode: "feature_contract_unknown",
      upgradeEvidence: null,
    };
  });
  return { summary: summarizeFeatures(items), items };
}

function summarizeFeatures(items) {
  if (items.length === 0 || items.every((item) => item.status === "not-assessed")) return "not-assessed";
  if (items.some((item) => item.status === "unknown")) return "legacy";
  if (items.some((item) => item.status === "unavailable")) return "limited";
  return "full";
}

function assessFreshness(input, build) {
  const releaseCheck = isRecord(input.releaseCheck) ? input.releaseCheck : null;
  const release = releaseCheck?.status === "ready" && isRecord(releaseCheck.release) ? releaseCheck.release : null;
  const runtimeVersion = build.runtimeVersion;
  const installedReleaseTag = build.releaseTag;
  const recommendedRuntimeVersion = stringOrNull(release?.runtimeVersion);
  const recommendedReleaseTag = stringOrNull(release?.tag);
  const reasonCodes = [];
  if (Array.isArray(releaseCheck?.reasonCodes)) reasonCodes.push(...releaseCheck.reasonCodes);
  if (Array.isArray(release?.reasonCodes)) reasonCodes.push(...release.reasonCodes);

  let status = "unknown";
  let baseVersionMatch = false;
  let exactReleaseMatch = false;
  if (release && runtimeVersion && recommendedRuntimeVersion && recommendedReleaseTag) {
    const runtimeComparison = compareCanonicalRuntimeVersions(runtimeVersion, recommendedRuntimeVersion);
    if (runtimeComparison === null) {
      status = "ahead-or-custom";
      reasonCodes.push("server_runtime_unparseable");
    } else if (runtimeComparison < 0) {
      status = "update-recommended";
      reasonCodes.push("server_runtime_older");
    } else if (runtimeComparison > 0) {
      status = "ahead-or-custom";
      reasonCodes.push("server_runtime_newer");
    } else {
      baseVersionMatch = true;
      const installedTag = parseForkReleaseTag(installedReleaseTag);
      const recommendedTag = parseForkReleaseTag(recommendedReleaseTag);
      if (!installedTag || !recommendedTag || installedTag.runtimeVersion !== recommendedTag.runtimeVersion) {
        reasonCodes.push("server_release_identity_missing");
      } else {
        const tagComparison = compareForkReleaseTags(installedReleaseTag, recommendedReleaseTag);
        if (tagComparison < 0) {
          status = "update-recommended";
          reasonCodes.push("server_fork_revision_older");
        } else if (tagComparison > 0) {
          status = "ahead-or-custom";
          reasonCodes.push("server_fork_revision_newer");
        } else {
          status = "current";
          exactReleaseMatch = true;
        }
      }
    }
  } else if (!release) {
    reasonCodes.push(releaseCheck?.errorCode || "server_release_not_checked");
  } else {
    reasonCodes.push("server_runtime_missing");
  }

  return {
    status,
    runtimeVersion,
    installedReleaseTag,
    recommendedRuntimeVersion,
    recommendedReleaseTag,
    baseVersionMatch,
    exactReleaseMatch,
    checkedAt: stringOrNull(releaseCheck?.checkedAt),
    source: releaseCheck?.source === "online" || releaseCheck?.source === "cached" ? releaseCheck.source : "none",
    stale: releaseCheck?.stale === true,
    reasonCodes: dedupe(reasonCodes),
  };
}

function assessDeployability(input, build, freshness) {
  const release = input.releaseCheck?.status === "ready" && isRecord(input.releaseCheck.release)
    ? input.releaseCheck.release
    : null;
  const host = normalizeServerPlatformArch(input.server?.runtimeFacts?.platform, input.server?.runtimeFacts?.arch);
  const installedTag = build.releaseTag;
  const runtimeValid = Boolean(parseCanonicalRuntimeVersion(build.runtimeVersion));
  const installedTagValid = !installedTag || Boolean(parseForkReleaseTag(installedTag));

  if (!release) {
    return {
      status: input.evidenceSource === "installer" && !input.releaseCheck ? "not-assessed" : "unknown",
      platform: host?.platform ?? null,
      arch: host?.arch ?? null,
      targetTag: null,
      assetName: null,
      checksumName: null,
      reasonCodes: [input.releaseCheck?.errorCode || "deployability_release_unknown"],
    };
  }
  if (!runtimeValid || !installedTagValid || freshness.status === "ahead-or-custom") {
    return {
      status: "unknown",
      platform: host?.platform ?? null,
      arch: host?.arch ?? null,
      targetTag: null,
      assetName: null,
      checksumName: null,
      reasonCodes: ["deployability_target_suppressed_for_custom_server"],
    };
  }
  if (!host) {
    return {
      status: "release-only",
      platform: null,
      arch: null,
      targetTag: release.tag,
      assetName: null,
      checksumName: null,
      reasonCodes: ["server_host_facts_missing"],
    };
  }
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => item?.platform === host.platform && item?.arch === host.arch)
    : null;
  if (!asset) {
    return {
      status: "unavailable",
      platform: host.platform,
      arch: host.arch,
      targetTag: release.tag,
      assetName: null,
      checksumName: null,
      reasonCodes: ["server_host_asset_missing"],
    };
  }
  return {
    status: "eligible",
    platform: host.platform,
    arch: host.arch,
    targetTag: release.tag,
    assetName: stringOrNull(asset.name),
    checksumName: stringOrNull(asset.checksumName),
    reasonCodes: [],
  };
}

function summarizeAssessment(assessment) {
  if (assessment.core.status === "blocked") return "blocked";
  if (assessment.core.status === "not-assessed" &&
      assessment.features.summary === "not-assessed" &&
      assessment.freshness.status === "unknown" &&
      (assessment.deployability.status === "not-assessed" || assessment.deployability.status === "unknown")) {
    return "not-assessed";
  }
  if (assessment.core.status !== "ready" ||
      assessment.transport.status === "legacy-query-token" ||
      assessment.features.summary === "limited" ||
      assessment.features.summary === "legacy" ||
      assessment.freshness.status !== "current" ||
      assessment.deployability.status === "release-only" ||
      assessment.deployability.status === "unavailable" ||
      assessment.releasePolicy.drift) {
    return "attention";
  }
  return "ready";
}

function collectAssessmentReasonCodes(assessment) {
  return dedupe([
    ...assessment.core.reasonCodes,
    ...assessment.transport.reasonCodes,
    ...assessment.features.items.map((item) => item.reasonCode),
    ...assessment.freshness.reasonCodes,
    ...assessment.deployability.reasonCodes,
  ]);
}

function assessRemoteServer(input) {
  if (!isRecord(input) || typeof input.connectionId !== "string" || input.connectionId.length === 0) {
    throw new TypeError("Remote server assessment requires a connectionId");
  }
  const server = isRecord(input.server) ? input.server : {};
  const runtimeBuild = isRecord(server.runtimeBuild) ? server.runtimeBuild : {};
  const runtimeVersion = stringOrNull(runtimeBuild.runtimeVersion) ?? stringOrNull(server.runtimeVersion);
  const build = {
    runtimeVersion,
    releaseTag: stringOrNull(runtimeBuild.releaseTag),
    gitSha: stringOrNull(runtimeBuild.gitSha),
    sourceRepository: stringOrNull(runtimeBuild.sourceRepository),
  };
  const declaration = normalizeContractDeclaration(server.featureContracts);
  const core = assessCore(input, declaration);
  const transport = assessTransport(input, declaration);
  const features = assessFeatures(input, declaration);
  const freshness = assessFreshness(input, build);
  const deployability = assessDeployability(input, build, freshness);
  const actualPrerelease = typeof input.releaseCheck?.release?.prerelease === "boolean"
    ? input.releaseCheck.release.prerelease
    : null;
  const releasePolicy = {
    expectedPrerelease: EXPECTED_PUBLICATION_PRERELEASE,
    actualPrerelease,
    drift: actualPrerelease !== null && actualPrerelease !== EXPECTED_PUBLICATION_PRERELEASE,
  };
  const partial = {
    schemaVersion: 1,
    connectionId: input.connectionId,
    assessedAt: stringOrNull(input.assessedAt) ?? new Date().toISOString(),
    core,
    transport,
    features,
    build,
    freshness,
    deployability,
    releasePolicy,
  };
  const reasonCodes = collectAssessmentReasonCodes(partial);
  return {
    ...partial,
    summary: summarizeAssessment(partial),
    reasonCodes,
  };
}

function applyRemoteFeatureObservation(assessment, observation) {
  if (!isRecord(assessment) || assessment.schemaVersion !== 1 || !isRecord(observation)) return assessment;
  const items = assessment.features.items.map((item) => {
    if (item.id !== observation.featureId) return item;
    return {
      ...item,
      status: observation.status,
      evidenceSource: "probe",
      reasonCode: stringOrNull(observation.reasonCode),
    };
  });
  const next = {
    ...assessment,
    features: { summary: summarizeFeatures(items), items },
  };
  next.reasonCodes = collectAssessmentReasonCodes(next);
  next.summary = summarizeAssessment(next);
  return next;
}

module.exports = {
  REMOTE_INPUT_DRAFT_FEATURE_REQUIREMENTS,
  applyRemoteFeatureObservation,
  assessRemoteServer,
  compareCanonicalRuntimeVersions,
  parseCanonicalRuntimeVersion,
};
