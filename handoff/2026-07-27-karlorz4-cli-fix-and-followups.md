# Handoff — OpenHanako CLI packaging + follow-ups (2026-07-27)

**Repo:** `karlorz/openhanako` · branch `dev`  
**Vault:** `projects/openhanako/`  
**This file:** `handoff/2026-07-27-karlorz4-cli-fix-and-followups.md` (also on `dev`)

## Saved items 1–3

| # | Item | Work item | Status |
|---|---|---|---|
| **1** | Treat Mobile UAT closed | `work/2026-07-27-mobile-session-loss-uat-closeout` | **completed** |
| **2** | HTTPS/WSS installed-PWA | `work/2026-07-27-mobile-https-wss-pwa-coverage` | **planned** — next product work after CLI green |
| **3** | Packaged `hana` CLI | `work/2026-07-27-packaged-hana-cli-artifact-core` | **close after `.6` host verify** |

Vault hygiene (item 4 earlier) is **done**.

## Reality on host (important)

| Tag | Deployed? | `hana --help` |
|---|---|---|
| `.3` | previous | missing `artifact-core` |
| **`.4`** | yes (then superseded) | missing `contract-versions.cjs` |
| **`.5`** | **current until `.6`** | missing `contract-versions.json` |
| **`.6`** | Build **`30216319230`** → then upgrade | expected **PASS** |

sg01 was left on **`v0.416.51-karlorz.5`** with Mobile healthy (`/mobile/` 200). CLI still broken until `.6`.

### Why the thrash

Packaged `bundle/cli.js` uses `createRequire` for:

```text
../shared/artifact-core/{activation,pointer-*,ota-core,keyset,...}.cjs
ota-core → ../contract-versions.cjs → ./contract-versions.json
```

Fix commits on `dev`:

| SHA | What |
|---|---|
| `eed8ffc4` | ship artifact-core dir |
| `4d67c5bd` | ship contract-versions.cjs |
| `55c867b6` | ship contract-versions.json |
| `fff2de62` | release prep **`.6`** |

Files list: `PACKAGED_CLI_ARTIFACT_CORE_FILES` in `scripts/build-server-runtime-assets.mjs`.

## New session — first commands

```bash
# 1) Finish release if needed
gh run watch 30216319230 --repo karlorz/openhanako --exit-status
gh release view v0.416.51-karlorz.6 --repo karlorz/openhanako --json assets --jq '[.assets[].name]|map(select(test("linux-arm64")))'

# 2) Upgrade sg01 .5 → .6
ssh sg01 '
  set -euo pipefail
  TS=$(date -u +%Y-%m-%dT%H-%M-%S)
  install-server backup --output /opt/hanaagent/backups/hanaagent-backup-${TS}-pre-v0.416.51-karlorz.6.tar.gz
  install-server upgrade --version v0.416.51-karlorz.6 --channel prerelease \
    --current-version v0.416.51-karlorz.5 --execute
  for i in $(seq 1 15); do
    curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:14500/mobile/ | grep -q 200 && break
    sleep 2
  done
  test -f /opt/hanaagent/current/shared/artifact-core/activation.cjs
  test -f /opt/hanaagent/current/shared/contract-versions.cjs
  test -f /opt/hanaagent/current/shared/contract-versions.json
  /opt/hanaagent/current/hana --help | head -40
  echo HELP_EXIT:$?
  install-server status --json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[\"installedRelease\"]);print(d[\"service\"])"
'

# 3) If HELP_EXIT=0: mark vault work item completed + append log
# 4) If still failing: dump missing module path, walk require graph again
#    (prefer recursive pack helper over more one-off files)
```

### Closeout for item 3

- [ ] Build 30216319230 green  
- [ ] Host `v0.416.51-karlorz.6`  
- [ ] `hana --help` exit 0  
- [ ] activation + contract-versions.{cjs,json} present  
- [ ] Mobile 200  
- [ ] Vault work item → `completed`  

Optional hardening (not blocking close if help works): unit/integration test that runs packaged `hana --help` from a minimal staged tree (or post-pack smoke in CI).

## Then start item 2

```text
Office-hours / prep:
  projects/openhanako/work/2026-07-27-mobile-https-wss-pwa-coverage/spec.md
```

Mobile UAT already PASS on `.3` HTTP:  
`work/2026-07-26-mobile-pwa-session-loss-recovery/uat-sg01.md`

## Do not

- Merge PR #1  
- Full UAT re-run unless HTTPS changes auth  
- Touch `scripts/hana-session-identity-repro.mjs`  
- Local-build deploy; use install-server + tag only  

## Paste into new session

```text
Read handoff/2026-07-27-karlorz4-cli-fix-and-followups.md.
Finish v0.416.51-karlorz.6 Build 30216319230, upgrade sg01 from .5→.6,
prove hana --help exits 0, close work/2026-07-27-packaged-hana-cli-artifact-core,
then office-hours on work/2026-07-27-mobile-https-wss-pwa-coverage.
```
