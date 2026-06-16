# [Bug] Remote plugin iframe URLs expose device credentials in query strings

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `plugin-iframe-remote-credential-query-leak`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fold into LAN query-token/auth bug fix unless reviewed separately`
Commits: `uncommitted`

Related upstream issues:

- #1493: https://github.com/liliMozi/openhanako/issues/1493
- #1546: https://github.com/liliMozi/openhanako/issues/1546

## Summary

After LAN query-token support, the desktop plugin surface URL builder can place the remote device credential into a plugin iframe URL as `token=[REDACTED:device-credential]`. Query strings are visible through browser history, logs, screenshots, and referrer-adjacent tooling, so remote device credentials should not be carried this way.

## Expected

- Local owner connections may continue using the local loopback query token path required for iframe loading.
- Remote plugin iframe URLs should use scoped iframe/session credentials such as `pluginIframeTicket` and `pluginSurfaceSession`.
- Remote device credentials should not appear in plugin iframe query strings.

## Actual

- Remote plugin iframe URLs can include `token=[REDACTED:device-credential]`.
- The hook already has scoped plugin iframe/session values available, but the generic query-token path can override the safer remote behavior.

## Related issues

- #1493 covers missing credentials for local plugin iframe surfaces.
- #1546 is an older plugin iframe loading bug.
- #1749 covers the LAN query-token/CSP/WebSocket regression boundary.

## Local fork fix

In `buildPluginSurfaceUrl`, append a query `token` only for `isLocalOwnerConnection(connection)`. Remote plugin iframe URLs keep using the issued plugin iframe ticket/session fields.
