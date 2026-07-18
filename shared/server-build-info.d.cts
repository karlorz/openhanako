export type ServerBuildInfo = {
  schemaVersion: 1;
  runtimeVersion: string;
  releaseTag: string | null;
  gitSha: string | null;
  sourceRepository: string | null;
  platform: "linux" | "mac" | "win" | null;
  arch: "arm64" | "x64" | null;
};

export const SERVER_BUILD_INFO_FILE_NAME: "server-build-info.json";
export function normalizeServerBuildInfo(value: unknown): Readonly<ServerBuildInfo> | null;
export function readServerBuildInfo(options?: {
  rootDir?: string | null;
  fsImpl?: Pick<typeof import("node:fs"), "readFileSync">;
}): Readonly<ServerBuildInfo> | null;
