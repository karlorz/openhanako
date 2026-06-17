# [Bug] Remote desktop session attachments lose previews after switching chats

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `remote-attachment-preview-persistence`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fix: preserve remote session attachment previews`
Commits: `434c3e30`

## Summary

When the macOS desktop app is connected to a remote Hana server, pasted or uploaded local files can be persisted in a form that the remote Linux server cannot later resolve. The current chat can show transient inline bytes, but after switching chats and returning, chat thumbnails and Conversation Files previews can disappear.

## Expected

- Local desktop-owned files are uploaded to the active remote server before send.
- Persisted remote session files resolve through server resource URLs.
- Runtime CSP allows only the active remote HTTP(S) origin for image and media previews.
- Chat thumbnails and Conversation Files previews survive chat switching.

## Actual

- The remote server can receive local macOS paths it cannot import.
- Previews may rely on transient inline bytes that disappear after the active chat changes.
- Older session attachments may no longer render in Conversation Files.

## Local fork fix

- Upload client-owned desktop files through `/api/upload-blob` when connected to a remote server.
- Synthesize `/api/resources/res_<fileId>/content` URLs for remote session files when no explicit resource link exists.
- Scope the active remote HTTP(S) origin into runtime CSP `img-src` and `media-src` without widening to bare `http:` or `https:`.

## Verification

- Paste or upload an image through a remote desktop connection.
- Send it, switch to another chat, then return.
- Confirm both the chat thumbnail and Conversation Files preview still render.
