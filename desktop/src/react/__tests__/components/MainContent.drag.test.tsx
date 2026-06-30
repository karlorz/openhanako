// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { MainContent } from '../../MainContent';
import { SkillsPanel } from '../../components/SkillsPanel';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../components/BrowserCard', () => ({ BrowserCard: () => null }));
vi.mock('../../components/ComputerUseOverlay', () => ({ ComputerUseOverlay: () => null }));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function fileDataTransfer(files: File[] = []) {
  return {
    files,
    types: ['Files'],
    getData: vi.fn(() => ''),
  };
}

describe('MainContent app file drag attachments', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    vi.mocked(hanaFetch).mockReset();
    window.platform = {
      getFilePath: vi.fn((file: File) => `/tmp/${file.name}`),
    } as unknown as typeof window.platform;
    useStore.setState({
      currentSessionPath: '/sessions/main.jsonl',
      currentTab: 'chat',
      welcomeVisible: false,
      activePanel: null,
      currentAgentId: 'agent-a',
      agentName: 'Hana',
      agentYuan: 'hanako',
      agents: [{ id: 'agent-a', name: 'Hana', yuan: 'hanako', isPrimary: true }],
      attachedFiles: [],
      attachedFilesBySession: {},
      sessionRegistryFilesByPath: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('ends the global drag lifecycle when SkillsPanel exclusively consumes the nested drop', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (url: string) => {
      if (url.includes('/api/skills/install')) {
        return jsonResponse({ ok: true, skill: { name: 'nested-skill' } });
      }
      if (url.includes('/api/skills/bundles')) return jsonResponse({ bundles: [] });
      if (url.includes('/api/skills?')) return jsonResponse({ skills: [] });
      return jsonResponse({});
    });
    useStore.setState({ activePanel: 'skills' } as never);

    const { container } = render(
      <MainContent>
        <SkillsPanel />
      </MainContent>,
    );
    const root = container.querySelector('.main-content');
    const overlay = container.querySelector('.drop-overlay');
    expect(root).toBeTruthy();
    expect(overlay).toBeTruthy();
    await screen.findByTestId('skills-panel-drop-surface');

    const file = new File(['skill'], 'nested.skill');
    const dataTransfer = fileDataTransfer([file]);
    fireEvent.dragEnter(root!, { dataTransfer });
    expect(overlay).toHaveClass('visible');

    fireEvent.drop(screen.getByTestId('skills-panel-drop-surface'), { dataTransfer });

    await waitFor(() => expect(vi.mocked(hanaFetch).mock.calls.filter(([url]) =>
      String(url).includes('/api/skills/install')
    )).toHaveLength(1));
    expect(overlay).not.toHaveClass('visible');
    expect(useStore.getState().attachedFiles).toEqual([]);
    expect(vi.mocked(hanaFetch).mock.calls.some(([url]) => url === '/api/upload')).toBe(false);
  });

  it('keeps an ordinary root drop on the chat attachment path exactly once', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (url: string) => {
      if (url === '/api/upload') {
        return jsonResponse({
          uploads: [{ src: '/tmp/report.txt', dest: '/uploads/report.txt', name: 'report.txt' }],
        });
      }
      return jsonResponse({});
    });
    const { container } = render(<MainContent><div>chat</div></MainContent>);
    const root = container.querySelector('.main-content');
    const overlay = container.querySelector('.drop-overlay');
    const file = new File(['report'], 'report.txt');
    const dataTransfer = fileDataTransfer([file]);

    fireEvent.dragEnter(root!, { dataTransfer });
    fireEvent.drop(root!, { dataTransfer });

    await waitFor(() => expect(useStore.getState().attachedFiles).toEqual([{
      path: '/uploads/report.txt',
      name: 'report.txt',
      isDirectory: false,
      waveform: undefined,
    }]));
    expect(vi.mocked(hanaFetch).mock.calls.filter(([url]) => url === '/api/upload')).toHaveLength(1);
    expect(overlay).not.toHaveClass('visible');
  });

  it('clamps unmatched dragleave events and resets on dragend cancellation', () => {
    const { container } = render(<MainContent><div>chat</div></MainContent>);
    const root = container.querySelector('.main-content');
    const overlay = container.querySelector('.drop-overlay');
    const dataTransfer = fileDataTransfer();

    fireEvent.dragLeave(root!, { dataTransfer });
    fireEvent.dragLeave(root!, { dataTransfer });
    fireEvent.dragEnter(root!, { dataTransfer });
    expect(overlay).toHaveClass('visible');

    fireEvent.drop(window, { dataTransfer });
    expect(overlay).not.toHaveClass('visible');

    fireEvent.dragEnter(root!, { dataTransfer });
    expect(overlay).toHaveClass('visible');
    fireEvent.dragEnd(window, { dataTransfer });
    expect(overlay).not.toHaveClass('visible');

    fireEvent.dragEnter(root!, { dataTransfer });
    expect(overlay).toHaveClass('visible');
    fireEvent.blur(window);
    expect(overlay).not.toHaveClass('visible');
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

  it('uploads dropped .skill package bytes for remote connections instead of installing by macOS path', async () => {
    const readFileBase64 = vi.fn(async () => 'SKILL_BASE64');
    window.platform = { readFileBase64 } as unknown as typeof window.platform;
    useStore.setState({
      currentAgentId: 'agent-a',
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
          capabilities: ['chat', 'settings.write'],
        },
      },
      activeServerConnectionId: 'lan:node:studio',
      addToast: vi.fn(),
    } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      json: async () => ({ ok: true, skill: { name: 'remote-skill' } }),
    } as Response);

    const { attachFilesFromPaths } = await import('../../MainContent');

    await attachFilesFromPaths(['/Users/me/Desktop/remote-skill.skill']);

    await vi.waitFor(() => expect(hanaFetch).toHaveBeenCalledWith(
      '/api/skills/install?agentId=agent-a',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(readFileBase64).toHaveBeenCalledWith('/Users/me/Desktop/remote-skill.skill');
    const body = JSON.parse(String(vi.mocked(hanaFetch).mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      file: {
        filename: 'remote-skill.skill',
        contentBase64: 'SKILL_BASE64',
      },
      sessionPath: '/sessions/main.jsonl',
    });
    expect(body.path).toBeUndefined();
  });
});
