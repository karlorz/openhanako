/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
  lookupModelMeta: vi.fn((_id: unknown, _provider?: unknown): unknown => null),
  showToast: vi.fn(),
}));

vi.mock('../../../api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

vi.mock('../../../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
  lookupModelMeta: (id: unknown, provider?: unknown) => mocks.lookupModelMeta(id, provider),
  CONTEXT_PRESETS: [],
  OUTPUT_PRESETS: [],
}));

vi.mock('../../../store', () => ({
  useSettingsStore: (selector: (s: { showToast: typeof mocks.showToast }) => unknown) =>
    selector({ showToast: mocks.showToast }),
}));

import {
  ModelEditPanel,
  buildCapabilitySavePatch,
  resolveCapabilityFlags,
} from '../ModelEditPanel';

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

describe('resolveCapabilityFlags', () => {
  it('prefers user catalog fields over dictionary hints', () => {
    expect(resolveCapabilityFlags(
      { image: false, reasoning: true },
      { image: true, reasoning: false },
    )).toEqual({
      image: false,
      video: false,
      audio: false,
      reasoning: true,
    });
  });

  it('fills absent user fields from dictionary for initial display only', () => {
    expect(resolveCapabilityFlags({}, { image: true, reasoning: true })).toEqual({
      image: true,
      video: false,
      audio: false,
      reasoning: true,
    });
  });
});

describe('buildCapabilitySavePatch', () => {
  it('materializes true capabilities without dirty (dictionary ON → catalog SoT)', () => {
    expect(buildCapabilitySavePatch({
      values: { image: true, video: false, audio: false, reasoning: true },
      userMeta: {},
      dirty: {},
    })).toEqual({ image: true, reasoning: true });
  });

  it('does not stamp false over bare models (preserves runtime Ollama inference)', () => {
    expect(buildCapabilitySavePatch({
      values: { image: false, video: false, audio: false, reasoning: false },
      userMeta: {},
      dirty: {},
    })).toEqual({});
  });

  it('writes false when user catalog already had the field or toggle is dirty', () => {
    expect(buildCapabilitySavePatch({
      values: { image: false, video: false, audio: false, reasoning: false },
      userMeta: { image: true },
      dirty: {},
    })).toEqual({ image: false });

    expect(buildCapabilitySavePatch({
      values: { image: false, video: false, audio: false, reasoning: false },
      userMeta: {},
      dirty: { image: true },
    })).toEqual({ image: false });
  });
});

describe('ModelEditPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hanaFetch.mockResolvedValue(jsonResponse({ ok: true }));
    mocks.lookupModelMeta.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it('materializes dictionary Vision ON on Save without requiring a re-toggle', async () => {
    const onRefresh = vi.fn(async () => {});
    const onClose = vi.fn();

    mocks.lookupModelMeta.mockReturnValue({ name: 'Grok 4.3', image: true, reasoning: true });

    render(
      <ModelEditPanel
        modelId="grok-4.3"
        providerId="custom-provider"
        modelMeta={{ id: 'grok-4.3' }}
        anchorEl={document.body}
        onClose={onClose}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalled();
    });

    const body = JSON.parse(String(mocks.hanaFetch.mock.calls[0][1].body));
    expect(body).toMatchObject({
      image: true,
      reasoning: true,
    });
    expect(body.video).toBeUndefined();
    expect(body.audio).toBeUndefined();
    expect(onRefresh).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('does not persist image:false on bare model Save without toggling (Ollama inference safe)', async () => {
    mocks.lookupModelMeta.mockReturnValue(null);

    render(
      <ModelEditPanel
        modelId="llava:latest"
        providerId="ollama"
        modelMeta={undefined}
        anchorEl={document.body}
        onClose={vi.fn()}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalled();
    });

    const body = JSON.parse(String(mocks.hanaFetch.mock.calls[0][1].body));
    expect(body.image).toBeUndefined();
    expect(body.video).toBeUndefined();
    expect(body.audio).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it('persists Vision OFF when the user turns it off', async () => {
    mocks.lookupModelMeta.mockReturnValue({ image: true });

    render(
      <ModelEditPanel
        modelId="grok-4.3"
        providerId="custom-provider"
        modelMeta={{ id: 'grok-4.3', image: true }}
        anchorEl={document.body}
        onClose={vi.fn()}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'settings.api.vision' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalled();
    });

    const body = JSON.parse(String(mocks.hanaFetch.mock.calls[0][1].body));
    expect(body.image).toBe(false);
  });
});
