# Upstream Issue Tracking

This file tracks local fork fixes against upstream GitHub issues. The source of truth for the tracked fix list is `scripts/track-upstream-issues.mjs`.

| fix | classification | status | upstream | grouping |
|---|---|---|---|---|
| lan-csp-ws-auth | upstream | existing/open | [#1749](https://github.com/liliMozi/openhanako/issues/1749) | LAN query-token/auth bug fix |
| remote-attachment-preview-persistence | upstream | draft/pending-approval | none | fix: preserve remote session attachment previews |
| plugin-iframe-remote-credential-query-leak | upstream | draft/pending-approval | [#1493](https://github.com/liliMozi/openhanako/issues/1493), [#1546](https://github.com/liliMozi/openhanako/issues/1546) | fold into LAN query-token/auth bug fix unless reviewed separately |
| local-build-identity-disable-auto-update | fork-only | tracked/no-upstream-issue | none | chore: identify local fork builds and disable local auto-update |
| fork-sync-issue-tracking-prerelease-policy | fork-only | tracked/no-upstream-issue | none | docs: add fork sync policy and upstream issue helper |

## Rules

- Track every local fix or maintenance slice.
- Search upstream for every `upstream` or `needs-triage` item.
- Keep `fork-only` items documented without upstream issue noise.
- Draft issue bodies locally first. Submit only after explicit owner approval.
- Do not store live credentials, tokens, cookies, or server secrets in drafts.

## Commands

```bash
node scripts/track-upstream-issues.mjs status
node scripts/track-upstream-issues.mjs search
node scripts/track-upstream-issues.mjs draft
```
