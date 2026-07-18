const policy = require("./remote-server-policy.json");
const {
  selectRecommendedServerRelease,
} = require("./remote-server-release-catalog.cjs");

class ReleaseCatalogError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function dedupe(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasNextPage(headers) {
  const link = headers && typeof headers.get === "function" ? headers.get("link") : null;
  return typeof link === "string" && /rel="next"/.test(link);
}

function errorCodeFor(error) {
  if (error && typeof error.code === "string") return error.code;
  if (error && error.name === "AbortError") return "release_catalog_timeout";
  if (error instanceof SyntaxError) return "release_catalog_invalid_json";
  return "release_catalog_request_failed";
}

function createRemoteServerReleaseLoader(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const env = options.env || process.env;
  const log = typeof options.log === "function" ? options.log : () => {};
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Remote server release loader requires fetch");
  }

  let cachedResult = null;
  let cachedAt = 0;
  let inFlight = null;
  let lastForceAt = Number.NEGATIVE_INFINITY;
  let lastForcedResult = null;

  async function loadOnline() {
    const startedAt = now();
    const checkedAt = new Date(startedAt).toISOString();
    const releases = [];
    const reasonCodes = [];
    let combinedBodyBytes = 0;
    let truncated = false;
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "HanaAgent-remote-server-release-check",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      for (let page = 1; page <= policy.github.maxPages; page += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), policy.github.requestTimeoutMs);
        let response;
        let body;
        try {
          const url = `https://api.github.com/repos/${policy.repository}/releases?per_page=${policy.github.perPage}&page=${page}`;
          response = await fetchImpl(url, { headers, signal: controller.signal });
          if (!response || response.ok !== true) {
            throw new ReleaseCatalogError(`release_catalog_http_${response?.status || "unknown"}`);
          }
          body = await response.text();
        } finally {
          clearTimeout(timeout);
        }
        combinedBodyBytes += Buffer.byteLength(body, "utf8");
        if (combinedBodyBytes > policy.github.maxReleasesBodyBytes) {
          throw new ReleaseCatalogError("release_catalog_too_large");
        }
        const pageValues = JSON.parse(body);
        if (!Array.isArray(pageValues)) {
          throw new ReleaseCatalogError("release_catalog_invalid_response");
        }
        releases.push(...pageValues);
        const next = hasNextPage(response.headers);
        if (pageValues.length === 0 || !next) break;
        if (page === policy.github.maxPages) truncated = true;
      }

      const release = selectRecommendedServerRelease(releases, policy);
      if (!release) {
        return {
          status: "unavailable",
          checkedAt,
          source: "online",
          stale: false,
          release: null,
          errorCode: "eligible_server_release_missing",
          reasonCodes: truncated ? ["release_catalog_truncated"] : [],
        };
      }
      if (truncated) reasonCodes.push("release_catalog_truncated");
      reasonCodes.push(...release.reasonCodes);
      return {
        status: "ready",
        checkedAt,
        source: "online",
        stale: false,
        release,
        errorCode: null,
        reasonCodes: dedupe(reasonCodes),
      };
    } catch (error) {
      const code = errorCodeFor(error);
      log(`remote server release load failed: ${code}`);
      if (cachedResult) {
        return {
          ...clone(cachedResult),
          source: "cached",
          stale: true,
          errorCode: code,
          reasonCodes: dedupe([...cachedResult.reasonCodes, code]),
        };
      }
      return {
        status: "unavailable",
        checkedAt,
        source: "none",
        stale: false,
        release: null,
        errorCode: code,
        reasonCodes: [code],
      };
    }
  }

  return async function loadRemoteServerRelease(loadOptions = {}) {
    const currentTime = now();
    const force = loadOptions && loadOptions.force === true;
    if (force && lastForcedResult && currentTime - lastForceAt <= policy.github.forceRefreshMinIntervalMs) {
      return clone(lastForcedResult);
    }
    if (!force && cachedResult && currentTime - cachedAt < policy.github.cacheTtlMs) {
      return { ...clone(cachedResult), source: "cached", stale: false };
    }
    if (inFlight) return inFlight;

    if (force) lastForceAt = currentTime;
    inFlight = loadOnline()
      .then((result) => {
        if (result.status === "ready" && result.source === "online") {
          cachedResult = clone(result);
          cachedAt = now();
        }
        if (force) lastForcedResult = clone(result);
        return clone(result);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

module.exports = {
  createRemoteServerReleaseLoader,
};
