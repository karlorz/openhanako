/**
 * Packaged dual-profile boot planning (legacy-raw vs signed seed).
 *
 * Pure decision + result builders for desktop packaging. Electron main still
 * owns process spawn, splash progress, GC, and quarantine notifications, but
 * the dual-profile branch that used to live inline in `resolvePackagedArtifactBoot`
 * is testable here without launching Electron.
 *
 * Does not perform artifact-boot promote/resolve — callers pass the prepared
 * boot object into `buildSignedPackagedBootResult`.
 */

"use strict";

const {
  LEGACY_RAW_PROFILE,
  SIGNED_PROFILE,
} = require("../../../shared/release-profile.cjs");
const { resolvePackagedLayout } = require("./release-runtime-policy.cjs");

/**
 * @typedef {{
 *   distRenderer: string | null,
 *   rendererBootChannel: string | null,
 *   rendererBootTrain: number | null,
 *   artifactBootChannel: string | null,
 *   contentVersion: string | null,
 * }} PackagedRendererState
 */

/**
 * @typedef {{
 *   serverRoot: string,
 *   serverRendererRoot?: string | null,
 *   train: number | null,
 *   channel: string | null,
 *   artifactManaged: boolean,
 *   releaseProfile: string,
 * }} PackagedBootContext
 */

/**
 * Plan packaged boot from an already-resolved layout (from resolvePackagedLayout).
 *
 * @param {{
 *   layout: { mode: string, serverRoot?: string, rendererRoot?: string, serverRendererRoot?: string, seedRoot?: string },
 *   buildInfo?: { appVersion?: string } | null,
 *   appVersion?: string | null,
 * }} opts
 * @returns {{
 *   kind: 'dev' | 'legacy-raw' | 'signed',
 *   context: PackagedBootContext | null,
 *   rendererState: PackagedRendererState | null,
 *   layout: object | null,
 * }}
 */
function planPackagedArtifactBoot({ layout, buildInfo = null, appVersion = null } = {}) {
  if (!layout || layout.mode === "dev") {
    return { kind: "dev", context: null, rendererState: null, layout: layout || null };
  }

  if (layout.mode === LEGACY_RAW_PROFILE || layout.mode === "legacy-raw") {
    const contentVersion = (buildInfo && buildInfo.appVersion) || appVersion || null;
    return {
      kind: LEGACY_RAW_PROFILE,
      context: {
        serverRoot: layout.serverRoot,
        serverRendererRoot: layout.serverRendererRoot || null,
        train: null,
        channel: null,
        artifactManaged: false,
        releaseProfile: LEGACY_RAW_PROFILE,
      },
      rendererState: {
        distRenderer: layout.rendererRoot || null,
        rendererBootChannel: null,
        rendererBootTrain: null,
        artifactBootChannel: null,
        contentVersion,
      },
      layout,
    };
  }

  // signed (or any non-raw packaged mode): caller must run artifact-boot prepare
  return {
    kind: SIGNED_PROFILE,
    context: null,
    rendererState: null,
    layout,
  };
}

/**
 * Resolve resources → layout → dual-profile plan in one call (no Electron).
 * Used by main and by unit tests with temp resource trees.
 */
function planPackagedArtifactBootFromResources({
  appIsPackaged,
  resourcesPath,
  buildInfo,
  rendererRoot,
  appVersion = null,
  resolveLayout = resolvePackagedLayout,
} = {}) {
  const layout = resolveLayout({
    appIsPackaged,
    resourcesPath,
    buildInfo,
    rendererRoot,
  });
  return planPackagedArtifactBoot({ layout, buildInfo, appVersion });
}

/**
 * Map prepareArtifactBoot output into the main-process boot context + renderer state.
 *
 * @param {{
 *   boot: { server: object, renderer: object },
 *   bootChannel: string,
 *   rendererPointerChannel: (channel: string) => string,
 *   previousContentVersion?: string | null,
 * }} opts
 */
function buildSignedPackagedBootResult({
  boot,
  bootChannel,
  rendererPointerChannel,
  previousContentVersion = null,
} = {}) {
  if (!boot || !boot.server || !boot.renderer) {
    throw new Error("buildSignedPackagedBootResult requires prepareArtifactBoot result");
  }
  if (typeof rendererPointerChannel !== "function") {
    throw new Error("buildSignedPackagedBootResult requires rendererPointerChannel");
  }
  const contentVersion = boot.renderer.version
    || boot.server.version
    || previousContentVersion
    || null;
  return {
    kind: SIGNED_PROFILE,
    context: {
      serverRoot: boot.server.versionDir,
      train: boot.server.train,
      channel: bootChannel,
      artifactManaged: true,
      releaseProfile: SIGNED_PROFILE,
    },
    rendererState: {
      distRenderer: boot.renderer.versionDir,
      rendererBootChannel: rendererPointerChannel(bootChannel),
      rendererBootTrain: boot.renderer.train,
      artifactBootChannel: bootChannel,
      contentVersion,
    },
    notices: {
      quarantine: boot.server.quarantinedTrain != null || boot.renderer.quarantinedTrain != null,
      server: boot.server,
      renderer: boot.renderer,
    },
  };
}

module.exports = {
  planPackagedArtifactBoot,
  planPackagedArtifactBootFromResources,
  buildSignedPackagedBootResult,
};
