// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachedFilesBar } from '../../components/input/AttachedFilesBar';
import { useStore } from '../../stores';

describe('AttachedFilesBar media chips', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useStore.setState({
      serverConnections: {},
      activeServerConnectionId: null,
      activeServerConnection: null,
    } as never);
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('renders image attachments with rounded thumbnail previews', () => {
    const onRemove = vi.fn();
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const { container } = render(<AttachedFilesBar
      files={[{ path: '/tmp/pasted.png', name: 'pasted.png', mimeType: 'image/png' }]}
      onRemove={onRemove}
    />);

    expect(screen.getByText('pasted.png')).toBeInTheDocument();
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'file:///tmp/pasted.png');
    expect(window.platform.getFileUrl).toHaveBeenCalledWith('/tmp/pasted.png');

    fireEvent.click(screen.getByLabelText('Remove pasted.png'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('renders remote session-file image attachments through resource URLs without inline bytes', () => {
    const onRemove = vi.fn();
    const remoteConnection = {
      connectionId: 'lan:remote:studio',
      kind: 'lan',
      serverId: 'remote',
      studioId: 'studio_remote',
      label: 'Remote Hana',
      baseUrl: 'http://100.125.173.118:14500',
      wsUrl: 'ws://100.125.173.118:14500',
      token: 'remote-token',
      authState: 'paired',
      trustState: 'lan',
      credentialKind: 'device_credential',
      platformAccountId: null,
      officialServiceKind: null,
      capabilities: ['chat', 'resources'],
    };
    useStore.setState({
      serverConnections: { [remoteConnection.connectionId]: remoteConnection },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
    } as never);
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const { container } = render(<AttachedFilesBar
      files={[{
        fileId: 'sf_pasted_image',
        path: '/root/.hanako/session-files/pasted.png',
        name: 'pasted.png',
        mimeType: 'image/png',
      } as never]}
      onRemove={onRemove}
    />);

    const image = container.querySelector('img');
    expect(image).toHaveAttribute(
      'src',
      'http://100.125.173.118:14500/api/resources/res_sf_pasted_image/content?token=remote-token',
    );
    expect(window.platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('renders audio attachments with a play control, fake waveform, and remove action', () => {
    const onRemove = vi.fn();
    const audioInstances: Array<{ src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = [];
    const AudioMock = vi.fn().mockImplementation(function MockAudio(this: {
      src: string;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
      onerror: (() => void) | null;
    }, src: string) {
      this.src = src;
      this.play = vi.fn(() => Promise.resolve());
      this.pause = vi.fn();
      this.onended = null;
      this.onerror = null;
      audioInstances.push(this);
    });
    vi.stubGlobal('Audio', AudioMock);
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const { container } = render(<AttachedFilesBar
      files={[{ path: '/tmp/clip.wav', name: 'clip.wav', mimeType: 'audio/wav' }]}
      onRemove={onRemove}
    />);

    expect(screen.getByTestId('audio-attachment-wave')).toBeInTheDocument();
    expect(screen.getByText('clip.wav')).toBeInTheDocument();
    expect(screen.getByLabelText('Play clip.wav')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Play clip.wav'));

    expect(AudioMock).toHaveBeenCalledWith('file:///tmp/clip.wav');
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Remove clip.wav'));

    expect(audioInstances[0].pause).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});
