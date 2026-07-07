/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState: Record<string, any> = {};

vi.mock('../../stores', () => ({
  useStore: (selector?: (state: Record<string, any>) => unknown) =>
    selector ? selector(mockState) : mockState,
}));

vi.mock('../../bootstrap', () => ({
  initTheme: vi.fn(),
  initDragPrevention: vi.fn(),
}));

vi.mock('../../app-init', () => ({
  initApp: vi.fn(async () => {}),
}));

vi.mock('../../hooks/use-sidebar-resize', () => ({
  useSidebarResize: vi.fn(),
}));

vi.mock('../../components/FloatSidebar', () => ({
  FloatSidebar: () => <div data-testid="float-sidebar" />,
  useFloatSidebar: () => ({
    side: 'left',
    show: vi.fn(),
    scheduleHide: vi.fn(),
    cancelHide: vi.fn(),
    hide: vi.fn(),
  }),
}));

vi.mock('../../components/SidebarLayout', () => ({
  SidebarLayout: () => <div data-testid="sidebar-layout" />,
  toggleSidebar: vi.fn(),
}));

vi.mock('../../components/ChannelsPanel', () => ({ ChannelsPanel: () => <div data-testid="channels-panel" /> }));
vi.mock('../../components/channels/ChannelCreateOverlay', () => ({ ChannelCreateOverlay: () => null }));
vi.mock('../../components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../components/RegionalErrorBoundary', () => ({ RegionalErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../components/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('../../components/InputContextMenu', () => ({ InputContextMenu: () => null }));
vi.mock('../../components/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../../components/LeavesOverlay', () => ({ LeavesOverlay: () => null }));
vi.mock('../../components/selection/SelectionQuoteActionSurface', () => ({ SelectionQuoteActionSurface: () => null }));
vi.mock('../../components/shared/MediaViewer/MediaViewer', () => ({ MediaViewer: () => null }));
vi.mock('../../components/SettingsModalShell', () => ({ SettingsModalShell: () => null }));
vi.mock('../../components/SkillViewerOverlay', () => ({ SkillViewerOverlay: () => null }));
vi.mock('../../stores/session-actions', () => ({ createNewSession: vi.fn() }));
vi.mock('../../stores/desk-actions', () => ({ toggleJianSidebar: vi.fn() }));
vi.mock('../../stores/settings-modal-actions', () => ({ openSettingsModal: vi.fn() }));
vi.mock('../../components/app/AppTitlebar', () => ({ AppTitlebar: () => <div data-testid="titlebar" /> }));
vi.mock('../../components/app/ChatSidebar', () => ({ ChatSidebar: () => <div data-testid="chat-sidebar" /> }));
vi.mock('../../components/app/AppPages', () => ({ AppPages: () => <div data-testid="app-pages" /> }));
vi.mock('../../components/app/RemoteConnectionRecovery', () => ({
  RemoteConnectionRecovery: () => <div data-testid="remote-recovery" />,
}));

describe('App remote recovery gate', () => {
  beforeEach(() => {
    vi.stubGlobal('t', (key: string) => key);
    Object.assign(window, { platform: { appReady: vi.fn() } });
    Object.assign(mockState, {
      locale: 'en',
      sidebarOpen: true,
      jianOpen: false,
      currentTab: 'chat',
      connected: false,
      statusKey: 'status.serverNotReady',
      statusVars: {},
      activeServerConnectionId: 'lan:node_lan:studio_lan',
      activeServerConnection: {
        connectionId: 'lan:node_lan:studio_lan',
      },
      remoteConnectionRecovery: {
        status: 'compatibility_failed',
        connectionId: 'lan:node_lan:studio_lan',
        baseUrl: 'http://192.168.31.75:14500',
        reasonCodes: ['missing_core_capability'],
        warningCodes: [],
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Object.keys(mockState).forEach(key => delete mockState[key]);
  });

  it('renders only the recovery surface inside the app body during active remote recovery', async () => {
    const { default: App } = await import('../../App');

    render(<App />);

    expect(screen.getByTestId('remote-recovery')).toBeInTheDocument();
    expect(screen.queryByTestId('app-pages')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-sidebar')).not.toBeInTheDocument();
  });
});
