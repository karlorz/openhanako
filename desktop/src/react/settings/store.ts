/**
 * Settings window Zustand store
 * 独立于主窗口 store，设置窗口有自己的 BrowserWindow + JS context
 */
import { create } from 'zustand';
import { assessRemoteServer, type RemoteServerAssessment } from '../../../../shared/remote-server-assessment';
import type { RemoteConnectionRecoveryState } from '../stores/connection-slice';
import { isLocalOwnerConnection, type ServerConnection, type ServerConnectionRegistry } from '../services/server-connection';
import { createRemoteServerAssessmentCoordinator } from '../services/remote-server-assessment-coordinator';
import { writeRemoteServerAssessment } from '../services/remote-server-assessment-cache';
import { createRemoteResource, type RemoteResource, type RemoteResourceStatus } from './resource-state';
import { hanaFetch } from './api';

export interface Agent {
  id: string;
  name: string;
  yuan: string;
  isPrimary: boolean;
  hasAvatar?: boolean;
  avatarRevision?: string | null;
  memoryMasterEnabled?: boolean;
}

export interface SkillInfo {
  name: string;
  description?: string;
  enabled: boolean;
  hidden?: boolean;
  baseDir?: string;
  filePath?: string;
  source?: string;
  externalLabel?: string | null;
  externalPath?: string | null;
  readonly?: boolean;
  managedBy?: string | null;
  configurable?: boolean;
  deletable?: boolean;
}

export interface ProviderSummary {
  type: 'api-key' | 'oauth';
  auth_type: 'api-key' | 'oauth' | 'none' | 'optional';
  display_name: string;
  base_url: string;
  api: string;
  api_key: string;
  headers?: Record<string, string>;
  models: (string | { id: string; [key: string]: any })[];
  custom_models: string[];
  has_credentials: boolean;
  logged_in?: boolean;
  supports_oauth: boolean;
  is_coding_plan?: boolean;
  is_configured?: boolean;
  can_delete: boolean;
  config_status?: 'ok' | 'needs_setup' | 'invalid';
  config_error?: string | null;
  missing_fields?: string[];
}

export interface SettingsSnapshot {
  agentId: string;
  config: Record<string, any>;
  identity: string;
  agents: string;
  publicAgents: string;
  userProfile: string;
  experience: string;
  pinned: { pins: string[] };
  globalModels: Record<string, any>;
  preferences: {
    quickChat: Record<string, any>;
    browser: Record<string, any>;
    notifications: Record<string, any>;
    bridge: {
      permissionMode: 'auto' | 'operate' | 'read_only';
      readOnly: boolean;
      receiptEnabled: boolean;
      richStreamingEnabled: boolean;
    };
    computerUse?: {
      selectedProviderId?: string | null;
      status?: Record<string, any> | null;
      settings?: Record<string, any>;
    };
    imageGeneration?: Record<string, any>;
    speechRecognition: Record<string, any>;
    experiments: any[];
  };
  access?: Record<string, any> | null;
  bridgeStatus?: Record<string, any> | null;
  plugins: {
    allowFullAccess: boolean;
    devToolsEnabled: boolean;
    userDir: string;
  };
}

export interface SettingsState {
  // connection
  serverPort: number | null;
  serverToken: string | null;
  serverConnections: ServerConnectionRegistry;
  activeServerConnectionId: string | null;
  activeServerConnection: ServerConnection | null;
  remoteConnectionRecovery: RemoteConnectionRecoveryState | null;
  remoteServerAssessment: RemoteServerAssessment | null;

  // agents
  agents: Agent[];
  currentAgentId: string | null;
  settingsAgentId: string | null;
  agentName: string;
  userName: string;
  agentYuan: string;
  agentAvatarUrl: string | null;
  userAvatarUrl: string | null;

  // config
  settingsConfig: Record<string, any> | null;
  settingsConfigKey: string | null;
  settingsConfigStatus: RemoteResourceStatus;
  settingsConfigError: string | null;
  settingsSnapshot: RemoteResource<SettingsSnapshot>;
  globalModelsConfig: Record<string, any> | null;
  homeFolder: string | null;

  // ui
  activeTab: string;
  platformName: string | null;
  ready: boolean;

  // pins
  currentPins: string[];

  // providers (unified)
  providersSummary: Record<string, ProviderSummary>;
  selectedProviderId: string | null;

  // plugins
  pluginSettingsStatus: RemoteResourceStatus;
  pluginSettingsError: string | null;
  pluginAllowFullAccess: boolean | undefined;
  pluginDevToolsEnabled: boolean | undefined;
  pluginUserDir: string;

  // toast
  toastMessage: string;
  toastType: 'success' | 'error' | '';
  toastVisible: boolean;
}

export interface SettingsActions {
  set: (partial: Partial<SettingsState>) => void;
  getSettingsAgentId: () => string | null;
  showToast: (message: string, type: 'success' | 'error') => void;
  refreshRemoteServerAssessment: (options?: { force?: boolean }) => Promise<void>;
  clearRemoteServerAssessment: () => void;
}

export type SettingsStore = SettingsState & SettingsActions;

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  // connection
  serverPort: null,
  serverToken: null,
  serverConnections: {},
  activeServerConnectionId: null,
  activeServerConnection: null,
  remoteConnectionRecovery: null,
  remoteServerAssessment: null,

  // agents
  agents: [],
  currentAgentId: null,
  settingsAgentId: null,
  agentName: 'Hanako',
  userName: 'User',
  agentYuan: 'hanako',
  agentAvatarUrl: null,
  userAvatarUrl: null,

  // config
  settingsConfig: null,
  settingsConfigKey: null,
  settingsConfigStatus: 'idle',
  settingsConfigError: null,
  settingsSnapshot: createRemoteResource<SettingsSnapshot>(),
  globalModelsConfig: null,
  homeFolder: null,

  // ui
  activeTab: 'agent',
  platformName: null,
  ready: false,

  // pins
  currentPins: [],

  // providers (unified)
  providersSummary: {},
  selectedProviderId: null,

  // plugins
  pluginSettingsStatus: 'idle',
  pluginSettingsError: null,
  pluginAllowFullAccess: undefined,
  pluginDevToolsEnabled: undefined,
  pluginUserDir: '',

  // toast
  toastMessage: '',
  toastType: '',
  toastVisible: false,

  // actions
  set: (partial) => set((state) => {
    const next = { ...partial };
    if ('activeServerConnection' in partial || 'activeServerConnectionId' in partial) {
      const activeConnection = 'activeServerConnection' in partial
        ? partial.activeServerConnection
        : state.activeServerConnection;
      const activeConnectionId = 'activeServerConnectionId' in partial
        ? partial.activeServerConnectionId
        : activeConnection?.connectionId ?? null;
      const assessment = partial.remoteServerAssessment ?? state.remoteServerAssessment;
      if (!activeConnection || isLocalOwnerConnection(activeConnection)
          || assessment?.connectionId !== activeConnectionId) {
        next.remoteServerAssessment = null;
      }
    }
    return next;
  }),

  getSettingsAgentId: () => {
    const { settingsAgentId, currentAgentId } = get();
    return settingsAgentId || currentAgentId;
  },

  showToast: (message, type) => {
    if (_toastTimer) clearTimeout(_toastTimer);
    set({ toastMessage: message, toastType: type, toastVisible: true });
    _toastTimer = setTimeout(() => {
      set({ toastVisible: false });
    }, 1500);
  },

  refreshRemoteServerAssessment: async (options) => {
    const connection = get().activeServerConnection;
    if (!connection) {
      set({ remoteServerAssessment: null });
      return;
    }
    await settingsAssessmentCoordinator.assessConnection(connection, options);
  },

  clearRemoteServerAssessment: () => {
    const connectionId = get().activeServerConnectionId;
    settingsAssessmentCoordinator.invalidate(connectionId ?? undefined);
    set({ remoteServerAssessment: null });
  },
}));

const settingsAssessmentCoordinator = createRemoteServerAssessmentCoordinator({
  getActiveConnectionId: () => useSettingsStore.getState().activeServerConnectionId,
  fetchIdentity: async () => {
    const response = await hanaFetch('/api/server/identity');
    return response.json();
  },
  loadRelease: async (options) => {
    if (typeof window.hana?.checkRemoteServerRelease !== 'function') {
      throw new Error('remote server release bridge unavailable');
    }
    return window.hana.checkRemoteServerRelease(options);
  },
  evaluate: assessRemoteServer,
  applyAssessment: (remoteServerAssessment) => useSettingsStore.setState({ remoteServerAssessment }),
  persistAssessment: writeRemoteServerAssessment,
  now: () => new Date(),
});
