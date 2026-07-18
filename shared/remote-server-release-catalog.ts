import catalog from "./remote-server-release-catalog.cjs";

export type {
  ForkReleaseTag,
  NormalizedServerAsset,
  NormalizedServerRelease,
  RemoteServerReleaseCheck,
} from "./remote-server-release-catalog.cjs";

export const {
  compareForkReleaseTags,
  normalizeGithubServerRelease,
  normalizeServerPlatformArch,
  parseForkReleaseTag,
  parseServerAssetName,
  selectRecommendedServerRelease,
} = catalog;
