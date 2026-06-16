/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AutoUpdateState, BuildInfo } from '../../../types';

const autoUpdateMock = vi.hoisted(() => ({
  state: { status: 'idle' } as AutoUpdateState,
}));

vi.mock('../../../hooks/use-auto-update-state', () => ({
  useAutoUpdateState: () => autoUpdateMock.state,
}));

vi.mock('../../widgets/Toggle', () => ({
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
  }: {
    on: boolean | undefined;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      aria-busy={on === undefined ? 'true' : undefined}
      aria-checked={on === undefined ? 'mixed' : on ? 'true' : 'false'}
      data-testid={`${ariaLabel || label}-${on === undefined ? 'loading' : on ? 'on' : 'off'}`}
      disabled={on === undefined}
      onClick={() => {
        if (on !== undefined) onChange(!on);
      }}
    >
      toggle
    </button>
  ),
}));

const autoSaveConfig = vi.fn();
const loadSettingsConfig = vi.fn();

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (...args: unknown[]) => autoSaveConfig(...args),
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: (...args: unknown[]) => loadSettingsConfig(...args),
}));

import { AboutTab } from '../AboutTab';
import { useSettingsStore } from '../../store';

afterEach(() => {
  cleanup();
  autoSaveConfig.mockReset();
  loadSettingsConfig.mockReset();
  autoUpdateMock.state = { status: 'idle' } as AutoUpdateState;
  useSettingsStore.setState({ settingsConfig: null });
  vi.unstubAllGlobals();
});

function createAutoUpdateState(status: AutoUpdateState['status']): AutoUpdateState {
  return {
    status,
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
  };
}

function installHana(buildInfo?: BuildInfo) {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      getAppVersion: vi.fn().mockResolvedValue('0.160.2'),
      getBuildInfo: vi.fn().mockResolvedValue(buildInfo ?? {
        appVersion: '0.160.2',
        channel: 'release',
        sourceRepo: 'liliMozi/openhanako',
        gitSha: null,
        baseTag: null,
        dirty: null,
        updateEnabled: true,
        signatureKind: null,
      }),
      autoUpdateCheck: vi.fn(),
      autoUpdateInstall: vi.fn(),
      autoUpdateSetChannel: vi.fn(),
      openExternal: vi.fn(),
    },
  }));
}

describe('AboutTab', () => {
  it('keeps startup and background controls out of the about page', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    expect(screen.getByText('settings.about.autoCheckUpdates')).toBeTruthy();
    expect(screen.getByText('settings.about.betaUpdates')).toBeTruthy();
    expect(screen.queryByText('settings.general.launchAtLogin')).toBeNull();
    expect(screen.queryByText('settings.general.keepAwake')).toBeNull();
  });

  it('keeps update switches in loading state until settings config is ready', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: null });

    render(<AboutTab />);

    const switches = screen.getAllByRole('button').filter(
      el => el.getAttribute('aria-checked') === 'mixed',
    ) as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    for (const item of switches) {
      expect(item.disabled).toBe(true);
      fireEvent.click(item);
    }
    expect(autoSaveConfig).not.toHaveBeenCalled();
    expect(loadSettingsConfig).not.toHaveBeenCalled();
  });

  it('shows local build identity and removes update controls when local updates are disabled', async () => {
    autoUpdateMock.state = createAutoUpdateState('disabled');
    installHana({
      appVersion: '0.323.0',
      channel: 'local',
      sourceRepo: 'karlorz/openhanako',
      gitSha: 'abc1234',
      baseTag: 'v0.323.0',
      dirty: false,
      updateEnabled: false,
      signatureKind: 'adhoc',
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'beta' } });

    render(<AboutTab />);

    expect(await screen.findByText('settings.about.localBuild')).toBeTruthy();
    expect(screen.getByText('karlorz/openhanako')).toBeTruthy();
    expect(screen.getByText('abc1234')).toBeTruthy();
    expect(screen.getByText('v0.323.0')).toBeTruthy();
    expect(screen.getByText('settings.about.updateDisabled')).toBeTruthy();
    expect(screen.queryByText('settings.about.updateCheckBtn')).toBeNull();
    expect(screen.queryByText('settings.about.autoCheckUpdates')).toBeNull();
    expect(screen.queryByText('settings.about.betaUpdates')).toBeNull();
  });
});
