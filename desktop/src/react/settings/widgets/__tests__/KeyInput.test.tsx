/**
 * @vitest-environment jsdom
 *
 * KeyInput migration contract: revealed secrets must re-hide when the
 * controlled value is replaced externally (remote recovery / credential reset).
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { KeyInput } from '../KeyInput';

afterEach(() => {
  cleanup();
});

describe('KeyInput', () => {
  it('re-hides and replaces a revealed secret when the controlled value changes externally', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<KeyInput value="old-secret" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByDisplayValue('old-secret')).toHaveAttribute('type', 'text');

    rerender(<KeyInput value="new-secret" onChange={onChange} />);

    expect(screen.getByDisplayValue('new-secret')).toHaveAttribute('type', 'password');
    expect(onChange).not.toHaveBeenCalledWith('old-secret');
  });
});
