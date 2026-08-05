/**
 * Plugin config editor: owns the config-draft state (pluginConfig,
 * configDraft, jsonTextDrafts, dirtyConfigKeys, configSaving), the config
 * fetch, and the config form section for the selected plugin. The tab keeps
 * the plugin selection (configPlugin) and renders this editor in its place;
 * onClose restores the pre-editor state (e.g. after a config load error) and
 * onSaved fires after a successful save.
 */
import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';
import { SettingsSection } from '../SettingsSection';
import { SettingsRow } from '../SettingsRow';
import { SelectWidget, type SelectOption } from '@/ui';

export interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  status: 'loaded' | 'failed' | 'disabled' | 'restricted';
  activationState?: string | null;
  activationEvents?: string[];
  activationError?: string | null;
  source: 'builtin' | 'community';
  trust: 'restricted' | 'full-access';
  contributions?: string[];
  error?: string | null;
}

interface PluginConfigProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  sensitive?: boolean;
  scope?: 'global' | 'per-agent' | 'per-session';
  ui?: { control?: string };
}

interface PluginConfigResponse {
  pluginId: string;
  schema: {
    properties?: Record<string, PluginConfigProperty>;
  };
  values: Record<string, unknown>;
}

function formatConfigValue(property: PluginConfigProperty, value: unknown): string {
  if (property.type === 'object' || property.type === 'array') {
    return value === undefined ? '' : JSON.stringify(value, null, 2);
  }
  return value === undefined || value === null ? '' : String(value);
}

function parseConfigValue(property: PluginConfigProperty, value: string): unknown {
  if (property.type === 'number') return Number(value);
  if (property.type === 'integer') return Number.parseInt(value, 10);
  if (property.type === 'object' || property.type === 'array') return value.trim() ? JSON.parse(value) : property.type === 'array' ? [] : {};
  return value;
}

function buildJsonTextDrafts(config: PluginConfigResponse): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const [key, property] of Object.entries(config.schema.properties || {})) {
    if (property.type !== 'object' && property.type !== 'array') continue;
    drafts[key] = formatConfigValue(property, config.values?.[key]);
  }
  return drafts;
}

export function PluginConfigEditor(props: {
  plugin: PluginInfo;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}): React.JSX.Element | null {
  const { plugin, onClose, onSaved } = props;
  const showToast = useSettingsStore(s => s.showToast);
  const [pluginConfig, setPluginConfig] = useState<PluginConfigResponse | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, unknown>>({});
  const [jsonTextDrafts, setJsonTextDrafts] = useState<Record<string, string>>({});
  const [dirtyConfigKeys, setDirtyConfigKeys] = useState<Set<string>>(new Set());
  const [configSaving, setConfigSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await hanaFetch(`/api/plugins/${encodeURIComponent(plugin.id)}/config`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (cancelled) return;
        setPluginConfig(data);
        setConfigDraft(data.values || {});
        setJsonTextDrafts(buildJsonTextDrafts(data));
        setDirtyConfigKeys(new Set());
      } catch (err: unknown) {
        if (cancelled) return;
        showToast(t('settings.plugins.configLoadError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
        onClose();
      }
    })();
    return () => { cancelled = true; };
  }, [plugin.id, showToast, onClose]);

  if (!pluginConfig) return null;

  const updateConfigDraft = (key: string, value: unknown) => {
    setConfigDraft(prev => ({ ...prev, [key]: value }));
    setDirtyConfigKeys(prev => new Set(prev).add(key));
  };

  const updateJsonTextDraft = (key: string, value: string) => {
    setJsonTextDrafts(prev => ({ ...prev, [key]: value }));
    setDirtyConfigKeys(prev => new Set(prev).add(key));
  };

  const parseJsonTextDraft = (
    key: string,
    property: PluginConfigProperty,
    text: string,
  ): { ok: true; value: unknown } | { ok: false } => {
    try {
      const parsed = parseConfigValue(property, text);
      setConfigDraft(prev => ({ ...prev, [key]: parsed }));
      return { ok: true, value: parsed };
    } catch {
      showToast(t('settings.plugins.invalidJson'), 'error');
      return { ok: false };
    }
  };

  const savePluginConfig = async () => {
    if (!pluginConfig) return;
    const values: Record<string, unknown> = {};
    for (const key of dirtyConfigKeys) {
      const property = pluginConfig.schema.properties?.[key] || {};
      const isJsonProperty = property.type === 'object' || property.type === 'array';
      let value = configDraft[key];
      if (isJsonProperty) {
        const text = jsonTextDrafts[key] ?? formatConfigValue(property, value);
        const parsed = parseJsonTextDraft(key, property, text);
        if (!parsed.ok) return;
        value = parsed.value;
      }
      if (property.sensitive && value === '********') continue;
      values[key] = value;
    }
    setConfigSaving(true);
    try {
      const res = await hanaFetch(`/api/plugins/${encodeURIComponent(plugin.id)}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.fields?.[0]?.message || data.error);
      setPluginConfig(data);
      setConfigDraft(data.values || {});
      setJsonTextDrafts(buildJsonTextDrafts(data));
      setDirtyConfigKeys(new Set());
      showToast(t('settings.autoSaved'), 'success');
      onSaved();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setConfigSaving(false);
    }
  };

  return (
    <SettingsSection
      title={t('settings.plugins.configTitle', { name: plugin.name })}
      context={
        <button
          className={styles['settings-save-btn-sm']}
          disabled={configSaving || dirtyConfigKeys.size === 0}
          onClick={savePluginConfig}
        >
          {t('settings.api.save')}
        </button>
      }
    >
      {Object.entries(pluginConfig.schema.properties || {}).filter(([, property]) => (property.scope || 'global') === 'global').map(([key, property]) => {
        const label = property.title || key;
        const hint = property.description || (property.sensitive ? t('settings.plugins.sensitiveHint') : undefined);
        const value = configDraft[key];
        const control = property.type === 'boolean' ? (
          <button
            className={`hana-toggle${value === true ? ' on' : ''}`}
            onClick={() => updateConfigDraft(key, value !== true)}
          />
        ) : property.enum ? (
          <SelectWidget
            options={property.enum.map((item): SelectOption => ({ value: String(item), label: String(item) }))}
            value={formatConfigValue(property, value)}
            onChange={(v) => updateConfigDraft(key, parseConfigValue(property, v))}
          />
        ) : property.type === 'object' || property.type === 'array' ? (
          <textarea
            className={styles['settings-input']}
            rows={4}
            value={jsonTextDrafts[key] ?? formatConfigValue(property, value)}
            onChange={(e) => updateJsonTextDraft(key, e.target.value)}
            onBlur={(e) => { parseJsonTextDraft(key, property, e.target.value); }}
          />
        ) : (
          <input
            className={styles['settings-input']}
            type={property.sensitive ? 'password' : property.type === 'number' || property.type === 'integer' ? 'number' : 'text'}
            value={formatConfigValue(property, value)}
            onChange={(e) => updateConfigDraft(key, parseConfigValue(property, e.target.value))}
          />
        );
        return (
          <SettingsRow
            key={key}
            label={label}
            hint={hint}
            control={control}
            layout={property.type === 'object' || property.type === 'array' ? 'stacked' : 'inline'}
          />
        );
      })}
    </SettingsSection>
  );
}
