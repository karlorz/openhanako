import React, { useEffect, useRef, useState } from 'react';
import { Overlay } from '@/ui';
import { t } from '../helpers';
import dialogStyles from './AddMarketplaceSourceDialog.module.css';

export type MarketplaceSourceInputKind = 'catalog' | 'git' | 'local' | 'unknown';

export interface MarketplaceSourceInput {
  source: string;
}

export interface AddMarketplaceSourceDialogProps {
  open?: boolean;
  onClose: () => void;
  onSubmit: (input: MarketplaceSourceInput) => Promise<void> | void;
}

export function detectMarketplaceSourceKind(value: string): MarketplaceSourceInputKind {
  const source = value.trim();
  if (!source) return 'unknown';
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) return 'local';
  if (!/^https:\/\//i.test(source)) return 'unknown';

  try {
    const url = new URL(source);
    return /(?:^|\/)marketplace\.json$/i.test(url.pathname) || /\.json$/i.test(url.pathname)
      ? 'catalog'
      : 'git';
  } catch {
    return 'unknown';
  }
}

function previewLabel(kind: MarketplaceSourceInputKind): string {
  if (kind === 'catalog') return t('settings.plugins.marketSourceDetectedCatalog');
  if (kind === 'git') return t('settings.plugins.marketSourceDetectedGit');
  if (kind === 'local') return t('settings.plugins.marketSourceDetectedLocal');
  return t('settings.plugins.marketSourceDetectedUnknown');
}

/** A compact, source-first entry point. The server remains authoritative for validation. */
export function AddMarketplaceSourceDialog({ open = true, onClose, onSubmit }: AddMarketplaceSourceDialogProps) {
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const kind = detectMarketplaceSourceKind(source);

  useEffect(() => {
    if (!open) return;
    setSource('');
    setError(null);
  }, [open]);

  const close = () => {
    if (!submitting) onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = source.trim();
    if (!value) {
      setError(t('settings.plugins.marketSourceRequired'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ source: value });
      onClose();
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={close}
      scope="window"
      backdrop="blur"
      closeOnBackdrop={!submitting}
      closeOnEsc={!submitting}
      initialFocusRef={inputRef}
      className={dialogStyles.dialog}
      contentProps={{
        role: 'dialog',
        'aria-modal': true,
        'aria-labelledby': 'add-marketplace-source-title',
      }}
    >
      <form
        onSubmit={submit}
      >
        <div className={dialogStyles.header}>
          <h3 id="add-marketplace-source-title">{t('settings.plugins.marketSourceDialogTitle')}</h3>
          <button
            type="button"
            className={dialogStyles.closeButton}
            aria-label={t('settings.plugins.marketSourceDialogClose')}
            title={t('settings.plugins.marketSourceDialogClose')}
            disabled={submitting}
            onClick={close}
          >
            ×
          </button>
        </div>

        <p className={dialogStyles.help}>
          {t('settings.plugins.marketSourceDialogHelp')}
        </p>
        <ul className={dialogStyles.examples} aria-label="Marketplace source examples">
          <li>{t('settings.plugins.marketSourceExampleCatalog')}</li>
          <li>{t('settings.plugins.marketSourceExampleGit')}</li>
          <li>{t('settings.plugins.marketSourceExampleLocal')}</li>
        </ul>

        <label className={dialogStyles.field} htmlFor="marketplace-source-input">
          <span>{t('settings.plugins.marketSourceDialogField')}</span>
          <input
            ref={inputRef}
            id="marketplace-source-input"
            name="marketplaceSource"
            type="text"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              if (error) setError(null);
            }}
            placeholder={t('settings.plugins.marketSourceExampleCatalog')}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="marketplace-source-preview marketplace-source-error"
          />
        </label>
        <p id="marketplace-source-preview" className={dialogStyles.preview} role="status">
          {previewLabel(kind)}
        </p>
        {error ? <p id="marketplace-source-error" className={dialogStyles.error} role="alert">{error}</p> : null}

        <div className={dialogStyles.actions}>
          <button type="button" disabled={submitting} onClick={close}>{t('settings.plugins.marketSourceCancel')}</button>
          <button type="submit" className={dialogStyles.primary} disabled={submitting}>
            {submitting ? t('settings.plugins.marketSourceAdding') : t('settings.plugins.marketSourceAdd')}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
