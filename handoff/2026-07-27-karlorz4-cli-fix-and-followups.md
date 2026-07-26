# Handoff — OpenHanako CLI packaging + follow-ups (2026-07-27)

**Repo:** `karlorz/openhanako` · branch `dev`  
**Vault:** `projects/openhanako/` under `skillwiki path`  
**Handoff file:** `handoff/2026-07-27-karlorz4-cli-fix-and-followups.md`

## Saved items 1–3

| # | Item | Vault work item | Status |
|---|---|---|---|
| 1 | Treat Mobile UAT closed | `work/2026-07-27-mobile-session-loss-uat-closeout` | **completed** (UAT-01…09 PASS on `.3`) |
| 2 | HTTPS/WSS installed-PWA | `work/2026-07-27-mobile-https-wss-pwa-coverage` | **planned** — next product work |
| 3 | Packaged `hana` CLI `artifact-core` | `work/2026-07-27-packaged-hana-cli-artifact-core` | **in progress → close after `.5` host verify** |

Item 4 vault hygiene: already **completed** (origin clean).

## What happened this session

### Code

1. `eed8ffc4` — stage `shared/artifact-core/*` into server packs  
2. Host verify on **`v0.416.51-karlorz.4`**: `activation.cjs` present, but  
   `hana --help` still failed: **`Cannot find module '../contract-versions.cjs'`**  
   from `ota-core.cjs`.  
3. `4d67c5bd` — also stage **`shared/contract-versions.cjs`**  
4. Digests/tags: **`.4`** (`117c9906`) published and **deployed to sg01**; **`.5`** (`17908bc0`) tagged for the transitive fix.

### Host state at handoff write time

| Field | Value |
|---|---|
| sg01 before this work | `v0.416.51-karlorz.3` |
| sg01 after `.4` upgrade | **`v0.416.51-karlorz.4`** active, Mobile 200, `CORE_OK` dir present |
| `.4` CLI result | **FAIL** missing `contract-versions.cjs` |
| `.5` Build | run **`30215101727`** (must finish green before upgrade) |
| Backup pre-`.4` | `/opt/hanaagent/backups/hanaagent-backup-2026-07-26T18-36-00-pre-v0.416.51-karlorz.4.tar.gz` |

## New session — do this first (item 3 closeout)

```bash
# 1) Wait for release
gh run watch 30215101727 --repo karlorz/openhanako --exit-status
gh release view v0.416.51-karlorz.5 --repo karlorz/openhanako --json assets --jq '.assets[].name' | rg linux-arm64

# 2) Upgrade sg01
ssh sg01 '
  set -euo pipefail
  TS=$(date -u +%Y-%m-%dT%H-%M-%S)
  install-server backup --output /opt/hanaagent/backups/hanaagent-backup-${TS}-pre-v0.416.51-karlorz.5.tar.gz
  install-server upgrade --version v0.416.51-karlorz.5 --channel prerelease \
    --current-version v0.416.51-karlorz.4 --execute
  # wait for listen
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:14500/mobile/ | grep -q 200 && break
    sleep 2
  done
  test -f /opt/hanaagent/current/shared/artifact-core/activation.cjs
  test -f /opt/hanaagent/current/shared/contract-versions.cjs
  /opt/hanaagent/current/hana --help | head -40
  echo EXIT:$?
  install-server status --json | head -c 1500
'
```

### Pass criteria (close item 3)

- [ ] Build `30215101727` success  
- [ ] sg01 `current` → `…/v0.416.51-karlorz.5-linux-arm64`  
- [ ] `hana --help` exit 0  
- [ ] both `shared/artifact-core/activation.cjs` and `shared/contract-versions.cjs` exist  
- [ ] `/mobile/` HTTP 200  
- [ ] Mark vault work item completed + log append  

## New session — next product work (item 2)

After CLI green:

```text
Office-hours / prep:
  projects/openhanako/work/2026-07-27-mobile-https-wss-pwa-coverage/spec.md
Questions: cert source (ACME vs internal vs self-signed), :443 vs reverse
proxy, secure cookie flags for Mobile web-auth.
```

Related UAT report (already PASS):  
`projects/openhanako/work/2026-07-26-mobile-pwa-session-loss-recovery/uat-sg01.md`

## Do not

- Merge permanent draft PR #1  
- Re-run full Mobile UAT matrix unless HTTPS changes behavior  
- Touch untracked `scripts/hana-session-identity-repro.mjs`  
- Deploy from local build; use install-server + published tag only  

## Safe first prompt for new session

```text
Read handoff/2026-07-27-karlorz4-cli-fix-and-followups.md.
Finish v0.416.51-karlorz.5 Build 30215101727 if needed, upgrade sg01 from .4→.5,
prove hana --help exits 0, close vault work item packaged-hana-cli-artifact-core,
then start office-hours on mobile-https-wss-pwa-coverage.
```

## Key commits

| SHA | Note |
|---|---|
| `eed8ffc4` | ship artifact-core dir |
| `4d67c5bd` | ship contract-versions |
| `117c9906` | release prep `.4` |
| `17908bc0` | release prep `.5` |
