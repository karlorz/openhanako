export type ForkReleaseTag = {
  tag: string;
  runtimeVersion: string;
  version: [number, number, number];
  forkRevision: number;
};

export type NormalizedServerAsset = {
  platform: "linux" | "mac" | "win";
  arch: "arm64" | "x64";
  name: string;
  url: string;
  checksumName: string;
  checksumUrl: string;
};

export type NormalizedServerRelease = {
  tag: string;
  runtimeVersion: string;
  forkRevision: number;
  prerelease: boolean;
  publishedAt: string | null;
  releaseUrl: string | null;
  assets: NormalizedServerAsset[];
  compatibilityManifestName: string | null;
  featureContracts: null;
  manifestGitSha: null;
  reasonCodes: string[];
};

export type RemoteServerReleaseCheck = {
  status: "ready" | "unavailable";
  checkedAt: string;
  source: "online" | "cached" | "none";
  stale: boolean;
  release: NormalizedServerRelease | null;
  errorCode: string | null;
  reasonCodes: string[];
};

export function parseForkReleaseTag(value: unknown): ForkReleaseTag | null;
export function compareForkReleaseTags(left: unknown, right: unknown): number | null;
export function parseServerAssetName(name: unknown): {
  tag: string;
  platform: "linux" | "mac" | "win";
  arch: "arm64" | "x64";
} | null;
export function normalizeGithubServerRelease(
  value: unknown,
  policy: Record<string, unknown>,
): NormalizedServerRelease | null;
export function selectRecommendedServerRelease(
  values: unknown[],
  policy: Record<string, unknown>,
): NormalizedServerRelease | null;
export function normalizeServerPlatformArch(platform: unknown, arch: unknown): {
  platform: "linux" | "mac" | "win";
  arch: "arm64" | "x64";
} | null;
