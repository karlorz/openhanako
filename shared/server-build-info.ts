import serverBuildInfoModule from "./server-build-info.cjs";

export const {
  SERVER_BUILD_INFO_FILE_NAME,
  normalizeServerBuildInfo,
  readServerBuildInfo,
} = serverBuildInfoModule;

export type { ServerBuildInfo } from "./server-build-info.cjs";
