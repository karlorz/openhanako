/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSettingsStore } from '../../../store';

const mocks = vi.hoisted(() => ({
  autoSaveGlobalModels: vi.fn(),
  hanaFetch: vi.fn(),
}));

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
  lookupModelMeta: vi.fn(),
  formatContext: (n: number) => String(n),
  autoSaveGlobalModels: mocks.autoSaveGlobalModels,
}));

vi.mock('../../../api', () => ({
  hanaFetch: mocks.hanaFetch,
}));

vi.mock('../../../actions', () => ({
  loadSettingsConfig: vi.fn(),
}));

vi.mock('../../../widgets/ModelWidget', () => ({
  ModelWidget: ({
    onSelect,
  }: {
    onSelect: (ref: { id: string; provider: string } | null) => void;
  }) => (
    <div data-testid="model-widget">
      <button type="button" data-testid="model-widget-clear" onClick={() => onSelect(null)}>
        clear
      </button>
    </div>
  ),
}));

vi.mock('@/ui', () => ({
  SelectWidget: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <button type="button" data-testid="select-widget" onClick={() => onChange(value)}>
      select-widget
    </button>
  ),
  Toggle: ({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label?: string }) => (
    <button
      type="button"
      data-testid={`toggle-${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
    >
      {label}
    </button>
  ),
}));

vi.mock('../../../widgets/KeyInput', () => ({
  KeyInput: () => <input data-testid="key-input" />,
}));

import { OtherModelsSection } from '../OtherModelsSection';

describe('OtherModelsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hanaFetch.mockResolvedValue({
      json: async () => ({ ok: true }),
    });
    useSettingsStore.setState({
      globalModelsConfig: {
        models: {
          utility: { id: 'small', provider: 'openai' },
          utility_large: { id: 'large', provider: 'openai' },
          vision: { id: 'gpt-4o', provider: 'openai' },
          vision_enabled: false,
        },
        search: { provider: '', api_key: '' },
        utility_api: {},
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the auxiliary vision toggle above the vision model picker and saves it as a global model preference', () => {
    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const visionLabel = screen.getByText('settings.api.visionModel');
    const toggle = screen.getByRole('button', { name: 'settings.api.visionAuxiliaryToggle' });
    const firstModelWidget = screen.getAllByTestId('model-widget')[2];

    expect(visionLabel.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.compareDocumentPosition(firstModelWidget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toggle);

    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({
      models: { vision_enabled: true },
    });
  });

  it('can clear utility, utility_large, and vision model selections', () => {
    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const clearButtons = screen.getAllByTestId('model-widget-clear');
    expect(clearButtons).toHaveLength(3);

    fireEvent.click(clearButtons[0]);
    fireEvent.click(clearButtons[1]);
    fireEvent.click(clearButtons[2]);

    expect(mocks.autoSaveGlobalModels).toHaveBeenNthCalledWith(1, { models: { utility: null } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenNthCalledWith(2, { models: { utility_large: null } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenNthCalledWith(3, { models: { vision: null } });
  });

  it('labels the model connection test action and announces its result', async () => {
    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const testButtons = screen.getAllByRole('button', { name: 'settings.api.testModelConnection' });
    expect(testButtons).toHaveLength(3);
    expect(testButtons[0]).toHaveAttribute('title', 'settings.api.testModelConnection');

    fireEvent.click(testButtons[0]);

    expect(await screen.findByRole('button', { name: 'settings.api.modelConnectionSucceeded' }))
      .toHaveAttribute('title', 'settings.api.modelConnectionSucceeded');
  });

  it('does not render a connection test action for an empty model preference', () => {
    useSettingsStore.setState({
      globalModelsConfig: {
        models: {
          utility: null,
          utility_large: { id: 'large', provider: 'openai' },
          vision: { id: 'gpt-4o', provider: 'openai' },
          vision_enabled: false,
        },
        search: { provider: '', api_key: '' },
        utility_api: {},
      },
    });

    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    expect(screen.getAllByRole('button', { name: 'settings.api.testModelConnection' })).toHaveLength(2);
  });

  it('ignores a stale connection-test result after the selected model changes', async () => {
    let resolveHealth: ((value: { json: () => Promise<{ ok: boolean }> }) => void) | undefined;
    mocks.hanaFetch.mockReturnValue(new Promise((resolve) => {
      resolveHealth = resolve;
    }));
    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.api.testModelConnection' })[0]);
    expect(screen.getByRole('button', { name: 'settings.api.testingModelConnection' })).toBeDisabled();

    act(() => {
      useSettingsStore.setState({
        globalModelsConfig: {
          models: {
            utility: { id: 'replacement', provider: 'openai' },
            utility_large: { id: 'large', provider: 'openai' },
            vision: { id: 'gpt-4o', provider: 'openai' },
            vision_enabled: false,
          },
          search: { provider: '', api_key: '' },
          utility_api: {},
        },
      });
    });

    expect(screen.getAllByRole('button', { name: 'settings.api.testModelConnection' })).toHaveLength(3);

    await act(async () => {
      resolveHealth?.({ json: async () => ({ ok: true }) });
      await Promise.resolve();
    });

    expect(screen.queryByRole('button', { name: 'settings.api.modelConnectionSucceeded' }))
      .not.toBeInTheDocument();
  });
});
