// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsContent } from '../SettingsContent';
import { useSettingsStore } from '../store';
import { assessRemoteServer } from '../../../../../shared/remote-server-assessment';

const { mockSettingsHanaFetch } = vi.hoisted(() => ({
  mockSettingsHanaFetch: vi.fn(async (url: string) => {
    if (url === '/api/config') return new Response(JSON.stringify({ locale: 'zh-CN' }));
    if (url === '/api/server/identity') return new Response(JSON.stringify({
      connectionKind: 'lan',
      serverId: 'server_lan',
      serverNodeId: 'node_lan',
      studioId: 'studio_lan',
      label: 'LAN Studio',
      capabilities: ['chat'],
      executionBoundary: {
        schemaVersion: 1,
        boundaryId: 'remote',
        kind: 'remote_process',
        serverNodeId: 'node_lan',
        studioId: 'studio_lan',
        workbench: { kind: 'server_managed', root: null },
      },
      version: '0.346.18',
    }));
    return new Response(JSON.stringify({ experiments: [] }));
  }),
}));

vi.mock('../actions', () => ({
  loadAgents: vi.fn(async () => {}),
  loadAvatars: vi.fn(async () => {}),
  loadSettingsConfig: vi.fn(async () => {}),
  loadSettingsSnapshot: vi.fn(async () => {}),
  loadPluginSettings: vi.fn(async () => {}),
  updateSettingsSnapshot: vi.fn(),
}));

vi.mock('../api', () => ({
  hanaFetch: mockSettingsHanaFetch,
}));

describe('SettingsContent tab heading', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    window.i18n = {
      locale: 'zh-CN',
      defaultName: 'Hana',
      _data: {},
      _agentOverrides: {},
      load: vi.fn(async () => {}),
      setAgentOverrides: vi.fn(),
      t: ((key: string) => key) as typeof window.t,
    };
    window.platform = {
      getServerPort: vi.fn(async () => 3000),
      getServerToken: vi.fn(async () => null),
      getPlatform: vi.fn(async () => 'darwin'),
      onSwitchTab: vi.fn(),
      onSettingsChanged: vi.fn(),
      onServerRestarted: vi.fn(),
    } as unknown as typeof window.platform;
    window.localStorage.clear();
    mockSettingsHanaFetch.mockClear();
    useSettingsStore.setState({
      activeTab: 'experiments',
      platformName: 'darwin',
      pluginSettingsTabs: [],
      ready: true,
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('renders experiment copy as a tab-level description', async () => {
    render(React.createElement(SettingsContent, { variant: 'window' }));

    const description = screen.getByText('settings.experiments.description');
    expect(description.tagName).toBe('P');

    await waitFor(() => {
      expect(screen.getByText('settings.experiments.empty')).toBeTruthy();
    });
  });

  it('renders the built-in browser settings tab', async () => {
    useSettingsStore.setState({
      activeTab: 'browser',
      platformName: 'darwin',
      pluginSettingsTabs: [],
      ready: true,
      settingsSnapshot: {
        status: 'ready',
        key: 'snapshot:browser',
        requestId: 1,
        data: {
          agentId: 'hana',
          config: {},
          identity: '',
          ishiki: '',
          publicIshiki: '',
          userProfile: '',
          experience: '',
          pinned: { pins: [] },
          globalModels: {},
          preferences: {
            quickChat: {},
            notifications: {},
            bridge: { permissionMode: 'auto', readOnly: false, receiptEnabled: true },
            speechRecognition: {},
            experiments: [],
            browser: { acceptCookies: true, agentOpenBehavior: 'smart' },
          },
          plugins: {
            allowFullAccess: false,
            devToolsEnabled: false,
            userDir: '',
            settingsTabs: [],
          },
        },
      },
    } as never);

    render(React.createElement(SettingsContent, { variant: 'window' }));

    expect(screen.getAllByText('settings.tabs.browser').length).toBeGreaterThan(0);
    expect(screen.getByText('settings.browser.acceptCookies')).toBeTruthy();
    expect(screen.getByText('settings.browser.clearCookies')).toBeTruthy();
    expect(screen.getByText('settings.browser.agentOpenBehavior')).toBeTruthy();
  });

  it('independently refreshes remote identity and release evidence in the settings renderer', async () => {
    const { writePersistedServerConnectionState } = await import('../../services/server-connection');
    writePersistedServerConnectionState({
      serverConnections: {
        'lan:node_lan:studio_lan': {
          connectionId: 'lan:node_lan:studio_lan',
          kind: 'lan',
          serverId: 'server_lan',
          serverNodeId: 'node_lan',
          studioId: 'studio_lan',
          label: 'LAN Studio',
          baseUrl: 'http://192.168.31.75:14500',
          wsUrl: 'ws://192.168.31.75:14500',
          token: 'device-token',
          authState: 'paired',
          trustState: 'lan',
          credentialKind: 'device_credential',
          capabilities: ['chat'],
        },
      },
      activeServerConnectionId: 'lan:node_lan:studio_lan',
    });
    const checkRemoteServerRelease = vi.fn(async () => ({
      status: 'unavailable' as const,
      checkedAt: '2026-07-18T12:00:00.000Z',
      source: 'none' as const,
      stale: false,
      release: null,
      errorCode: 'offline',
      reasonCodes: ['offline'],
    }));
    window.hana = { checkRemoteServerRelease } as unknown as typeof window.hana;

    render(React.createElement(SettingsContent, { variant: 'window' }));

    await waitFor(() => expect(mockSettingsHanaFetch).toHaveBeenCalledWith('/api/server/identity'));
    await waitFor(() => expect(checkRemoteServerRelease).toHaveBeenCalled());
    await waitFor(() => expect(useSettingsStore.getState().remoteServerAssessment).toEqual(expect.objectContaining({
      connectionId: 'lan:node_lan:studio_lan',
      core: expect.objectContaining({ status: 'ready' }),
    })));
  });

  it('clears a selected assessment when settings switches connection or returns local', () => {
    const remote = {
      connectionId: 'lan:first',
      kind: 'lan' as const,
      serverId: 'first',
      studioId: 'default',
      label: 'First',
      baseUrl: 'http://first.test:14500',
      wsUrl: 'ws://first.test:14500',
      token: 'device-token',
      authState: 'paired' as const,
      trustState: 'lan' as const,
      credentialKind: 'device_credential' as const,
      capabilities: ['chat'],
    };
    const assessment = assessRemoteServer({
      connectionId: remote.connectionId,
      boundary: { status: 'assessed', ok: true, reasonCodes: [], warningCodes: [] },
      server: { connectionKind: 'lan', runtimeVersion: '0.346.18' },
    });
    useSettingsStore.setState({
      serverConnections: { [remote.connectionId]: remote },
      activeServerConnectionId: remote.connectionId,
      activeServerConnection: remote,
      remoteServerAssessment: assessment,
    });

    useSettingsStore.getState().set({
      activeServerConnectionId: 'lan:second',
      activeServerConnection: { ...remote, connectionId: 'lan:second' },
    });
    expect(useSettingsStore.getState().remoteServerAssessment).toBeNull();

    useSettingsStore.setState({ remoteServerAssessment: assessment });
    useSettingsStore.getState().set({
      activeServerConnectionId: 'local',
      activeServerConnection: {
        ...remote,
        connectionId: 'local',
        kind: 'local',
        serverId: 'local',
        studioId: 'local',
        baseUrl: 'http://127.0.0.1:3000',
        wsUrl: 'ws://127.0.0.1:3000',
        token: 'local-token',
        trustState: 'local',
        credentialKind: 'loopback_token',
      },
    });
    expect(useSettingsStore.getState().remoteServerAssessment).toBeNull();
  });
});
