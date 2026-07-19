"use strict";

const packageJson = require("../package.json");
const { createElectronBuilderConfig } = require("./electron-builder-config.cjs");

module.exports = createElectronBuilderConfig({
  profile: process.env.HANA_RELEASE_PROFILE,
  baseConfig: packageJson.build,
});
