import { useStore } from '../stores';
import type { SessionRegistryFile } from '../stores/chat-types';

export function upsertUploadedSessionFile(
  upload: Record<string, unknown> | null | undefined,
  sessionPath: string | null | undefined,
): void {
  if (!upload || !sessionPath) return;
  const filePath = typeof upload.filePath === 'string'
    ? upload.filePath
    : typeof upload.dest === 'string'
      ? upload.dest
      : typeof upload.realPath === 'string'
        ? upload.realPath
        : '';
  if (!filePath) return;
  useStore.getState().upsertSessionRegistryFile?.(sessionPath, {
    ...upload,
    filePath,
  } as SessionRegistryFile);
}
