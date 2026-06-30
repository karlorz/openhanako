# [Bug] Regenerate on image turns can replay unsupported direct image payloads

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `session-replay-marker-only-image-regenerate`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fix: replay persisted marker-only image turns without provider image_url rejection`
Commits: `4c82293b`

## Summary

Regenerating a persisted user turn that contains only `[attached_image: ...]` markers can fail with HTTP 400. The replay path can rebuild direct image payloads from persisted marker text instead of preserving the original marker/path send semantics. Providers that reject that direct image payload variant, such as an `image_url`-style image block, then reject the replay request.

A related failure mode appears when large per-session metadata grows past the safe parse limit: the session index can fail to hydrate and chats may appear as `(no messages)` even though their JSONL transcript still exists.

## Expected

- Persisted marker-only image turns replay as path/marker-backed inputs, not synthesized direct provider image payloads.
- Trusted optimistic/display-message image attachments may still be used as a fallback before the user turn is persisted.
- Oversized aggregate `session-meta.json` files compact large snapshots into sidecars instead of dropping unrelated entries or becoming unreadable.
- Replay HTTP 400 errors expose useful server/provider error detail to the desktop UI.

## Actual

- Regenerate on a persisted image turn can reread the image path and send a direct image payload that differs from the original marker-backed submission.
- The provider can reject the generated payload and `/api/sessions/latest-user-message/replay` returns 400.
- Oversized session metadata can make affected chats show `(no messages)` after restart or session reload.

## Local fork fix

- Stop synthesizing direct image payloads for persisted marker-only replay turns.
- Keep direct image reconstruction only for trusted display attachments when no persisted source entry exists, such as optimistic client messages.
- Compact oversized `session-meta.json` by forcing medium prompt/memory snapshots into `session-meta-payloads/` sidecars, with path containment checks on hydration.
- Include JSON or text response-body detail in `hanaFetch` HTTP errors.

## Verification

- Create an image-backed user message and regenerate it after persistence.
- Confirm `/api/sessions/latest-user-message/replay` returns 200 instead of 400.
- Restart/reload and confirm the chat list still shows the original title/messages instead of `(no messages)`.
