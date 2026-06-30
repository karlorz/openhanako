# Upstream Issue Tracking

This file tracks local fork fixes against upstream GitHub issues. The source of truth for the tracked fix list is `scripts/track-upstream-issues.mjs`.

| fix | classification | status | upstream | grouping |
|---|---|---|---|---|
| lan-csp-ws-auth | upstream | existing/open | [#1749](https://github.com/liliMozi/openhanako/issues/1749) OPEN, [#1811](https://github.com/liliMozi/openhanako/issues/1811) CLOSED | LAN query-token/auth bug fix |
| lan-query-token-network-hardening | upstream | draft/pending-approval | [#1749](https://github.com/liliMozi/openhanako/issues/1749) OPEN, [#1811](https://github.com/liliMozi/openhanako/issues/1811) CLOSED | fold into LAN query-token/auth bug fix unless reviewed separately |
| remote-attachment-preview-persistence | upstream | draft/pending-approval | none | fix: preserve remote session attachment previews |
| desktop-temp-upload-session-cache-materialization | upstream | draft/pending-approval | none | fix: materialize temp uploads to session cache before send |
| remote-skill-viewer-local-file-ipc | upstream | draft/pending-approval | none | fix: preview remote server skills through active server APIs |
| remote-skill-install-client-local-path | upstream | draft/pending-approval | none | fix: upload remote skill packages instead of posting client-local paths |
| plugin-iframe-remote-credential-query-leak | upstream | draft/pending-approval | [#1493](https://github.com/liliMozi/openhanako/issues/1493) OPEN, [#1546](https://github.com/liliMozi/openhanako/issues/1546) CLOSED | fold into LAN query-token/auth bug fix unless reviewed separately |
| local-build-identity-disable-auto-update | fork-only | tracked/no-upstream-issue | none | chore: identify local fork builds and disable local auto-update |
| fork-sync-issue-tracking-prerelease-policy | fork-only | tracked/no-upstream-issue | none | docs: add fork sync policy and upstream issue helper |
| fork-dev-loop-maintenance-runbooks | fork-only | tracked/no-upstream-issue | none | docs/chore: dev-loop setup and retired sg01 deploy helper |
| office-workflow-example-plugin | fork-only | tracked/no-upstream-issue | none | examples/plugins: office-workflow template and lint hygiene |
| office-workflow-resourceio-session-permission | fork-only | tracked/no-upstream-issue | none | examples/plugins: document ResourceIO and sessionPermission boundary |
| server-install-upgrade-release-safety | fork-only | tracked/no-upstream-issue | none | install-server: verified release assets, safe upgrade, preserved service context |
| server-reinit-data-failsafe | fork-only | tracked/no-upstream-issue | none | install-server: backup-gated reinit-data with operational preserve and latest full-state restore |
| server-reinit-restore-backup-verification | fork-only | tracked/no-upstream-issue | none | install-server: reject wrong-root restore backups before data-root replacement |
| node-test-ci-file-mode-hygiene | fork-only | tracked/no-upstream-issue | none | tests/lint: .mjs node tests, LF enforcement, and eslint coverage |

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
