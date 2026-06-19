# [Bug] LAN query-token URLs need referrer and redirect hardening

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `lan-query-token-network-hardening`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fold into LAN query-token/auth bug fix unless reviewed separately`
Commits: `7ff3ac38`

Related upstream issues:

- #1749: https://github.com/liliMozi/openhanako/issues/1749
- #1811: https://github.com/liliMozi/openhanako/issues/1811

## Summary

LAN desktop connections need query-token fallback for browser `WebSocket` and other browser-loadable URLs, because those APIs cannot attach an `Authorization` header. Once a device credential can appear in URLs, renderer pages and server responses should prevent `Referer` leakage. Any Electron main-process connection probe used to work around renderer CSP should also block redirects so an initial trusted probe cannot silently expand to another network target.

## Expected

- Renderer HTML uses `Referrer-Policy: no-referrer` or an equivalent referrer policy.
- Server responses set `Referrer-Policy: no-referrer` or an equivalent header.
- Main-process connection probes use non-following fetches and reject redirects.
- LAN query-token support does not introduce credential leakage through browser referrers or redirect-following probes.

## Actual

- LAN query-token support can place a device credential in URL query strings for WebSocket/resource-style browser loads.
- Without a referrer policy, any future external navigation or third-party subresource path can leak the credential-bearing URL.
- A main-process probe that follows redirects can be turned into a broader network probe than the user-entered server URL.

## Related issues

- #1749 covers the original LAN/Tailscale CSP and WebSocket auth regression.
- #1811 is a newer LAN WebSocket auth and CSP reconnect report.

## Local fork fix

- Add `<meta name="referrer" content="no-referrer">` to renderer HTML entry points.
- Add `Referrer-Policy: no-referrer` to server responses before route handling.
- Use `redirect: "manual"` in the Electron `connect:probe` login and identity fetches and reject 3xx responses.
