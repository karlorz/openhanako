/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { getUserAttachmentImageSrc } from '../../utils/user-attachment-media';

describe('getUserAttachmentImageSrc', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('优先使用已有 base64 inline 数据', () => {
    const platform = { getFileUrl: vi.fn(() => 'file:///tmp/pic.png') };

    expect(getUserAttachmentImageSrc({
      path: '/tmp/pic.png',
      base64Data: 'BASE64',
      mimeType: 'image/png',
    }, platform)).toBe('data:image/png;base64,BASE64');
    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('没有 base64 时用 preload 的 file URL 恢复本地图片', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file://${p}`) };

    expect(getUserAttachmentImageSrc({
      path: '/Users/test/.hanako/attachments/upload-abc.png',
    }, platform)).toBe('file:///Users/test/.hanako/attachments/upload-abc.png');
  });

  it('remote session image attachments use resource URLs after inline bytes are gone', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file://${p}`) };
    const remoteConnection = {
      connectionId: 'lan:remote:studio',
      kind: 'lan',
      serverId: 'remote',
      studioId: 'studio_remote',
      label: 'Remote Hana',
      baseUrl: 'http://100.125.173.118:14500',
      wsUrl: 'ws://100.125.173.118:14500',
      token: 'remote-token',
      authState: 'paired',
      trustState: 'lan',
      credentialKind: 'device_credential',
      platformAccountId: null,
      officialServiceKind: null,
      capabilities: ['chat', 'resources'],
    };
    useStore.setState({
      serverConnections: { [remoteConnection.connectionId]: remoteConnection },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
    } as never);

    expect(getUserAttachmentImageSrc({
      fileId: 'sf_pasted_image',
      path: '/hana/session-files/pasted.png',
      name: 'pasted.png',
      mimeType: 'image/png',
    } as never, platform)).toBe(
      'http://100.125.173.118:14500/api/resources/res_sf_pasted_image/content?token=remote-token',
    );
    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });
});
