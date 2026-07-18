import type { RemoteServerReleaseCheck } from "./remote-server-release-catalog.cjs";
export type { RemoteServerReleaseCheck };

export function createRemoteServerReleaseLoader(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}): (options?: { force?: boolean }) => Promise<RemoteServerReleaseCheck>;
