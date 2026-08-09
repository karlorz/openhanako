# Upstream Issue Tracking

This file tracks local fork fixes against upstream GitHub issues. The source of truth for the tracked fix list is `scripts/track-upstream-issues.mjs`.

| fix | classification | status | upstream | grouping |
|---|---|---|---|---|
| lan-csp-ws-auth | upstream | existing/open | [#1749](https://github.com/liliMozi/openhanako/issues/1749) OPEN, [#1811](https://github.com/liliMozi/openhanako/issues/1811) CLOSED | LAN query-token/auth bug fix |
| lan-query-token-network-hardening | upstream | draft/pending-approval | [#1749](https://github.com/liliMozi/openhanako/issues/1749) OPEN, [#1811](https://github.com/liliMozi/openhanako/issues/1811) CLOSED | fold into LAN query-token/auth bug fix unless reviewed separately |
| remote-attachment-preview-persistence | upstream | draft/pending-approval | [#2188](https://github.com/liliMozi/openhanako/issues/2188) OPEN | fix: preserve remote session attachment previews |
| desktop-temp-upload-session-cache-materialization | upstream | draft/pending-approval | none | fix: materialize temp uploads to session cache before send |
| session-replay-marker-only-image-regenerate | upstream | draft/pending-approval | none | fix: replay persisted marker-only image turns without provider image_url rejection |
| toolgroup-file-detail-link-context | upstream | draft/pending-approval | none | fix: preserve session link context for tool file-detail links |
| provider-model-removal-persistence | upstream | draft/pending-approval | none | fix: make provider model removal persist for slash-bearing local provider models |
| vision-capability-settings-sot | upstream | local-verified | [#1904](https://github.com/liliMozi/openhanako/issues/1904) OPEN, [#538](https://github.com/liliMozi/openhanako/issues/538) OPEN, [#594](https://github.com/liliMozi/openhanako/issues/594) OPEN, [#1854](https://github.com/liliMozi/openhanako/issues/1854) CLOSED, [#1919](https://github.com/liliMozi/openhanako/issues/1919) CLOSED | fix: provider catalog is SoT for vision capability; no dictionary-only UI lie |
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
| legacy-raw-release-profile-evidence | fork-only | tracked/no-upstream-issue | none | ci/release: explicit signed and legacy-raw fallback with runtime-only server evidence |
| packaged-cli-shared-cjs-externalize | fork-only | local-verified | none | packaging/cli: stage shared artifact-core + externalize CJS-with-builtin-requires from the esbuild ESM CLI bundle |
| loopback-trusted-https-proxy-secure-cookies | fork-only | local-verified | none | server/auth: inferHttpRequestSecurity + HANA_SECURE_COOKIES for Caddy-terminated HTTPS/WSS Mobile |
| data-epoch-windows-fail-closed-timeout | fork-only | local-verified | none | tests/ci: Windows PR dashboard flake on multi-fault data-epoch coordinator loop |
| sg01-public-https-caddy-ops-docs | fork-only | tracked/no-upstream-issue | none | docs/ops: sg01 HTTPS/Caddy/14500 boundary and Cloudflare DNS-only decision |

## Rules

- Track every local fix or maintenance slice.
- Search upstream for every `upstream` or `needs-triage` item.
- Keep `fork-only` items documented without upstream issue noise.
- Draft issue bodies locally first. Codex and Claude never submit them; human review changes wording only.
- Only a human acting manually outside an agent session may publish an approved draft.
- Do not store live credentials, tokens, cookies, or server secrets in drafts.

## Commands

```bash
node scripts/track-upstream-issues.mjs status
node scripts/track-upstream-issues.mjs search
node scripts/track-upstream-issues.mjs draft
```
