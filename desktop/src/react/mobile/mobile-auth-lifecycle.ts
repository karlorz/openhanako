import type { JSONContent } from '@tiptap/core';

import type { AttachedFile } from '../stores/input-slice';
import {
  isHttpAuthFailure,
} from '../services/hana-http-error';

const MOBILE_AUTH_LOSS_REASONS = new Set([
  'missing_credential',
  'invalid_credential',
  'auth_failed',
]);
const UNSAFE_RECOVERY_DRAFT_KEYS = new Set([
  'fileid',
  'resourceid',
  'uploadid',
  'leaseid',
]);

export interface MobileAuthorityInput {
  serverId?: string | null;
  serverNodeId?: string | null;
  userId?: string | null;
  studioId?: string | null;
  officialServiceKind?: string | null;
  platformAccountId?: string | null;
  credentialId?: string | null;
  deviceId?: string | null;
}

export interface StableMobileAuthority {
  serverAuthorityId: string;
  userId: string;
  studioId: string;
  officialServiceKind: string | null;
  platformAccountId: string | null;
}

export type MobileAuthFailureDecision = 'session-lost' | 'confirm-session' | 'ignore';

export interface MobileRecoverySnapshot {
  authority: StableMobileAuthority;
  selectedSessionPath: string | null;
  draftText: string;
  draftDoc: JSONContent | null;
  attachments: AttachedFile[];
}

export interface MobileRecoveryState {
  selectedSessionPath: string;
  draftText: string;
  draftDoc: JSONContent | null;
  attachments: AttachedFile[];
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

/**
 * Reduces a runtime identity to the fields that are safe to use as restore
 * authority. A partial tuple is deliberately unverifiable.
 */
export function extractStableMobileAuthority(
  input: MobileAuthorityInput | null | undefined,
): StableMobileAuthority | null {
  if (!input) return null;

  const serverAuthorityId = nonEmptyString(input.serverNodeId)
    || nonEmptyString(input.serverId);
  const userId = nonEmptyString(input.userId);
  const studioId = nonEmptyString(input.studioId);
  if (!serverAuthorityId || !userId || !studioId) return null;

  const officialServiceKind = nonEmptyString(input.officialServiceKind);
  const platformAccountId = nonEmptyString(input.platformAccountId);
  const hasOfficialServiceIdentity = officialServiceKind !== null || platformAccountId !== null;
  if (hasOfficialServiceIdentity && (!officialServiceKind || !platformAccountId)) return null;

  return {
    serverAuthorityId,
    userId,
    studioId,
    officialServiceKind,
    platformAccountId,
  };
}

export function sameMobileAuthority(
  previous: MobileAuthorityInput | StableMobileAuthority | null | undefined,
  current: MobileAuthorityInput | StableMobileAuthority | null | undefined,
): boolean {
  const left = isStableMobileAuthority(previous)
    ? previous
    : extractStableMobileAuthority(previous);
  const right = isStableMobileAuthority(current)
    ? current
    : extractStableMobileAuthority(current);
  if (!left || !right) return false;

  return left.serverAuthorityId === right.serverAuthorityId
    && left.userId === right.userId
    && left.studioId === right.studioId
    && left.officialServiceKind === right.officialServiceKind
    && left.platformAccountId === right.platformAccountId;
}

function isStableMobileAuthority(
  authority: MobileAuthorityInput | StableMobileAuthority | null | undefined,
): authority is StableMobileAuthority {
  return !!authority && 'serverAuthorityId' in authority;
}

/**
 * Structured auth-loss reasons are conclusive. A status-only auth response
 * needs a public-session confirmation; other structured reasons stay normal
 * authorization errors.
 */
export function classifyMobileAuthFailure(error: unknown): MobileAuthFailureDecision {
  if (!isHttpAuthFailure(error)) return 'ignore';
  if (error.reason && MOBILE_AUTH_LOSS_REASONS.has(error.reason)) {
    return 'session-lost';
  }
  return error.reason ? 'ignore' : 'confirm-session';
}

/**
 * Retains only local bytes which have not acquired server ownership. Rebuild
 * each object from the allowed input fields so incidental upload/resource
 * identifiers cannot leak into the recovery snapshot.
 */
export function filterSafeInlineAttachments(
  attachments: readonly AttachedFile[],
): AttachedFile[] {
  return attachments.flatMap((attachment) => {
    const base64Data = nonEmptyString(attachment.base64Data);
    if (!base64Data || nonEmptyString(attachment.fileId)) return [];

    return [{
      path: attachment.path,
      name: attachment.name,
      ...(attachment.isDirectory !== undefined
        ? { isDirectory: attachment.isDirectory }
        : {}),
      base64Data,
      ...(attachment.mimeType !== undefined
        ? { mimeType: attachment.mimeType }
        : {}),
      ...(attachment.waveform !== undefined
        ? { waveform: attachment.waveform }
        : {}),
    }];
  });
}

/**
 * Rich editor JSON is untrusted recovery input: badge nodes and nested
 * server-owned identifiers can otherwise bypass the separate attachment
 * filter. JSON cloning both bounds the retained shape and prevents a later
 * mutation from adding authority-bearing data to an accepted snapshot.
 */
export function sanitizeMobileRecoveryDraftDoc(
  draftDoc: JSONContent | null | undefined,
): JSONContent | null {
  if (!draftDoc) return null;

  try {
    const cloned = JSON.parse(JSON.stringify(draftDoc)) as unknown;
    if (!isPlainObject(cloned) || containsUnsafeRecoveryDraftValue(cloned)) return null;
    return cloned as JSONContent;
  } catch {
    return null;
  }
}

function containsUnsafeRecoveryDraftValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsUnsafeRecoveryDraftValue);
  }
  if (!isPlainObject(value)) return false;

  if (
    typeof value.type === 'string'
    && value.type.toLowerCase() === 'filebadge'
  ) {
    return true;
  }

  return Object.entries(value).some(([key, nested]) => (
    UNSAFE_RECOVERY_DRAFT_KEYS.has(key.toLowerCase())
    || containsUnsafeRecoveryDraftValue(nested)
  ));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createMobileRecoverySnapshot({
  authority,
  selectedSessionPath,
  draftText,
  draftDoc,
  attachments,
}: {
  authority: MobileAuthorityInput | null | undefined;
  selectedSessionPath: string | null;
  draftText: string;
  draftDoc: JSONContent | null | undefined;
  attachments: readonly AttachedFile[];
}): MobileRecoverySnapshot | null {
  const stableAuthority = extractStableMobileAuthority(authority);
  if (!stableAuthority) return null;

  return {
    authority: stableAuthority,
    selectedSessionPath: nonEmptyString(selectedSessionPath),
    draftText,
    draftDoc: sanitizeMobileRecoveryDraftDoc(draftDoc),
    attachments: filterSafeInlineAttachments(attachments),
  };
}

export function restoreMobileRecoverySnapshot(
  snapshot: MobileRecoverySnapshot | null | undefined,
  {
    authority,
    availableSessionPaths,
  }: {
    authority: MobileAuthorityInput | null | undefined;
    availableSessionPaths: readonly string[];
  },
): MobileRecoveryState | null {
  if (!snapshot || !sameMobileAuthority(snapshot.authority, authority)) return null;

  const selectedSessionPath = snapshot.selectedSessionPath;
  if (!selectedSessionPath || !availableSessionPaths.includes(selectedSessionPath)) return null;

  return {
    selectedSessionPath,
    draftText: snapshot.draftText,
    draftDoc: sanitizeMobileRecoveryDraftDoc(snapshot.draftDoc),
    attachments: filterSafeInlineAttachments(snapshot.attachments),
  };
}
