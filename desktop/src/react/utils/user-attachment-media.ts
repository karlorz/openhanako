import type { UserAttachment } from '../stores/chat-types';
import { useStore } from '../stores';
import { resolveFileRefUrl } from '../services/resource-url';
import { resolveServerConnection } from '../services/server-connection';
import type { PlatformApi } from '../types';
import { extOfName } from './file-kind';

type FileUrlPlatform = Pick<PlatformApi, 'getFileUrl'> | null | undefined;
type AttachmentImageSource = Pick<UserAttachment, 'path'> &
  Partial<Pick<UserAttachment, 'fileId' | 'name' | 'base64Data' | 'mimeType' | 'resource'>>;

export function getUserAttachmentImageSrc(
  attachment: AttachmentImageSource,
  platform: FileUrlPlatform = typeof window !== 'undefined' ? window.platform : undefined,
): string | null {
  if (attachment.base64Data) {
    return `data:${attachment.mimeType || 'image/png'};base64,${attachment.base64Data}`;
  }
  if (!attachment.path) return null;
  try {
    const name = attachment.name || attachment.path.split(/[\\/]/).pop() || attachment.path;
    return resolveFileRefUrl({
      id: `user-attachment:${attachment.fileId || attachment.path}`,
      fileId: attachment.fileId,
      kind: 'image',
      source: 'session-attachment',
      name,
      path: attachment.path,
      ext: extOfName(name),
      mime: attachment.mimeType,
      resource: attachment.resource,
    }, {
      connection: resolveServerConnection(useStore.getState()),
      platform,
    }).url;
  } catch {
    if (typeof platform?.getFileUrl === 'function') {
      return platform.getFileUrl(attachment.path);
    }
  }
  return null;
}
