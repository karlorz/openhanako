/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddMarketplaceSourceDialog, detectMarketplaceSourceKind } from '../../settings/components/AddMarketplaceSourceDialog';

describe('AddMarketplaceSourceDialog', () => {
  beforeEach(() => {
    window.t = ((key: string) => {
      const labels: Record<string, string> = {
        'settings.plugins.marketSourceAdd': 'Add source',
        'settings.plugins.marketSourceCancel': 'Cancel',
        'settings.plugins.marketSourceDialogTitle': 'Add Marketplace Source',
        'settings.plugins.marketSourceDialogClose': 'Close add marketplace source dialog',
        'settings.plugins.marketSourceDialogHelp': 'Paste a marketplace URL, Git repository, or server-local path. Hana detects the source type automatically.',
        'settings.plugins.marketSourceDialogField': 'Source',
        'settings.plugins.marketSourceExampleCatalog': 'https://example.com/marketplace.json',
        'settings.plugins.marketSourceExampleGit': 'https://github.com/org/catalog',
        'settings.plugins.marketSourceExampleLocal': '/path/to/marketplace',
        'settings.plugins.marketSourceDetectedCatalog': 'Detected: HTTPS catalog',
        'settings.plugins.marketSourceDetectedGit': 'Detected: public HTTPS Git repository',
        'settings.plugins.marketSourceDetectedLocal': 'Detected: server-local path',
        'settings.plugins.marketSourceDetectedUnknown': 'Detected: enter an HTTPS catalog, public HTTPS Git repository, or server-local path.',
        'settings.plugins.marketSourceRequired': 'Enter a marketplace source to continue.',
        'settings.plugins.marketSourceAdding': 'Adding…',
      };
      return labels[key] || key;
    }) as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ['https://example.com/marketplace.json', 'catalog'],
    ['https://github.com/example/catalog', 'git'],
    ['/srv/marketplaces/team', 'local'],
    ['git@github.com:example/catalog.git', 'unknown'],
  ] as const)('detects %s as %s', (source, expected) => {
    expect(detectMarketplaceSourceKind(source)).toBe(expected);
  });

  it('autofocuses its only textbox, previews the source type, and submits its form', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AddMarketplaceSourceDialog onClose={onClose} onSubmit={onSubmit} />);

    const sourceInput = screen.getByRole('textbox', { name: 'Source' });
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    await waitFor(() => expect(sourceInput).toHaveFocus());

    fireEvent.change(sourceInput, { target: { value: '/srv/marketplaces/team' } });
    expect(screen.getByText('Detected: server-local path')).toBeInTheDocument();
    fireEvent.submit(sourceInput.closest('form')!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ source: '/srv/marketplaces/team' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('cancels with Escape and retains an inline submission error for correction', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error('This source already exists.'));
    render(<AddMarketplaceSourceDialog onClose={onClose} onSubmit={onSubmit} />);

    const sourceInput = screen.getByRole('textbox', { name: 'Source' });
    fireEvent.change(sourceInput, { target: { value: 'https://example.com/marketplace.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This source already exists.');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(sourceInput, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
