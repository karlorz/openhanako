// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { SkillViewerOverlay } from '../../components/SkillViewerOverlay';

const fetchMock = vi.fn();
vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (...args: unknown[]) => fetchMock(...args),
}));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function plainErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

describe('SkillViewerOverlay', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    const remoteConnection = {
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
      capabilities: ['chat', 'settings.read'],
    };
    useStore.setState({
      skillViewerData: {
        name: 'remote-skill',
        baseDir: '/opt/hanaagent/skills/remote-skill',
        filePath: '/opt/hanaagent/skills/remote-skill/SKILL.md',
        installed: true,
      },
      serverConnections: { [remoteConnection.connectionId]: remoteConnection },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
    } as never);
    window.hana = {
      listSkillFiles: vi.fn(async () => []),
      readSkillFile: vi.fn(async () => null),
    } as unknown as typeof window.hana;
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
    } as unknown as typeof window.platform;
    window.t = ((key: string) => key) as typeof window.t;
    (globalThis as unknown as { t: typeof window.t }).t = window.t;
  });

  afterEach(() => {
    cleanup();
    useStore.setState({ skillViewerData: null } as never);
    delete (window as unknown as { hana?: unknown }).hana;
    delete (window as unknown as { platform?: unknown }).platform;
    delete (globalThis as unknown as { t?: unknown }).t;
  });

  it('loads installed remote skill files from the active server instead of local Electron IPC', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/skills/remote-skill/files')) {
        return Promise.resolve(jsonResponse({
          files: [{ name: 'SKILL.md', path: 'SKILL.md', isDir: false }],
        }));
      }
      if (url.includes('/api/skills/remote-skill/file')) {
        return Promise.resolve(jsonResponse({
          path: 'SKILL.md',
          content: '---\ndescription: Remote preview\n---\n# Remote Body\n',
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillViewerOverlay />);

    expect(await screen.findByText('Remote Body')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/skills/remote-skill/files'),
      expect.objectContaining({ throwOnHttpError: false }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/skills/remote-skill/file'),
      expect.objectContaining({ throwOnHttpError: false }),
    );
    await waitFor(() => {
      expect(window.hana?.listSkillFiles).not.toHaveBeenCalled();
      expect(window.hana?.readSkillFile).not.toHaveBeenCalled();
    });
  });

  it('shows a clear unsupported-server message when remote preview endpoints are missing', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/skills/remote-skill/files')) {
        return Promise.resolve(plainErrorResponse(404, 'Not Found'));
      }
      if (url.includes('/api/skills/remote-skill/file')) {
        return Promise.resolve(plainErrorResponse(404, 'Not Found'));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<SkillViewerOverlay />);

    expect(await screen.findByText('skillViewer.remotePreviewUnsupported')).toBeInTheDocument();
    await waitFor(() => {
      expect(window.hana?.listSkillFiles).not.toHaveBeenCalled();
      expect(window.hana?.readSkillFile).not.toHaveBeenCalled();
    });
  });
});
