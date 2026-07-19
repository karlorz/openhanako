"use strict";

const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/i;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Compare the exact build identity carried by a packaged desktop with the
 * identity reported by the running local server. Older/local builds may not
 * carry a release tag or full SHA; in that case the existing version checks
 * remain the compatibility guard and this policy is intentionally a no-op.
 */
function compareExpectedRuntimeBuild(expected, actual) {
  const expectedObject = expected && typeof expected === "object" ? expected : {};
  const actualObject = actual && typeof actual === "object" ? actual : {};
  const expectedTag = nonEmptyString(expectedObject.releaseTag);
  const expectedSha = nonEmptyString(expectedObject.gitSha);

  if (!expectedTag && !FULL_GIT_SHA_RE.test(expectedSha || "")) {
    return { matches: true, reason: "no exact runtime build identity expected" };
  }

  const actualTag = nonEmptyString(actualObject.releaseTag);
  if (expectedTag && !actualTag) {
    return { matches: false, reason: `missing runtime release tag (expected ${expectedTag})` };
  }
  if (expectedTag && actualTag !== expectedTag) {
    return {
      matches: false,
      reason: `runtime release tag mismatch: expected ${expectedTag}, got ${actualTag}`,
    };
  }

  if (FULL_GIT_SHA_RE.test(expectedSha || "")) {
    const actualSha = nonEmptyString(actualObject.gitSha);
    if (!actualSha) {
      return { matches: false, reason: `missing runtime git SHA (expected ${expectedSha})` };
    }
    if (!FULL_GIT_SHA_RE.test(actualSha) || actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
      return {
        matches: false,
        reason: `runtime git SHA mismatch: expected ${expectedSha}, got ${actualSha}`,
      };
    }
  }

  return { matches: true, reason: "exact runtime build match" };
}

module.exports = {
  FULL_GIT_SHA_RE,
  compareExpectedRuntimeBuild,
};
