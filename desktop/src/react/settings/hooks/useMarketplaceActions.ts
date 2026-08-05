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
}

function confirmInstallPlan(plugin: MarketplacePlugin): boolean {
  const warnings = warningMessages(plugin);
  const level = plugin.confirmationLevel || plugin.installPlan?.confirmationLevel || 'inline';
  const planLines = [
    `${sourceQualifiedId(plugin)}`,
    `Target: ${marketTargetLabel(plugin.installTarget || plugin.installPlan?.destination)}`,
    `Adapter: ${marketAdapterLabel(plugin.installAdapter || plugin.installPlan?.installAdapter)}`,
    `Confirmation: ${marketConfirmationLabel(level)}`,
    warnings.length ? `Warnings:\n${warnings.map(w => `- ${w}`).join('\n')}` : '',
  ].filter(Boolean);

  return window.confirm(t('settings.plugins.marketInstallPlanReview', { details: planLines.join('\n') }));
}

function confirmSkillsUninstall(plugin: MarketplacePlugin): boolean {
  const install = plugin.packageInstall;
  if (!install || install.state === 'not-installed') return false;
  const deleteLines = install.present.length
    ? install.present.map(name => `- shared user skills/${name}/`).join('\n')
    : '- none; all recorded directories are already missing';
  const missingLines = install.missing.length
    ? install.missing.map(name => `- ${name}/`).join('\n')
    : '- none';
  const invalidLines = (install.invalid || []).length
    ? `\nInvalid record entries will fail closed and will not be used as paths:\n${install.invalid!.map(name => `- ${name}`).join('\n')}`
    : '';
  return window.confirm([
    `Uninstall marketplace skills package ${sourceQualifiedId(plugin)}?`,
    '',
    'These shared user-skill directories will be permanently deleted, including later edits:',
    deleteLines,
    '',
    'Already-missing recorded directories:',
    missingLines,
    invalidLines,
    '',
    'Native/community plugin directories and Allow Agent plugin dev tools directories, slots, and records are unaffected.',
    'This package-level action is separate from Manage in Skills.',
  ].filter(line => line !== '').join('\n'));
}

export function useMarketplaceActions(input: MarketplaceActionsInput): MarketplaceActions {
  const { marketplace, reload, selectedAgentId } = input;
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
          contributions: (plan.facts?.contributions || []).join(', ') || 'none',
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
            ? data.referenceCleanup.failedAgents.map((item: any) => `Agent ${item.agentId}: ${item.error}`)
            : []),
          data.activationCleanupError ? `activation cleanup: ${data.activationCleanupError}` : '',
          data.bundleCleanupError ? `bundle cleanup: ${data.bundleCleanupError}` : '',
          data.reloadError ? `skill reload: ${data.reloadError}` : '',
        ].filter(Boolean);
        const failures = details.join('; ') || 'Some cleanup steps remain unresolved.';
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
      `${nextEnabled ? 'Enable' : 'Disable'} Agent Plugin Access for ${identity}`,
      `Agent: ${selectedAgentId}`,
      'Agent-facing scope: tools, commands, chat cards, and agent-aware surfaces only.',
      serverGlobal.length
        ? `Owner-reviewed server-global capabilities are unchanged: ${serverGlobal.join(', ')}`
        : 'No server-global capability state will be changed.',
      `Registry revision: ${marketplace?.registry?.revision ?? 'unknown'}`,
      `Registry digest: ${marketplace?.registry?.digest || 'unknown'}`,
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
      if (!res.ok || data.error) throw new Error(data.error || 'Agent Plugin Access update failed');
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
        t('settings.saveFailed') + ': missing activations snapshot',
        'error',
      );
      return;
    }

    setBusyKey(rowKey(plugin));
    const reloadActivationSnapshot = async (): Promise<MarketplaceActivationSnapshot> => {
      const res = await hanaFetch('/api/plugins/marketplace/config');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || 'Marketplace config refresh failed');
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
          showToast(t('settings.plugins.marketplaceChangedRetry'), 'error');
          return;
        }
      }
      showToast(t('settings.autoSaved'), 'success');
      await reload({ silent: true });
    } catch (err: unknown) {
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
      if (data.error) throw new Error(data.error?.message || data.error || 'switch failed');
      if (!data.ok) throw new Error('switch failed');
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
