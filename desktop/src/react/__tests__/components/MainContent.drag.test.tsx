// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

describe('MainContent app file drag attachments', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    vi.mocked(hanaFetch).mockReset();
    useStore.setState({
      currentSessionPath: '/sessions/main.jsonl',
      currentTab: 'chat',
      attachedFiles: [],
      attachedFilesBySession: {},
      sessionRegistryFilesByPath: {},
    } as never);
    window.platform = undefined as never;
  });

  it('attaches dragged session files without re-uploading them', async () => {
    const { attachAppFileDragPayloadToInput } = await import('../../MainContent');

    await attachAppFileDragPayloadToInput({
      dragId: 'hana-drag-test',
      source: 'session-file',
      files: [{
        id: 'sf_report',
        fileId: 'sf_report',
        name: 'report.pdf',
        path: '/tmp/session-files/report.pdf',
        isDirectory: false,
      }],
    });

    expect(useStore.getState().attachedFiles).toEqual([{
      fileId: 'sf_report',
      path: '/tmp/session-files/report.pdf',
      name: 'report.pdf',
      isDirectory: false,
    }]);
    expect(useStore.getState().attachedFilesBySession['/sessions/main.jsonl']).toEqual(useStore.getState().attachedFiles);
  });

  it('attaches workspace files dragged from a native-root mount directly by absolute path', async () => {
    useStore.setState({
      currentTab: 'chat',
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: '/Users/me/docs',
      deskFiles: [{ name: 'report.md', isDir: false }],
    } as never);
    const { attachAppFileDragPayloadToInput } = await import('../../MainContent');

    await attachAppFileDragPayloadToInput({
      dragId: 'hana-drag-mount-workspace',
      source: 'workspace',
      files: [{
        id: 'workspace:report.md',
        name: 'report.md',
        path: '/Users/me/docs/report.md',
        sourceSubdir: '',
        isDirectory: false,
      }],
    });

    expect(useStore.getState().attachedFiles).toEqual([{
      path: '/Users/me/docs/report.md',
      name: 'report.md',
      isDirectory: false,
    }]);
    expect(hanaFetch).not.toHaveBeenCalled();
  });

  it('does not attach dragged files to the chat input while viewing channels', async () => {
    const addToast = vi.fn();
    useStore.setState({
      currentTab: 'channels',
      addToast,
    } as never);
    const { attachAppFileDragPayloadToInput, attachFilesFromPaths } = await import('../../MainContent');

    await attachAppFileDragPayloadToInput({
      dragId: 'hana-drag-channel-session-file',
      source: 'session-file',
      files: [{
        id: 'sf_channel',
        fileId: 'sf_channel',
        name: 'channel.png',
        path: '/tmp/session-files/channel.png',
      }],
    });
    await attachFilesFromPaths(['/tmp/local.txt']);

    expect(useStore.getState().attachedFiles).toEqual([]);
    expect(useStore.getState().attachedFilesBySession['/sessions/main.jsonl']).toBeUndefined();
    expect(hanaFetch).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('channel.filesUnsupported', 'error');
  });

  it('uploads local image bytes for remote connections instead of sending the macOS path', async () => {
    const readFileBase64 = vi.fn(async () => 'JPG_BASE64');
    window.platform = { readFileBase64 } as unknown as typeof window.platform;
    useStore.setState({
      serverConnections: {
        'lan:node:studio': {
          connectionId: 'lan:node:studio',
          kind: 'lan',
          serverId: 'remote',
          studioId: 'studio',
          label: 'Remote Hana',
          baseUrl: 'http://100.125.173.118:14500',
          wsUrl: 'ws://100.125.173.118:14500',
          token: 'remote-token',
          authState: 'paired',
          trustState: 'lan',
          credentialKind: 'device_credential',
          capabilities: ['chat'],
        },
      },
      activeServerConnectionId: 'lan:node:studio',
    } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      json: async () => ({
        uploads: [{
          fileId: 'sf_remote_jpg',
          filePath: '/root/.hanako/session-files/photo.jpg',
          dest: '/root/.hanako/session-files/photo.jpg',
          name: 'photo.jpg',
          isDirectory: false,
        }],
      }),
    } as Response);

    const { attachFilesFromPaths } = await import('../../MainContent');

    await attachFilesFromPaths(['/Users/me/Desktop/photo.jpg']);

    expect(readFileBase64).toHaveBeenCalledWith('/Users/me/Desktop/photo.jpg');
    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(hanaFetch).toHaveBeenCalledWith('/api/upload-blob', expect.objectContaining({
      method: 'POST',
    }));
    const body = JSON.parse(String(vi.mocked(hanaFetch).mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      name: 'photo.jpg',
      base64Data: 'JPG_BASE64',
      mimeType: 'image/jpeg',
      sessionPath: '/sessions/main.jsonl',
    });
    expect(body.paths).toBeUndefined();
    expect(useStore.getState().attachedFiles[0]).toMatchObject({
      fileId: 'sf_remote_jpg',
      path: '/root/.hanako/session-files/photo.jpg',
      name: 'photo.jpg',
      isDirectory: false,
      base64Data: 'JPG_BASE64',
      mimeType: 'image/jpeg',
    });
    expect(useStore.getState().sessionRegistryFilesByPath['/sessions/main.jsonl']?.[0]).toMatchObject({
      fileId: 'sf_remote_jpg',
      filePath: '/root/.hanako/session-files/photo.jpg',
    });
  });

  it('uploads local PDF bytes for remote connections instead of sending the macOS path', async () => {
    const readFileBase64 = vi.fn(async () => 'PDF_BASE64');
    window.platform = { readFileBase64 } as unknown as typeof window.platform;
    useStore.setState({
      serverConnections: {
        'lan:node:studio': {
          connectionId: 'lan:node:studio',
          kind: 'lan',
          serverId: 'remote',
          studioId: 'studio',
          label: 'Remote Hana',
          baseUrl: 'http://100.125.173.118:14500',
          wsUrl: 'ws://100.125.173.118:14500',
          token: 'remote-token',
          authState: 'paired',
          trustState: 'lan',
          credentialKind: 'device_credential',
          capabilities: ['chat'],
        },
      },
      activeServerConnectionId: 'lan:node:studio',
    } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      json: async () => ({
        uploads: [{
          fileId: 'sf_remote_pdf',
          filePath: '/root/.hanako/session-files/report.pdf',
          dest: '/root/.hanako/session-files/report.pdf',
          name: 'report.pdf',
          isDirectory: false,
        }],
      }),
    } as Response);

    const { attachFilesFromPaths } = await import('../../MainContent');

    await attachFilesFromPaths(['/Users/me/Desktop/report.pdf']);

    expect(readFileBase64).toHaveBeenCalledWith('/Users/me/Desktop/report.pdf');
    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(hanaFetch).toHaveBeenCalledWith('/api/upload-blob', expect.objectContaining({
      method: 'POST',
    }));
    const body = JSON.parse(String(vi.mocked(hanaFetch).mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      name: 'report.pdf',
      base64Data: 'PDF_BASE64',
      mimeType: 'application/pdf',
      sessionPath: '/sessions/main.jsonl',
    });
    expect(body.paths).toBeUndefined();
    expect(useStore.getState().attachedFiles[0]).toMatchObject({
      fileId: 'sf_remote_pdf',
      path: '/root/.hanako/session-files/report.pdf',
      name: 'report.pdf',
      isDirectory: false,
      mimeType: 'application/pdf',
    });
    expect(useStore.getState().attachedFiles[0].base64Data).toBeUndefined();
    expect(useStore.getState().sessionRegistryFilesByPath['/sessions/main.jsonl']?.[0]).toMatchObject({
      fileId: 'sf_remote_pdf',
      filePath: '/root/.hanako/session-files/report.pdf',
    });
  });
});
