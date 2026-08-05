/**
 * Marketplace catalog payload types shared by the marketplace tab, its data
 * hook, its actions hook, and the plugin inspector component.
 */
import type { MarketplaceSourceRow } from './components/MarketplaceSourcesPanel';

export interface MarketplacePlugin {
  id: string;
  name: string;
  publisher?: string;
  version?: string;
  description?: string;
  trust?: 'restricted' | 'full-access';
  permissions?: string[];
  contributions?: string[];
  repository?: string | null;
  compatibility?: { minAppVersion?: string; hanaApi?: string };
  distribution?: { kind?: 'source' | 'release'; path?: string; packageUrl?: string; sha256?: string } | null;
  installed?: boolean;
  installedVersion?: string | null;
  latestVersion?: string | null;
  selectedVersion?: string | null;
  updateAvailable?: boolean;
  downgrade?: boolean;
  reinstall?: boolean;
  compatible?: boolean;
  canInstall?: boolean;
  installAction?: 'install' | 'update' | 'downgrade' | 'reinstall' | 'incompatible';
  /** Multi-source composite fields (Approach 1). */
  marketplaceId?: string;
  compositeKey?: string;
  sourceAuthority?: 'official' | 'custom' | 'legacy' | 'removed';
  sourceStatus?: string;
  sourceEnabled?: boolean;
  sourceSnapshot?: {
    state?: string;
    sourceFingerprint?: string | null;
    catalogSha256?: string | null;
    requestedRef?: string | null;
    resolvedRevision?: string | null;
  } | null;
  available?: boolean;
  active?: boolean;
  retained?: boolean;
  catalogFormat?: string | null;
  installTarget?: string | null;
  installAdapter?: string | null;
  installable?: boolean;
  confirmationLevel?: 'inline' | 'capability-review' | 'typed-exact' | string | null;
  capabilityInventory?: {
    skills?: string[];
    nativePluginContributions?: string[];
    agentFacing?: string[];
    serverImpact?: string[];
    unsupportedClaudeComponents?: string[];
  } | null;
  warnings?: string[];
  installPlan?: {
    action?: string;
    destination?: string;
    installAdapter?: string;
    confirmationLevel?: string;
    warnings?: string[];
    installable?: boolean;
  } | null;
  runtimeActivation?: { state?: string; reason?: string | null; enabled?: boolean } | null;
  marketplaceSkillActivations?: Array<{ identity?: string; state?: string; reason?: string | null; enabled?: boolean }>;
  packageInstall?: {
    state: 'not-installed' | 'installed' | 'partial' | 'stale-record';
    recorded: string[];
    present: string[];
    missing: string[];
    invalid?: string[];
  };
  /** Package-level skill-manager gate (marketplaceSkillPackages). */
  packageActivation?: {
    identity?: string;
    kind?: string;
    enabled?: boolean;
    state?: string;
    reason?: string | null;
    recorded?: boolean;
    requested?: boolean;
  } | null;
  nativeAgentPluginAccess?: {
    identity?: string;
    agentId?: string;
    enabled?: boolean;
    state?: string;
    reason?: string | null;
    allowedContributions?: string[];
    requestedContributions?: string[];
    serverGlobalContributions?: string[];
    warnings?: string[];
  } | null;
  nativeSettingsLifecycle?: {
    supported?: boolean;
    canInstall?: boolean;
    canUninstall?: boolean;
    reason?: string | null;
  } | null;
}

export interface MarketplaceConfigDiagnostics {
  ok?: boolean;
  degraded?: boolean;
  path?: string;
  digest?: string | null;
  file?: { revision?: number; activations?: Record<string, any>; claudeCompatibility?: unknown } | null;
  diagnostics?: Array<{ severity?: string; code?: string; path?: string; message?: string }>;
  summary?: { revision?: number | null; schemaVersion?: number | null };
}

export interface ClaudeCompatibilityStatus {
  binding: {
    id: string;
    mode: 'live' | 'mirror' | 'snapshot' | string;
    enabled: boolean;
    inputs?: Array<{ role?: string; path?: string }>;
  };
  state?: {
    digest?: string;
    generatedAt?: string;
    warnings?: Array<{ code?: string; category?: string; message?: string }>;
    packages?: Array<{ identity?: string; state?: string; classification?: string }>;
    virtualSources?: Array<{ id?: string; identity?: string }>;
  } | null;
  lastKnownGood?: boolean;
  diagnostic?: { code?: string; message?: string; graceExpired?: boolean } | null;
  pendingBoundary?: string | null;
}

export interface MarketplacePayload {
  source?: { kind?: string; configured?: boolean; path?: string; url?: string };
  plugins: MarketplacePlugin[];
  warnings?: string[];
  sources?: MarketplaceSourceRow[];
  capabilities?: {
    supported?: boolean;
    code?: string;
    message?: string;
    upgradeGuidance?: string | null;
    features?: Record<string, boolean>;
  } | null;
  access?: {
    isStudioOwner?: boolean;
    isLocalOwner?: boolean;
    connectionKind?: string;
  } | null;
  registry?: {
    revision?: number;
    digest?: string;
    path?: string;
    degraded?: boolean;
    diagnostic?: string | null;
    lastKnownGood?: boolean;
  } | null;
  configDiagnostics?: MarketplaceConfigDiagnostics | null;
  compatibilityBindings?: ClaudeCompatibilityStatus[];
}
