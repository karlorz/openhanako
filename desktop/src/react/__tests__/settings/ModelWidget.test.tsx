/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelWidget } from '../../settings/widgets/ModelWidget';

const hanaFetch = vi.fn();

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetch(...args),
}));

describe('ModelWidget', () => {
  beforeEach(() => {
    hanaFetch.mockResolvedValue({
      json: async () => ({
        models: [
          { id: 'glm-5.2', name: 'GLM 5.2', provider: 'zhipu-coding', contextWindow: 128000 },
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, input: ['image'] },
        ],
      }),
    });
    (window as any).t = (key: string) => key;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as any).t;
  });

  it('shows the provider icon in the closed selected trigger', () => {
    render(
      <ModelWidget
        value={{ id: 'glm-5.2', provider: 'zhipu-coding' }}
        onSelect={vi.fn()}
        placeholder="select"
      />,
    );

    const trigger = screen.getByRole('button', { name: /zhipu-coding\/glm-5.2/ });
    expect(trigger.querySelector('svg')).toBeTruthy();
  });

  it('clears the selection when None (empty) is chosen', async () => {
    const onSelect = vi.fn();
    render(
      <ModelWidget
        value={{ id: 'glm-5.2', provider: 'zhipu-coding' }}
        onSelect={onSelect}
        allowClear
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /zhipu-coding\/glm-5.2/ }));

    await waitFor(() => {
      expect(screen.getByTestId('model-widget-clear')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('model-widget-clear'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('hides the clear option when allowClear is false', async () => {
    render(
      <ModelWidget
        value={{ id: 'glm-5.2', provider: 'zhipu-coding' }}
        onSelect={vi.fn()}
        allowClear={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /zhipu-coding\/glm-5.2/ }));

    await waitFor(() => {
      expect(screen.getByText('GPT-4o')).toBeTruthy();
    });
    expect(screen.queryByTestId('model-widget-clear')).toBeNull();
  });
});
