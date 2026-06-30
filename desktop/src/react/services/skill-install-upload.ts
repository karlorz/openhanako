import { canUseNativeResourcePath } from './resource-access';
import { resolveServerConnection, type ServerConnectionSource } from './server-connection';

export interface SkillInstallBody {
  path?: string;
  sessionPath?: string;
  file?: {
    filename: string;
    contentBase64: string;
  };
}

export function canUseNativeSkillInstallPath(source: ServerConnectionSource): boolean {
  return canUseNativeResourcePath({
    connection: resolveServerConnection(source),
  });
}

export async function skillFileToUploadInstallBody(
  file: File,
  options: { sessionPath?: string | null } = {},
): Promise<SkillInstallBody> {
  return {
    file: {
      filename: file.name || 'skill.skill',
      contentBase64: await fileToBase64(file),
    },
    ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
  };
}

export async function skillPathToUploadInstallBody(
  filePath: string,
  options: { sessionPath?: string | null; filename?: string | null } = {},
): Promise<SkillInstallBody> {
  const contentBase64 = await window.platform?.readFileBase64?.(filePath);
  if (!contentBase64) {
    throw new Error('cannot read local skill package for upload');
  }
  return {
    file: {
      filename: options.filename || skillFilenameFromPath(filePath),
      contentBase64,
    },
    ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('failed to read file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() || '' : result);
    };
    reader.readAsDataURL(file);
  });
}

function skillFilenameFromPath(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || 'skill.skill';
}
