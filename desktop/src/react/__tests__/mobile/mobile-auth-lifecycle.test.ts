import { describe, expect, it } from 'vitest';

import {
  classifyMobileAuthFailure,
  createMobileRecoverySnapshot,
  extractStableMobileAuthority,
  filterSafeInlineAttachments,
  restoreMobileRecoverySnapshot,
  sanitizeMobileRecoveryDraftDoc,
  sameMobileAuthority,
} from '../../mobile/mobile-auth-lifecycle';
import { HanaHttpError } from '../../services/hana-http-error';

const baseAuthority = {
  serverNodeId: 'node-1',
  serverId: 'server-fallback',
  userId: 'user-1',
  studioId: 'studio-1',
};

describe('mobile auth lifecycle', () => {
  describe('stable authority', () => {
    it('matches the exact server-node, user, and studio tuple while ignoring credential rotation', () => {
      expect(sameMobileAuthority(
        { ...baseAuthority, credentialId: 'credential-old', deviceId: 'device-old' },
        { ...baseAuthority, credentialId: 'credential-new', deviceId: 'device-new' },
      )).toBe(true);

      expect(sameMobileAuthority(baseAuthority, { ...baseAuthority, serverNodeId: 'node-2' })).toBe(false);
      expect(sameMobileAuthority(baseAuthority, { ...baseAuthority, userId: 'user-2' })).toBe(false);
      expect(sameMobileAuthority(baseAuthority, { ...baseAuthority, studioId: 'studio-2' })).toBe(false);
    });

    it('uses serverId only when serverNodeId is absent', () => {
      expect(extractStableMobileAuthority({
        serverId: 'server-1',
        userId: 'user-1',
        studioId: 'studio-1',
      })).toMatchObject({ serverAuthorityId: 'server-1' });

      expect(sameMobileAuthority(
        { ...baseAuthority, serverNodeId: null, serverId: 'server-1' },
        { ...baseAuthority, serverNodeId: '', serverId: 'server-1' },
      )).toBe(true);
    });

    it('requires a complete exact official-service extension when either side is official', () => {
      const official = {
        ...baseAuthority,
        officialServiceKind: 'wechat',
        platformAccountId: 'account-1',
      };

      expect(sameMobileAuthority(official, { ...official })).toBe(true);
      expect(sameMobileAuthority(official, {
        ...official,
        platformAccountId: 'account-2',
      })).toBe(false);
      expect(sameMobileAuthority(official, {
        ...baseAuthority,
        officialServiceKind: null,
        platformAccountId: null,
      })).toBe(false);
      expect(sameMobileAuthority(official, {
        ...official,
        platformAccountId: null,
      })).toBe(false);
    });

    it('denies unverifiable authorities with missing required fields', () => {
      expect(extractStableMobileAuthority({ ...baseAuthority, serverNodeId: null, serverId: null })).toBeNull();
      expect(extractStableMobileAuthority({ ...baseAuthority, userId: '' })).toBeNull();
      expect(extractStableMobileAuthority({ ...baseAuthority, studioId: undefined })).toBeNull();
      expect(extractStableMobileAuthority({
        ...baseAuthority,
        officialServiceKind: 'wechat',
        platformAccountId: null,
      })).toBeNull();
      expect(sameMobileAuthority(baseAuthority, { ...baseAuthority, userId: null })).toBe(false);
    });
  });

  describe('HTTP auth-loss decisions', () => {
    it.each(['missing_credential', 'invalid_credential', 'auth_failed'])(
      'treats structured %s on 401/403 as session loss',
      (reason) => {
        expect(classifyMobileAuthFailure(new HanaHttpError({ status: 403, reason })))
          .toBe('session-lost');
      },
    );

    it('requires confirmation for an unstructured 401/403', () => {
      expect(classifyMobileAuthFailure(new HanaHttpError({ status: 401 }))).toBe('confirm-session');
      expect(classifyMobileAuthFailure(new HanaHttpError({ status: 403, detail: 'Forbidden' })))
        .toBe('confirm-session');
    });

    it('ignores unrelated structured 403s and non-auth failures', () => {
      expect(classifyMobileAuthFailure(new HanaHttpError({
        status: 403,
        reason: 'insufficient_scope',
      }))).toBe('ignore');
      expect(classifyMobileAuthFailure(new HanaHttpError({
        status: 500,
        reason: 'auth_failed',
      }))).toBe('ignore');
      expect(classifyMobileAuthFailure(new Error('403 missing_credential'))).toBe('ignore');
    });
  });

  describe('safe recovery state', () => {
    const inline = {
      path: 'clipboard://image-1',
      name: 'pasted.png',
      isDirectory: false,
      base64Data: 'aW1hZ2U=',
      mimeType: 'image/png',
    };

    it('keeps only untouched inline attachment bytes without a server fileId', () => {
      const safe = filterSafeInlineAttachments([
        inline,
        { ...inline, path: 'server-owned', fileId: 'file-1' },
        { ...inline, path: 'path-only', base64Data: undefined },
        { ...inline, path: 'blank-inline', base64Data: '  ' },
        {
          ...inline,
          path: 'sanitized',
          uploadId: 'upload-1',
          resourceId: 'resource-1',
        } as typeof inline & { uploadId: string; resourceId: string },
      ]);

      expect(safe).toEqual([
        inline,
        { ...inline, path: 'sanitized' },
      ]);
      expect(safe[0]).not.toBe(inline);
    });

    it('restores selected-session draft state only for the same authority and an existing chat', () => {
      const snapshot = createMobileRecoverySnapshot({
        authority: baseAuthority,
        selectedSessionPath: '/sessions/one',
        draftText: 'unsent text',
        draftDoc: { type: 'doc', content: [{ type: 'paragraph' }] },
        attachments: [inline, { ...inline, fileId: 'file-1' }],
      });

      expect(snapshot).not.toBeNull();
      expect(restoreMobileRecoverySnapshot(snapshot, {
        authority: { ...baseAuthority, credentialId: 'rotated' },
        availableSessionPaths: ['/sessions/one', '/sessions/two'],
      })).toMatchObject({
        selectedSessionPath: '/sessions/one',
        draftText: 'unsent text',
        attachments: [inline],
      });

      expect(restoreMobileRecoverySnapshot(snapshot, {
        authority: { ...baseAuthority, userId: 'different-user' },
        availableSessionPaths: ['/sessions/one'],
      })).toBeNull();
      expect(restoreMobileRecoverySnapshot(snapshot, {
        authority: baseAuthority,
        availableSessionPaths: ['/sessions/two'],
      })).toBeNull();
    });

    it.each([
      {
        label: 'fileBadge node',
        content: [{
          type: 'paragraph',
          content: [{ type: 'fileBadge', attrs: { fileId: 'file-1' } }],
        }],
      },
      {
        label: 'fileId',
        content: [{ type: 'paragraph', attrs: { fileId: 'file-1' } }],
      },
      {
        label: 'resourceId',
        content: [{ type: 'paragraph', attrs: { nested: { resourceId: 'resource-1' } } }],
      },
      {
        label: 'uploadId',
        content: [{ type: 'paragraph', marks: [{ type: 'link', attrs: { uploadId: 'upload-1' } }] }],
      },
      {
        label: 'leaseId',
        content: [{ type: 'paragraph', attrs: { leaseId: 'lease-1' } }],
      },
    ])('drops a rich draft containing a server-owned $label but preserves its text', ({ content }) => {
      const snapshot = createMobileRecoverySnapshot({
        authority: baseAuthority,
        selectedSessionPath: '/sessions/one',
        draftText: 'safe text fallback',
        draftDoc: { type: 'doc', content },
        attachments: [],
      });

      expect(snapshot).toMatchObject({
        draftText: 'safe text fallback',
        draftDoc: null,
      });
    });

    it('clones a recursively safe rich draft so later mutations cannot add retained authority', () => {
      const draftDoc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'safe unsent text' }],
        }],
      };

      const sanitized = sanitizeMobileRecoveryDraftDoc(draftDoc);
      expect(sanitized).toEqual(draftDoc);
      expect(sanitized).not.toBe(draftDoc);

      draftDoc.content[0].content[0] = {
        type: 'fileBadge',
        text: 'unsafe later mutation',
      };
      expect(sanitized).toEqual({
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'safe unsent text' }],
        }],
      });
    });

    it('does not capture recovery state for an unverifiable authority', () => {
      expect(createMobileRecoverySnapshot({
        authority: { ...baseAuthority, userId: null },
        selectedSessionPath: '/sessions/one',
        draftText: 'do not retain',
        draftDoc: null,
        attachments: [inline],
      })).toBeNull();
    });
  });
});
