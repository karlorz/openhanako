import { describe, expect, it, vi } from 'vitest';
import { resolveFileRefUrl } from '../../services/resource-url';
import type { ServerConnection } from '../../services/server-connection';
import type { FileRef } from '../../types/file-ref';

const localConnection: ServerConnection = {
  connectionId: 'local',
  kind: 'local',
  serverId: 'server_local',
  userId: 'user_local',
  studioId: 'studio_local',
  label: 'Local Hana',
  baseUrl: 'http://127.0.0.1:14500',
  wsUrl: 'ws://127.0.0.1:14500',
  token: 'local token',
  authState: 'paired',
  trustState: 'local',
  credentialKind: 'loopback_token',
  platformAccountId: null,
  officialServiceKind: null,
  capabilities: ['resources'],
};

const remoteConnection: ServerConnection = {
  ...localConnection,
  connectionId: 'custom:remote',
  kind: 'custom_remote',
  serverId: 'server_remote',
  studioId: 'studio_remote',
  label: 'Remote Hana',
  baseUrl: 'https://hana.example',
  wsUrl: 'wss://hana.example',
  token: 'remote token',
  trustState: 'tunnel',
  credentialKind: 'device_credential',
};

const lanDeviceConnection: ServerConnection = {
  ...localConnection,
  connectionId: 'lan:device',
  kind: 'lan',
  serverId: 'server_lan',
  studioId: 'studio_lan',
  label: 'LAN Hana',
  baseUrl: 'http://100.125.173.118:14500',
  wsUrl: 'ws://100.125.173.118:14500',
  token: 'lan token',
  trustState: 'lan',
  credentialKind: 'device_credential',
};

const malformedLocalishConnection: ServerConnection = {
  ...localConnection,
  connectionId: 'bad:localish',
  kind: 'local',
  serverId: 'server_bad',
  studioId: 'studio_bad',
  label: 'Bad Localish Hana',
  baseUrl: 'http://100.125.173.118:14500',
  wsUrl: 'ws://100.125.173.118:14500',
  token: 'bad token',
  trustState: 'lan',
  credentialKind: 'device_credential',
};

const nonLoopbackLocalishConnection: ServerConnection = {
  ...localConnection,
  connectionId: 'bad:nonloopback',
  kind: 'local',
  serverId: 'server_bad_nonloopback',
  studioId: 'studio_bad_nonloopback',
  label: 'Bad Non-loopback Hana',
  baseUrl: 'http://100.125.173.118:14500',
  wsUrl: 'ws://100.125.173.118:14500',
  token: 'bad token',
  trustState: 'local',
  credentialKind: 'loopback_token',
};

function fileRef(patch: Partial<FileRef> = {}): FileRef {
  return {
    id: 'session-registry:/workspace/asset.png',
    fileId: 'sf_asset',
    kind: 'image',
    source: 'session-registry',
    name: 'asset.png',
    path: '/workspace/asset.png',
    ext: 'png',
    resource: {
      resourceId: 'res_sf_asset',
      studioId: 'studio_local',
      links: {
        self: '/api/resources/res_sf_asset',
        content: '/api/resources/res_sf_asset/content',
      },
    },
    ...patch,
  };
}

describe('resolveFileRefUrl', () => {
  it('keeps the local desktop file URL fast path when a local path is available', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    const result = resolveFileRefUrl(fileRef({ version: { mtimeMs: 11, size: 22 } }), {
      connection: localConnection,
      platform,
    });

    expect(result).toEqual({
      mode: 'local-file',
      url: 'file:///mock/workspace/asset.png?v=11-22',
    });
    expect(platform.getFileUrl).toHaveBeenCalledWith('/workspace/asset.png');
  });

  it('keeps existing local-owner behavior when no connection is available', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    const result = resolveFileRefUrl(fileRef({
      resource: undefined,
      version: { mtimeMs: 11, size: 22 },
    }), {
      connection: null,
      platform,
    });

    expect(result).toEqual({
      mode: 'local-file',
      url: 'file:///mock/workspace/asset.png?v=11-22',
    });
    expect(platform.getFileUrl).toHaveBeenCalledWith('/workspace/asset.png');
  });

  it('rejects a LAN path-only ref that has no resource content link', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    expect(() => resolveFileRefUrl(fileRef({
      fileId: 'uploaded_image',
      resource: undefined,
    }), {
      connection: lanDeviceConnection,
      platform,
    })).toThrow('remote file ref requires resource content link');

    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('rejects a custom remote path-only ref that has no resource content link', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    expect(() => resolveFileRefUrl(fileRef({
      fileId: 'uploaded_image',
      resource: undefined,
    }), {
      connection: remoteConnection,
      platform,
    })).toThrow('remote file ref requires resource content link');

    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('rejects malformed local-ish device credentials instead of using the local file bridge', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    expect(() => resolveFileRefUrl(fileRef({
      fileId: 'uploaded_image',
      resource: undefined,
    }), {
      connection: malformedLocalishConnection,
      platform,
    })).toThrow('remote file ref requires resource content link');

    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('does not synthesize session-file resource URLs for malformed local-ish device credentials', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    expect(() => resolveFileRefUrl(fileRef({
      fileId: 'sf_uploaded_image',
      resource: undefined,
    }), {
      connection: malformedLocalishConnection,
      platform,
    })).toThrow('remote file ref requires resource content link');

    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('rejects malformed local-ish non-loopback URLs instead of using the local file bridge', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    expect(() => resolveFileRefUrl(fileRef({
      fileId: 'uploaded_image',
      resource: undefined,
    }), {
      connection: nonLoopbackLocalishConnection,
      platform,
    })).toThrow('remote file ref requires resource content link');

    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('uses the resource content URL for a remote connection instead of exposing local paths', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    const result = resolveFileRefUrl(fileRef({ version: { mtimeMs: 11, size: 22 } }), {
      connection: remoteConnection,
      platform,
    });

    expect(result).toEqual({
      mode: 'resource-content',
      url: 'https://hana.example/api/resources/res_sf_asset/content?v=11-22',
    });
    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('synthesizes a session-file resource URL for older remote refs that only have fileId', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    const result = resolveFileRefUrl(fileRef({
      fileId: 'sf_uploaded_image',
      resource: undefined,
      version: { mtimeMs: 11, size: 22 },
    }), {
      connection: remoteConnection,
      platform,
    });

    expect(result).toEqual({
      mode: 'resource-content',
      url: 'https://hana.example/api/resources/res_sf_uploaded_image/content?v=11-22',
    });
    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('does not synthesize a resource URL for non-session-file ids', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    expect(() => resolveFileRefUrl(fileRef({
      fileId: 'uploaded_image',
      resource: undefined,
    }), {
      connection: remoteConnection,
      platform,
    })).toThrow('remote file ref requires resource content link');
    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('can resolve a resource URL without a desktop platform bridge', () => {
    const result = resolveFileRefUrl(fileRef({ path: '' }), {
      connection: remoteConnection,
      platform: null,
    });

    expect(result.mode).toBe('resource-content');
    expect(result.url).toBe('https://hana.example/api/resources/res_sf_asset/content');
  });

  it('uses inline data only when there is no path or resource content link', () => {
    const result = resolveFileRefUrl(fileRef({
      path: '',
      resource: undefined,
      inlineData: { mimeType: 'image/png', base64: 'ABC' },
    }), {
      connection: remoteConnection,
      platform: null,
    });

    expect(result).toEqual({
      mode: 'inline-data',
      url: 'data:image/png;base64,ABC',
    });
  });
});
