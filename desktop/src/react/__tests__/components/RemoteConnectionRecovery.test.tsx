/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const mockConnectDeviceServerConnection = vi.hoisted(() => vi.fn());

vi.mock('../../services/server-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/server-connection')>();
  return {
    ...actual,
    connectDeviceServerConnection: mockConnectDeviceServerConnection,
  };
});

const localConnection = {
  connectionId: 'local',
  kind: 'local',
  serverId: 'local',
  studioId: 'local',
  label: 'Local Hana',
  baseUrl: 'http://127.0.0.1:14500',
  wsUrl: 'ws://127.0.0.1:14500',
  token: 'local-token',
  authState: 'paired',
  trustState: 'local',
  credentialKind: 'loopback_token',
  platformAccountId: null,
  officialServiceKind: null,
  capabilities: ['chat', 'resources', 'files', 'tools'],
};

const remoteConnection = {
  ...localConnection,
  connectionId: 'lan:node_lan:studio_lan',
  kind: 'lan',
  serverId: 'server_lan',
  serverNodeId: 'node_lan',
  studioId: 'studio_lan',
  label: 'LAN Studio',
  baseUrl: 'http://192.168.31.75:14500',
  wsUrl: 'ws://192.168.31.75:14500',
  token: 'fixture-key',
  trustState: 'lan',
  credentialKind: 'device_credential',
};

describe('RemoteConnectionRecovery', () => {
  beforeEach(() => {
    const copy: Record<string, string> = {
      'app.remoteRecovery.title': 'Remote Server needs attention',
      'app.remoteRecovery.subtitle': 'The saved Remote Server stayed selected, but this app could not finish compatibility checks.',
      'app.remoteRecovery.serverUrl': 'Server URL',
      'app.remoteRecovery.accessKey': 'Access key',
      'app.remoteRecovery.retryRemote': 'Retry remote',
      'app.remoteRecovery.switchLocal': 'Switch to local',
      'app.remoteRecovery.status.compatibility_failed': 'Compatibility check failed',
      'settings.access.remoteReason.missing_core_capability': 'Required chat capability is missing',
      'settings.access.remoteWarning.missing_optional_capability': 'Some optional Remote Server capabilities are unavailable',
      'settings.api.showKey': 'Show',
    };
    vi.stubGlobal('t', (key: string) => copy[key] || key);
    Object.assign(window, {
      hana: { reloadMainWindow: vi.fn(async () => {}) },
    });
    mockConnectDeviceServerConnection.mockReset();
    useStore.setState({
      serverConnections: {
        local: localConnection,
        [remoteConnection.connectionId]: remoteConnection,
      },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
      remoteConnectionRecovery: {
        status: 'compatibility_failed',
        connectionId: remoteConnection.connectionId,
        baseUrl: remoteConnection.baseUrl,
        reasonCodes: ['missing_core_capability'],
        warningCodes: ['missing_optional_capability'],
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useStore.setState({
      serverConnections: {},
      activeServerConnectionId: null,
      activeServerConnection: null,
      remoteConnectionRecovery: null,
    } as never);
  });

  it('renders retry fields with masked access key and can switch to local', async () => {
    const { RemoteConnectionRecovery } = await import('../../components/app/RemoteConnectionRecovery');

    render(<RemoteConnectionRecovery />);

    expect(screen.getByText('Remote Server needs attention')).toBeInTheDocument();
    expect(screen.getByText('Compatibility check failed')).toBeInTheDocument();
    expect(screen.queryByText('app.remoteRecovery.title')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('http://192.168.31.75:14500')).toBeInTheDocument();
    const key = screen.getByLabelText('Access key');
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveValue('fixture-key');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(key).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to local' }));

    expect(useStore.getState().activeServerConnectionId).toBe('local');
    expect(useStore.getState().remoteConnectionRecovery).toBeNull();
    expect(window.hana.reloadMainWindow).toHaveBeenCalledTimes(1);
  });

  it('retries the Remote Server with edited URL and key', async () => {
    const retried = {
      ...remoteConnection,
      connectionId: 'lan:node_lan:studio_other',
      baseUrl: 'http://192.168.31.80:14500',
      token: 'edited-key',
    };
    mockConnectDeviceServerConnection.mockResolvedValueOnce(retried);
    const { RemoteConnectionRecovery } = await import('../../components/app/RemoteConnectionRecovery');

    render(<RemoteConnectionRecovery />);

    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'http://192.168.31.80:14500' },
    });
    fireEvent.change(screen.getByLabelText('Access key'), {
      target: { value: 'edited-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry remote' }));

    await waitFor(() => {
      expect(mockConnectDeviceServerConnection).toHaveBeenCalledWith({
        baseUrl: 'http://192.168.31.80:14500',
        credential: 'edited-key',
      });
    });
    expect(useStore.getState().activeServerConnectionId).toBe(retried.connectionId);
    expect(useStore.getState().remoteConnectionRecovery).toBeNull();
    expect(window.hana.reloadMainWindow).toHaveBeenCalledTimes(1);
  });

  it('masks a replacement key after the revealed key value changes', async () => {
    const { RemoteConnectionRecovery } = await import('../../components/app/RemoteConnectionRecovery');

    const { rerender } = render(<RemoteConnectionRecovery />);

    const key = screen.getByLabelText('Access key');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(key).toHaveAttribute('type', 'text');

    useStore.setState({
      activeServerConnection: {
        ...remoteConnection,
        token: 'replacement-key',
      },
    } as never);
    rerender(<RemoteConnectionRecovery />);

    expect(screen.getByLabelText('Access key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Access key')).toHaveValue('replacement-key');
  });
});
