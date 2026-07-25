import { describe, expect, it, vi } from 'vitest';

import { bindSessionForegroundConvergence } from '../../services/session-foreground-convergence';

describe('bindSessionForegroundConvergence', () => {
  it('refreshes sessions then reconciles when the renderer becomes visible', async () => {
    const listeners = new Map<string, () => void>();
    const windowObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(`window:${type}`, listener)),
      removeEventListener: vi.fn(),
    };
    let visibilityState: Document['visibilityState'] = 'hidden';
    const documentObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(`document:${type}`, listener)),
      removeEventListener: vi.fn(),
      get visibilityState() {
        return visibilityState;
      },
    };
    const refreshSessions = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => undefined);

    const dispose = bindSessionForegroundConvergence({
      refreshSessions,
      reconcile,
      reason: 'desktop_foreground_refresh',
      windowObj: windowObj as never,
      documentObj: documentObj as never,
      minIntervalMs: 0,
      now: () => 100,
    });

    listeners.get('window:focus')?.();
    expect(refreshSessions).not.toHaveBeenCalled();

    visibilityState = 'visible';
    listeners.get('document:visibilitychange')?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('desktop_foreground_refresh');

    dispose();
    expect(windowObj.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(windowObj.removeEventListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(documentObj.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('deduplicates concurrent focus signals into one in-flight run', async () => {
    const listeners = new Map<string, () => void>();
    const windowObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(`window:${type}`, listener)),
      removeEventListener: vi.fn(),
    };
    const documentObj = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible' as Document['visibilityState'],
    };
    let resolveRefresh: (() => void) | undefined;
    const refreshSessions = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    const reconcile = vi.fn(async () => undefined);

    bindSessionForegroundConvergence({
      refreshSessions,
      reconcile,
      windowObj: windowObj as never,
      documentObj: documentObj as never,
      minIntervalMs: 0,
      now: () => 50,
    });

    listeners.get('window:focus')?.();
    listeners.get('window:online')?.();
    expect(refreshSessions).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('stops before reconcile when the refresh gate returns false', async () => {
    const listeners = new Map<string, () => void>();
    const windowObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(`window:${type}`, listener)),
      removeEventListener: vi.fn(),
    };
    const documentObj = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible' as Document['visibilityState'],
    };
    const refreshSessions = vi.fn(async () => false);
    const reconcile = vi.fn(async () => undefined);

    bindSessionForegroundConvergence({
      refreshSessions,
      reconcile,
      windowObj: windowObj as never,
      documentObj: documentObj as never,
      minIntervalMs: 0,
      now: () => 75,
    });

    listeners.get('window:focus')?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
