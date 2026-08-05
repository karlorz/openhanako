/**
 * Marketplace mutation actions hook: install/uninstall/toggle/switch handlers
 * with the consolidated single busy key. The data hook owns the catalog and
 * selection state; this hook only mutates the server and toasts results.
 */
import { useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import type { MarketplacePlugin, MarketplacePayload } from '../marketplace-types';
import {
  writeMarketplaceSkillPackageToggle,
  type MarketplaceActivationSnapshot,
} from '../marketplace-registry';
import {
  isInstalledSkillsPackage,
  marketAdapterLabel,
  marketConfirmationLabel,
  marketTargetLabel,
  marketVersion,
  rowKey,
  sourceQualifiedId,
  warningMessages,
} from './useMarketplaceData';

/** Busy sentinel for the native Agent Plugin Access toggle (not a row key). */
export const AGENT_ACCESS_BUSY_KEY = '__agent-access__';

export interface MarketplaceActions {
  installPlugin: (plugin: MarketplacePlugin) => Promise<void>;
  uninstallNativePlugin: (plugin: MarketplacePlugin) => Promise<void>;
  uninstallSkillsPackage: (plugin: MarketplacePlugin) => Promise<void>;
  toggleSkillPackageGate: (plugin: MarketplacePlugin, next: boolean) => Promise<void>;
  switchSource: (plugin: MarketplacePlugin) => Promise<void>;
  toggleNativeAgentAccess: (plugin: MarketplacePlugin) => Promise<void>;
  busyKey: string | null;
}

export interface MarketplaceActionsInput {
  marketplace: MarketplacePayload | null;
  reload: (opts?: { silent?: boolean }) => Promise<void>;
  selectedAgentId: string | null;
  updateMarketplacePlugin: (key: string, patch: (plugin: MarketplacePlugin) => MarketplacePlugin) => void;
}

function confirmInstallPlan(plugin: MarketplacePlugin): boolean {
  const warnings = warningMessages(plugin);
  const level = plugin.confirmationLevel || plugin.installPlan?.confirmationLevel || 'inline';
  const planLines = [
    `${sourceQualifiedId(plugin)}`,
    t('settings.plugins.marketPlanTarget', { label: marketTargetLabel(plugin.installTarget || plugin.installPlan?.destination) }),
    t('settings.plugins.marketPlanAdapter', { label: marketAdapterLabel(plugin.installAdapter || plugin.installPlan?.installAdapter) }),
    t('settings.plugins.marketPlanConfirmation', { label: marketConfirmationLabel(level) }),
    warnings.length ? t('settings.plugins.marketPlanWarnings', { list: warnings.map(w => `- ${w}`).join('\n') }) : '',
  ].filter(Boolean);

  return window.confirm(t('settings.plugins.marketInstallPlanReview', { details: planLines.join('\n') }));
}

function confirmSkillsUninstall(plugin: MarketplacePlugin): boolean {
  const install = plugin.packageInstall;
  if (!install || install.state === 'not-installed') return false;
  const deleteLines = install.present.length
    ? install.present.map(name => t('settings.plugins.marketSkillsDeleteLine', { name })).join('\n')
    : t('settings.plugins.marketSkillsNoPresentDirs');
  const missingLines = install.missing.length
    ? install.missing.map(name => `- ${name}/`).join('\n')
    : t('settings.plugins.marketSkillsNoMissingDirs');
  const invalidLines = (install.invalid || []).length
    ? '\n' + t('settings.plugins.marketSkillsInvalidEntries', { names: install.invalid!.map(name => `- ${name}`).join('\n') })
    : '';
  return window.confirm([
    t('settings.plugins.marketSkillsUninstallQuestion', { identity: sourceQualifiedId(plugin) }),
    '',
    t('settings.plugins.marketSkillsUninstallPermanentDelete'),
    deleteLines,
    '',
    t('settings.plugins.marketSkillsUninstallAlreadyMissingHeading'),
    missingLines,
    invalidLines,
    '',
    t('settings.plugins.marketSkillsUninstallUnaffected'),
    t('settings.plugins.marketSkillsUninstallSeparateFromManage'),
  ].filter(line => line !== '').join('\n'));
}

export function useMarketplaceActions(input: MarketplaceActionsInput): MarketplaceActions {
  const { marketplace, reload, selectedAgentId, updateMarketplacePlugin } = input;
  const showToast = useSettingsStore(s => s.showToast);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const installPlugin = async (plugin: MarketplacePlugin) => {
    if (busyKey) return;
    if (!plugin.canInstall || plugin.installTarget === 'unsupported') return;
    const allowDowngrade = plugin.installAction === 'downgrade'
      ? window.confirm(t('settings.plugins.marketDowngradeConfirm', {
          from: plugin.installedVersion || '',
          to: marketVersion(plugin),
        }))
      : false;
    if (plugin.installAction === 'downgrade' && !allowDowngrade) return;
    if (plugin.installTarget !== 'native-plugin' && !confirmInstallPlan(plugin)) return;

    setBusyKey(rowKey(plugin));
    try {
      if (plugin.installTarget === 'native-plugin') {
        const planRes = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/native/install/plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketplaceId: plugin.marketplaceId,
            expectedRevision: marketplace?.registry?.revision,
            expectedDigest: marketplace?.registry?.digest,
          }),
        });
        const plan = await planRes.json().catch(() => ({}));
        if (plan.error) throw new Error(plan.error);
        const confirmationText = typeof plan.confirmationText === 'string' ? plan.confirmationText : '';
        if (!confirmationText) return;
        const confirmed = window.confirm(t('settings.plugins.marketNativeInstallConfirm', {
          identity: plan.identity,
          version: plan.facts?.version || marketVersion(plugin),
          packageSha256: plan.facts?.packageSha256 || 'unknown',
          trust: plan.facts?.trust || plugin.trust || 'restricted',
          contributions: (plan.facts?.contributions || []).join(', ') || t('settings.plugins.marketNone'),
        }));
        if (!confirmed) return;
        const executeRes = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/native/install/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planToken: plan.planToken, confirmation: confirmationText }),
        });
        const result = await executeRes.json().catch(() => ({}));
        if (result.error) throw new Error(result.error);
        showToast(t('settings.plugins.installSuccess', { name: result.name || plugin.name }), 'success');
        await reload();
        return;
      }
      const res = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: plugin.selectedVersion || undefined,
          allowDowngrade,
          marketplaceId: plugin.marketplaceId || undefined,
          ...(typeof marketplace?.registry?.revision === 'number'
            ? { expectedRevision: marketplace.registry.revision }
            : {}),
          ...(marketplace?.registry?.digest ? { expectedDigest: marketplace.registry.digest } : {}),
          ...(plugin.sourceSnapshot ? { expectedSourceSnapshot: plugin.sourceSnapshot } : {}),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.plugins.installSuccess', { name: data.name || plugin.name }), 'success');
      await reload();
    } catch (err: unknown) {
      showToast(t('settings.plugins.installError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const uninstallNativePlugin = async (plugin: MarketplacePlugin) => {
    if (busyKey) return;
    if (!plugin.marketplaceId || plugin.installTarget !== 'native-plugin' || !plugin.nativeSettingsLifecycle?.canUninstall) return;
    setBusyKey(rowKey(plugin));
    try {
      const planRes = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/native/uninstall/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplaceId: plugin.marketplaceId,
          expectedRevision: marketplace?.registry?.revision,
          expectedDigest: marketplace?.registry?.digest,
        }),
      });
      const plan = await planRes.json().catch(() => ({}));
      if (plan.error) throw new Error(plan.error);
      const confirmationText = typeof plan.confirmationText === 'string' ? plan.confirmationText : '';
      if (!confirmationText) return;
      const confirmed = window.confirm(
        t('settings.plugins.marketNativeUninstallConfirm', { identity: plan.identity }),
      );
      if (!confirmed) return;
      const executeRes = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/native/uninstall/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planToken: plan.planToken, confirmation: confirmationText }),
      });
      const result = await executeRes.json().catch(() => ({}));
      if (result.error) throw new Error(result.error);
      showToast(t('settings.plugins.marketNativeUninstallSuccess', { identity: plan.identity }), 'success');
      await reload();
    } catch (err: unknown) {
      showToast(t('settings.plugins.marketNativeUninstallError', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const uninstallSkillsPackage = async (plugin: MarketplacePlugin) => {
    if (busyKey) return;
    if (!plugin.marketplaceId || !plugin.packageInstall || plugin.packageInstall.state === 'not-installed') return;
    if (!confirmSkillsUninstall(plugin)) return;
    setBusyKey(rowKey(plugin));
    try {
      const res = await hanaFetch(`/api/plugins/marketplace/${encodeURIComponent(plugin.id)}/skills`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplaceId: plugin.marketplaceId,
          ...(typeof marketplace?.registry?.revision === 'number'
            ? { expectedRevision: marketplace.registry.revision }
            : {}),
          ...(marketplace?.registry?.digest ? { expectedDigest: marketplace.registry.digest } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.error) throw new Error(data.error);
      if (data.ok === false || (Array.isArray(data.failed) && data.failed.length > 0)) {
        const details = [
          ...(Array.isArray(data.failed)
            ? data.failed.map((item: any) => `${item.name}: ${item.error}`)
            : []),
          ...(Array.isArray(data.referenceCleanup?.failedAgents)
            ? data.referenceCleanup.failedAgents.map((item: any) => t('settings.plugins.marketSkillsAgentFailure', { agentId: item.agentId, error: item.error }))
            : []),
          data.activationCleanupError ? t('settings.plugins.marketSkillsCleanupActivation', { error: data.activationCleanupError }) : '',
          data.bundleCleanupError ? t('settings.plugins.marketSkillsCleanupBundle', { error: data.bundleCleanupError }) : '',
          data.reloadError ? t('settings.plugins.marketSkillsCleanupReload', { error: data.reloadError }) : '',
        ].filter(Boolean);
        const failures = details.join('; ') || t('settings.plugins.marketSkillsCleanupUnresolved');
        showToast(t('settings.plugins.marketSkillsUninstallPartial', { failures }), 'error');
      } else {
        const removedCount = (data.deleted?.length || 0) + (data.alreadyMissing?.length || 0);
        showToast(t('settings.plugins.marketSkillsRemoved', { count: String(removedCount), identity: sourceQualifiedId(plugin) }), 'success');
      }
      await reload();
    } catch (err: unknown) {
      showToast(t('settings.plugins.marketSkillsUninstallFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const toggleNativeAgentAccess = async (plugin: MarketplacePlugin) => {
    if (busyKey) return;
    if (!selectedAgentId || !plugin.marketplaceId || plugin.installTarget !== 'native-plugin') return;
    const identity = sourceQualifiedId(plugin);
    const current = plugin.nativeAgentPluginAccess?.enabled === true;
    const nextEnabled = !current;
    const serverGlobal = plugin.nativeAgentPluginAccess?.serverGlobalContributions
      || plugin.capabilityInventory?.serverImpact
      || [];
    const summary = [
      t('settings.plugins.marketAgentAccessSummaryHeading', {
        action: nextEnabled
          ? t('settings.plugins.marketAgentAccessEnableVerb')
          : t('settings.plugins.marketAgentAccessDisableVerb'),
        identity,
      }),
      t('settings.plugins.marketAgentAccessSummaryAgent', { agentId: selectedAgentId }),
      t('settings.plugins.marketAgentAccessSummaryScope'),
      serverGlobal.length
        ? t('settings.plugins.marketAgentAccessSummaryServerGlobal', { items: serverGlobal.join(', ') })
        : t('settings.plugins.marketAgentAccessSummaryNoServerChange'),
      t('settings.plugins.marketAgentAccessSummaryRevision', { revision: String(marketplace?.registry?.revision ?? 'unknown') }),
      t('settings.plugins.marketAgentAccessSummaryDigest', { digest: marketplace?.registry?.digest || 'unknown' }),
    ].join('\n');
    if (!window.confirm(t('settings.plugins.marketAgentAccessConfirm', { summary }))) return;

    const snapshot = marketplace?.configDiagnostics?.file?.activations;
    if (!snapshot || typeof snapshot !== 'object') {
      showToast(t('settings.plugins.marketAgentAccessSummaryMissing'), 'error');
      return;
    }
    const activations = structuredClone(snapshot);
    activations.agentPluginAccess ||= {};
    activations.agentPluginAccess[selectedAgentId] ||= {};
    activations.agentPluginAccess[selectedAgentId][identity] = {
      enabled: nextEnabled,
      contributions: plugin.capabilityInventory?.agentFacing || [],
    };

    setBusyKey(AGENT_ACCESS_BUSY_KEY);
    try {
      const res = await hanaFetch('/api/plugins/marketplace/config/activations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activations,
          ...(typeof marketplace?.registry?.revision === 'number'
            ? { expectedRevision: marketplace.registry.revision }
            : {}),
          ...(marketplace?.registry?.digest ? { expectedDigest: marketplace.registry.digest } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || t('settings.plugins.marketAgentAccessUpdateFailed'));
      showToast(t('settings.plugins.marketAgentAccessUpdated', {
        state: nextEnabled ? 'enabled' : 'disabled',
        identity,
      }), 'success');
      await reload({ silent: true });
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * Package-level enable gate for installed Hana-skill packages.
   * Same activations PUT clone pattern as PluginsTab (marketplaceSkillPackages).
   * Owner-only; never PUT a bare {} when the activations snapshot is missing.
   */
  const toggleSkillPackageGate = async (plugin: MarketplacePlugin, enable: boolean) => {
    if (busyKey) return;
    if (!isInstalledSkillsPackage(plugin)) return;
    if (marketplace?.access?.isStudioOwner === false) return;
    const identity = sourceQualifiedId(plugin);
    const snapshot = marketplace?.configDiagnostics?.file?.activations;
    if (!snapshot || typeof snapshot !== 'object') {
      showToast(
        t('settings.saveFailed') + ': ' + t('settings.plugins.marketMissingActivationsSnapshot'),
        'error',
      );
      return;
    }

    const applyOptimistic = (nextEnabled: boolean) => {
      updateMarketplacePlugin(rowKey(plugin), (p) => ({
        ...p,
        packageActivation: {
          ...(p.packageActivation || {}),
          identity,
          kind: 'marketplace-skill-package',
          enabled: nextEnabled,
          state: nextEnabled ? 'enabled' : 'disabled',
          recorded: true,
          requested: nextEnabled,
          reason: nextEnabled ? null : 'marketplace skill package activation is disabled',
        },
      }));
    };

    applyOptimistic(enable);
    setBusyKey(rowKey(plugin));
    const reloadActivationSnapshot = async (): Promise<MarketplaceActivationSnapshot> => {
      const res = await hanaFetch('/api/plugins/marketplace/config');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || t('settings.plugins.marketConfigRefreshFailed'));
      return {
        registry: data?.registry && typeof data.registry === 'object' ? data.registry : null,
        activations: data?.configDiagnostics?.file?.activations
          && typeof data.configDiagnostics.file.activations === 'object'
          ? data.configDiagnostics.file.activations as Record<string, unknown>
          : null,
      };
    };

    try {
      const initial: MarketplaceActivationSnapshot = {
        registry: marketplace?.registry || null,
        activations: snapshot,
      };
      let result = await writeMarketplaceSkillPackageToggle(initial, identity, enable);
      if (result === 'stale') {
        result = await writeMarketplaceSkillPackageToggle(await reloadActivationSnapshot(), identity, enable);
        if (result === 'stale') {
          await reload({ silent: true });
          applyOptimistic(!enable);
          showToast(t('settings.plugins.marketplaceChangedRetry'), 'error');
          return;
        }
      }
      showToast(t('settings.autoSaved'), 'success');
      await reload({ silent: true });
    } catch (err: unknown) {
      applyOptimistic(!enable);
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const switchSource = async (plugin: MarketplacePlugin) => {
    if (busyKey) return;
    if (!marketplace?.registry) return;
    if (!plugin.marketplaceId || !plugin.retained || plugin.active) return;
    setBusyKey(rowKey(plugin));
    try {
      const planRes = await hanaFetch(`/api/plugins/${encodeURIComponent(plugin.id)}/source-switch/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplaceId: plugin.marketplaceId,
          expectedRevision: marketplace.registry.revision,
          expectedDigest: marketplace.registry.digest,
        }),
      });
      const plan = await planRes.json().catch(() => ({}));
      if (plan.error) throw new Error(plan.error);
      if (typeof plan.confirmationText !== 'string' || !plan.confirmationText) return;
      if (!window.confirm(plan.confirmationText)) return;
      const execRes = await hanaFetch(`/api/plugins/${encodeURIComponent(plugin.id)}/source-switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplaceId: plugin.marketplaceId,
          planToken: plan.planToken,
          confirmation: plan.confirmationText,
        }),
      });
      const data = await execRes.json().catch(() => ({}));
      if (data.error) throw new Error(data.error?.message || data.error || t('settings.plugins.marketSourceSwitchFailed'));
      if (!data.ok) throw new Error(t('settings.plugins.marketSourceSwitchFailed'));
      showToast(t('settings.plugins.marketSourceSwitched'), 'success');
      await reload();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  return {
    installPlugin,
    uninstallNativePlugin,
    uninstallSkillsPackage,
    toggleSkillPackageGate,
    switchSource,
    toggleNativeAgentAccess,
    busyKey,
  };
}
