# Handoff — OpenHanako CLI packaging + follow-ups

**Saved for new session · 2026-07-27**  
**Repo:** `karlorz/openhanako` · branch `dev` (in sync with `origin/dev` at last save)  
**Vault:** `skillwiki path` → `projects/openhanako/`  
**This file:** `handoff/2026-07-27-karlorz4-cli-fix-and-followups.md`

---

## Session stop line

CI for **`v0.416.51-karlorz.6`** was still **in progress** when this session stopped.  
**Do not assume the release is published.** Finish CI → upgrade sg01 → prove CLI in the **new session**.

| Check | Last known state |
|---|---|
| Build `.6` | run **`30216319230`** — was `in_progress` (URL below) |
| sg01 installed | **`v0.416.51-karlorz.5`** · service **active** · Mobile OK |
| `hana --help` on host | **fails** (exit 1) until `.6` lands with `contract-versions.json` |
| Working tree | clean except a temporary session-identity diagnostic (removed during later cleanup) |

Build URL: https://github.com/karlorz/openhanako/actions/runs/30216319230  
Release (when ready): https://github.com/karlorz/openhanako/releases/tag/v0.416.51-karlorz.6

---

## Saved items 1–3

| # | Item | Work item | Status |
|---|---|---|---|
| **1** | Mobile UAT closed | `work/2026-07-27-mobile-session-loss-uat-closeout` | **completed** (UAT-01…09 PASS on `.3`) |
| **2** | HTTPS/WSS installed-PWA | `work/2026-07-27-mobile-https-wss-pwa-coverage` | **planned** — start after item 3 green |
| **3** | Packaged `hana` CLI | `work/2026-07-27-packaged-hana-cli-artifact-core` | **open until `.6` host verify** |

Related UAT evidence: `work/2026-07-26-mobile-pwa-session-loss-recovery/uat-sg01.md` (`status: passed`).

---

## What already shipped (code + tags)

| SHA | Note |
|---|---|
| `eed8ffc4` | Stage `shared/artifact-core/*` into server packs |
| `4d67c5bd` | Stage `shared/contract-versions.cjs` |
| `55c867b6` | Stage `shared/contract-versions.json` ← needed for `.6` |
| `fff2de62` | `chore(release): prepare v0.416.51-karlorz.6` |
| `87bdac19` | Prior handoff pointing at `.6` |

Host thrash (for context only):

| Tag | Result |
|---|---|
| `.4` | Deployed; still missing `contract-versions.cjs` |
| `.5` | **Currently on sg01**; still missing `contract-versions.json` |
| `.6` | Tag pushed; **CI was not finished** in this session |

List of staged files: `PACKAGED_CLI_ARTIFACT_CORE_FILES` in  
`scripts/build-server-runtime-assets.mjs` (wired from `build-server.mjs` + `build-server-open.mjs`).

---

## New session — do this first

### A. CI + publish

```bash
cd /Users/karlchow/Desktop/code/openhanako
gh run watch 30216319230 --repo karlorz/openhanako --exit-status
# if failed: gh run view 30216319230 --log-failed
gh release view v0.416.51-karlorz.6 --repo karlorz/openhanako \
  --json assets --jq '[.assets[].name] | map(select(test("linux-arm64")))'
```

### B. Upgrade sg01 `.5` → `.6` and prove CLI

```bash
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
```

### C. Close item 3 in vault if `HELP_EXIT=0`

- Mark `work/2026-07-27-packaged-hana-cli-artifact-core` → `status: completed` + log entry  
- Optional: append root vault `log.md` one-liner  

If still failing: capture missing module path; prefer a **recursive require-graph pack helper** over another one-off file + `.7` tag.

### D. Then item 2

```text
Office-hours / prep:
  projects/openhanako/work/2026-07-27-mobile-https-wss-pwa-coverage/spec.md
Questions: cert source, :443 vs reverse proxy, secure cookies / WSS.
```

---

## Do not

- Merge permanent draft PR #1  
- Full Mobile UAT re-run unless HTTPS changes auth  
- Deploy from local checkout; use `install-server` + published tag only  

---

## Paste into new session

```text
Read handoff/2026-07-27-karlorz4-cli-fix-and-followups.md.
CI for v0.416.51-karlorz.6 (run 30216319230) may still need finish; then upgrade
sg01 .5→.6, prove hana --help exits 0, close work item
packaged-hana-cli-artifact-core, then start office-hours on
mobile-https-wss-pwa-coverage.
```
