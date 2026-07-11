/**
 * Shared remote attachment ownership matrix for next-stable migration
 * characterization. Locks client-owned / server-owned / optimistic /
 * persisted-legacy attachment contracts without changing production code.
 */

export type AttachmentOwnershipKind =
  | "client-owned"
  | "server-owned"
  | "optimistic"
  | "persisted-legacy";

export type OwnershipCase =
  | {
    kind: "client-owned";
    path: string;
    name: string;
    shouldUpload: true;
    mimeType: string;
  }
  | {
    kind: "server-owned";
    path: string;
    name: string;
    fileId: string;
    shouldUpload: false;
  }
  | {
    kind: "optimistic";
    path: string;
    name: string;
    fileId: string;
    base64Data: string;
    mimeType: string;
    shouldUpload: false;
    keepInlineUntilServerEcho: true;
  }
  | {
    kind: "persisted-legacy";
    fileId: string;
    resourceId: string;
    expectedUrl: string;
    shouldUpload: false;
  };

/**
 * Canonical ownership table used by desktop attachment / resource-url /
 * Conversation Files characterization suites.
 */
export const ownershipCases = [
  {
    kind: "client-owned",
    path: "/Users/test/image.png",
    name: "image.png",
    shouldUpload: true,
    mimeType: "image/png",
  },
  {
    kind: "server-owned",
    path: "/srv/hana/session/file.png",
    name: "file.png",
    fileId: "sf_server_owned",
    shouldUpload: false,
  },
  {
    kind: "optimistic",
    path: "/hana/session-files/optimistic.png",
    name: "optimistic.png",
    fileId: "sf_optimistic",
    base64Data: "OPTIMISTIC_BASE64",
    mimeType: "image/png",
    shouldUpload: false,
    keepInlineUntilServerEcho: true,
  },
  {
    kind: "persisted-legacy",
    fileId: "sf_legacy",
    resourceId: "res_sf_legacy",
    expectedUrl: "/api/resources/res_sf_legacy/content",
    shouldUpload: false,
  },
] as const satisfies readonly OwnershipCase[];

export function ownershipCase<K extends AttachmentOwnershipKind>(
  kind: K,
): Extract<(typeof ownershipCases)[number], { kind: K }> {
  const found = ownershipCases.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`missing ownership case: ${kind}`);
  return found as Extract<(typeof ownershipCases)[number], { kind: K }>;
}

/** Derive synthetic resource content path from a legacy SessionFile id. */
export function legacySessionFileContentPath(fileId: string): string {
  if (!/^sf_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(fileId)) {
    throw new Error(`not a session-file id: ${fileId}`);
  }
  return `/api/resources/res_${fileId}/content`;
}

/**
 * Pure ownership decision used by remote attach characterization.
 * Mirrors MainContent pathOwner semantics without importing production UI.
 */
export function shouldUploadOwnedPath(
  path: string,
  pathOwner: "auto" | "client" | "server" = "auto",
): boolean {
  if (pathOwner === "server") return false;
  if (pathOwner === "client") return true;
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.startsWith("/Users/")
    || normalized.startsWith("/Volumes/")
    || normalized.startsWith("/private/")
    || normalized.startsWith("/var/folders/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.startsWith("//")
  );
}
