import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { t, lookupModelMeta, CONTEXT_PRESETS, OUTPUT_PRESETS } from '../../helpers';
import { hanaFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { ComboInput } from '../../widgets/ComboInput';
import { Toggle } from '@/ui';
import styles from '../../Settings.module.css';

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstNumber(meta: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(meta[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Resolve capability booleans for the edit panel.
 * User catalog fields win; dictionary/reference only fills absent fields for the initial display.
 */
export function resolveCapabilityFlags(
  userMeta: Record<string, unknown>,
  knownMeta: Record<string, unknown>,
): { image: boolean; video: boolean; audio: boolean; reasoning: boolean } {
  const knownImage = knownMeta.image === true
    || (knownMeta.image === undefined && knownMeta.vision === true);
  const userHasImage = userMeta.image !== undefined || userMeta.vision !== undefined;

  return {
    image: userHasImage
      ? (userMeta.image === true || (userMeta.image === undefined && userMeta.vision === true))
      : knownImage,
    video: userMeta.video !== undefined ? userMeta.video === true : knownMeta.video === true,
    audio: userMeta.audio !== undefined ? userMeta.audio === true : knownMeta.audio === true,
    reasoning: userMeta.reasoning !== undefined
      ? userMeta.reasoning === true
      : knownMeta.reasoning === true,
  };
}

export type CapabilityKey = 'image' | 'video' | 'audio' | 'reasoning';

/**
 * Build capability fields for the provider-catalog PUT body.
 *
 * - Always materialize `true` so dictionary-seeded Vision ON becomes durable SoT
 *   without a re-toggle (fixes Vision auxiliary missing models).
 * - Materialize `false` only when the catalog already had that field or the user
 *   toggled it. Avoids stamping `image: false` over runtime-only sources such as
 *   Ollama name inference on bare-string models.
 */
export function buildCapabilitySavePatch(opts: {
  values: Record<CapabilityKey, boolean>;
  userMeta: Record<string, unknown>;
  dirty: Partial<Record<CapabilityKey, boolean>>;
}): Partial<Record<CapabilityKey, boolean>> {
  const { values, userMeta, dirty } = opts;
  const patch: Partial<Record<CapabilityKey, boolean>> = {};
  const had: Record<CapabilityKey, boolean> = {
    image: userMeta.image !== undefined || userMeta.vision !== undefined,
    video: userMeta.video !== undefined,
    audio: userMeta.audio !== undefined,
    reasoning: userMeta.reasoning !== undefined,
  };
  for (const key of ['image', 'video', 'audio', 'reasoning'] as const) {
    if (values[key] === true || had[key] || dirty[key]) {
      patch[key] = values[key];
    }
  }
  return patch;
}

export function ModelEditPanel({ modelId, providerId, modelMeta, anchorEl, onClose, onRefresh }: {
  modelId: string;
  providerId: string;
  modelMeta?: Record<string, unknown>;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onRefresh?: () => Promise<void>;
}) {
  const showToast = useSettingsStore(s => s.showToast);
  const knownMeta: Record<string, any> = lookupModelMeta(modelId, providerId) || {};
  const userMeta: Record<string, unknown> = modelMeta || {};
  const meta: Record<string, any> = {
    ...knownMeta,
    ...userMeta,
  };
  // Resolve aliases inside each ownership layer before falling through to the
  // known catalog. Otherwise known `context`/`maxOutput` can mask a persisted
  // user `contextWindow`/`maxTokens` value after the objects are merged.
  const initialContext = firstNumber(userMeta, ['context', 'contextWindow'])
    ?? firstNumber(knownMeta, ['context', 'contextWindow']);
  const initialMaxOutput = firstNumber(userMeta, ['maxOutput', 'maxTokens', 'maxOutputTokens'])
    ?? firstNumber(knownMeta, ['maxOutput', 'maxTokens', 'maxOutputTokens']);
  const initialCaps = resolveCapabilityFlags(userMeta, knownMeta);
  const [displayName, setDisplayName] = useState(meta.displayName || meta.name || '');
  const [ctxVal, setCtxVal] = useState(String(initialContext ?? ''));
  const [outVal, setOutVal] = useState(String(initialMaxOutput ?? ''));
  // image 字段对应 Pi SDK Model.input 里是否包含 "image"。
  // 兼容读旧 meta.vision（未迁移到新字段的历史配置）；迁移 #7 之后此 fallback 恒不命中。
  const [image, setImage] = useState<boolean>(initialCaps.image);
  const [video, setVideo] = useState<boolean>(initialCaps.video);
  const [audio, setAudio] = useState<boolean>(initialCaps.audio);
  const [reasoning, setReasoning] = useState<boolean>(initialCaps.reasoning);
  const [dirtyCapabilities, setDirtyCapabilities] = useState<Partial<Record<CapabilityKey, boolean>>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    setStyle({
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 9999,
      width: 360,
    });
  }, [anchorEl]);

  const setCapability = (key: CapabilityKey, value: boolean) => {
    if (key === 'image') setImage(value);
    else if (key === 'video') setVideo(value);
    else if (key === 'audio') setAudio(value);
    else setReasoning(value);
    setDirtyCapabilities((prev) => ({ ...prev, [key]: true }));
  };

  const save = async () => {
    const entry: Record<string, any> = {
      ...buildCapabilitySavePatch({
        values: { image, video, audio, reasoning },
        userMeta,
        dirty: dirtyCapabilities,
      }),
    };
    const name = displayName.trim();
    const ctx = ctxVal.trim();
    const maxOut = outVal.trim();
    if (name) entry.name = name;
    if (ctx) entry.context = parseInt(ctx, 10);
    if (maxOut) entry.maxOutput = parseInt(maxOut, 10);

    try {
      await hanaFetch(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      // Drop stale settings/config snapshots so Vision auxiliary / model lists re-read projection.
      invalidateConfigCache();
      showToast(t('settings.saved'), 'success');
      await onRefresh?.();
      onClose();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  return (
    <>
    <div className={styles['pv-model-edit-overlay']} onClick={onClose} />
    <div ref={panelRef} className={styles['pv-model-edit-card']} style={style}>
      <div className={styles['pv-model-edit-field']}>
        <label className={styles['pv-model-edit-label']}>ID</label>
        <span className={styles['pv-model-edit-id']}>{modelId}</span>
      </div>
      <div className={styles['pv-model-edit-field']}>
        <label className={styles['pv-model-edit-label']}>{t('settings.api.displayName')}</label>
        <input
          className={styles['settings-input']}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={modelId}
        />
      </div>
      <div className={styles['pv-model-edit-row']}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.contextLength')}</label>
          <ComboInput presets={CONTEXT_PRESETS} value={ctxVal} onChange={setCtxVal} placeholder="131072" />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.maxOutput')}</label>
          <ComboInput presets={OUTPUT_PRESETS} value={outVal} onChange={setOutVal} placeholder="16384" />
        </div>
      </div>
      <div className={`${styles['pv-model-edit-row']} ${styles['pv-model-edit-capabilities']}`}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.vision')}</label>
          <Toggle ariaLabel={t('settings.api.vision')} on={image} onChange={(v) => setCapability('image', v)} />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.video')}</label>
          <Toggle ariaLabel={t('settings.api.video')} on={video} onChange={(v) => setCapability('video', v)} />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.audio')}</label>
          <Toggle ariaLabel={t('settings.api.audio')} on={audio} onChange={(v) => setCapability('audio', v)} />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.reasoning')}</label>
          <Toggle ariaLabel={t('settings.api.reasoning')} on={reasoning} onChange={(v) => setCapability('reasoning', v)} />
        </div>
      </div>
      <div className={styles['pv-model-edit-actions']}>
        <button type="button" className={styles['pv-add-form-btn']} onClick={onClose}>{t('settings.api.cancel')}</button>
        <button type="button" className={`${styles['pv-add-form-btn']} ${styles['primary']}`} onClick={save}>{t('settings.api.save')}</button>
      </div>
    </div>
    </>
  );
}
