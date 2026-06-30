# [Bug] Tool file-detail links lose session provenance

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `toolgroup-file-detail-link-context`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fix: preserve session link context for tool file-detail links`
Commits: `b9d8a730`

## Summary

Tool detail links rendered inside assistant tool groups can open with only `{ origin: 'session' }`, while normal markdown/file links in the same assistant message carry full session context such as `sessionPath`, `messageId`, and `blockIdx`. That makes file-detail links harder to resolve and inspect with the same provenance as surrounding message content.

## Expected

- Tool detail links receive the same session link context as other links in the assistant message block.
- Click and context-menu open paths both preserve `sessionPath`, `messageId`, and `blockIdx` when available.
- Existing tool groups outside a message context continue to work with a safe session-origin fallback.

## Actual

- `ToolGroupBlock` rendered detail links with a bare `{ origin: 'session' }` context.
- The click handler and context menu did not include the assistant message's full session provenance.

## Local fork fix

- Thread `linkContext` from `AssistantMessage` into `ToolGroupBlock`.
- Pass that context through `ToolIndicator` click and context-menu handlers.
- Keep a `{ origin: 'session' }` fallback for standalone tool groups.

## Verification

- Render a tool group with a file-detail link inside an assistant message.
- Click and right-click the detail link.
- Confirm `openInternalLink` receives the full session context including `sessionPath`, `messageId`, and `blockIdx`.
