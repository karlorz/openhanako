const source = require("./remote-feature-contracts.json");

const CONTRACT_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

function normalizeFeatureContracts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schemaVersion !== 1 || value.complete !== true) return null;
  if (!value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) return null;

  const entries = {};
  for (const [name, version] of Object.entries(value.entries)) {
    if (!CONTRACT_NAME_RE.test(name) || !Number.isSafeInteger(version) || version <= 0) return null;
    entries[name] = version;
  }
  return Object.freeze({
    schemaVersion: 1,
    complete: true,
    entries: Object.freeze(entries),
  });
}

const SERVER_FEATURE_CONTRACTS = normalizeFeatureContracts(source);
if (!SERVER_FEATURE_CONTRACTS) {
  throw new TypeError("Invalid remote feature-contract registry");
}

module.exports = {
  CONTRACT_NAME_RE,
  SERVER_FEATURE_CONTRACTS,
  normalizeFeatureContracts,
};
