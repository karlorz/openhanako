#!/usr/bin/env bash
# sync-upstream.sh — sync this fork (karlorz/openhanako, dev branch) with upstream
# (liliMozi/openhanako, main). Release-tag sync only; see FORK_SYNC.md for policy.
#
# Usage:
#   scripts/sync-upstream.sh --check                  # detect new stable upstream tags, no changes
#   scripts/sync-upstream.sh --include-prerelease --check
#   scripts/sync-upstream.sh                          # full sync to latest stable tag
#   scripts/sync-upstream.sh --include-prerelease     # full sync to latest tag including prereleases
#   scripts/sync-upstream.sh --help                   # this help
#
# Human gates (script STOPS and drops to shell):
#   1. Rebase conflict on any diverging file (per-file policy printed)
#   2. Tier 1 test failure (does not deploy)
#   3. Tier 2 bundle grep failure (does not deploy)
#   4. Tier 3 live smoke (manual checklist; script prompts, does not auto-verify)
#
# The script also runs the local upstream issue tracker in search-only mode.
# It never submits GitHub issues.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

UPSTREAM_REMOTE="upstream"
UPSTREAM_REPO="liliMozi/openhanako"
FORK_BRANCH="dev"
SYNC_DOC="FORK_SYNC.md"
ISSUE_TRACKER="scripts/track-upstream-issues.mjs"
INCLUDE_PRERELEASE=0
DIVERGING_FILES=(
  "core/server-auth.ts"
  "desktop/src/react/services/server-connection.ts"
  "desktop/main.cjs"
  "desktop/preload.cjs"
  "tests/server-auth.test.ts"
  "desktop/src/react/__tests__/services/server-connection.test.ts"
  "desktop/src/modules/connection-csp.js"
  "desktop/src/react/services/resource-url.ts"
  "desktop/src/react/utils/user-attachment-media.ts"
  "desktop/src/react/MainContent.tsx"
  "desktop/src/react/components/InputArea.tsx"
  "desktop/src/react/stores/chat-slice.ts"
  "desktop/src/react/stores/selectors/file-refs.ts"
  "desktop/src/react/utils/uploaded-session-file.ts"
  "server/routes/upload.ts"
  "tests/csp-sync.test.ts"
  "tests/upload-route.test.ts"
  "desktop/src/react/__tests__/components/MainContent.drag.test.tsx"
  "desktop/src/react/__tests__/components/InputArea.paste-and-slash.test.tsx"
  "desktop/src/react/__tests__/components/InputArea.media-send.test.tsx"
  "desktop/src/react/__tests__/services/resource-url.test.ts"
  "desktop/src/react/__tests__/stores/chat-slice.test.ts"
  "desktop/src/react/__tests__/stores/selectors/file-refs.test.ts"
  "desktop/src/react/__tests__/utils/user-attachment-media.test.ts"
)
TEST_FILES=(
  "tests/server-auth.test.ts"
  "tests/csp-sync.test.ts"
  "desktop/src/react/__tests__/services/server-connection.test.ts"
  "desktop/src/react/__tests__/components/MainContent.drag.test.tsx"
  "desktop/src/react/__tests__/components/InputArea.paste-and-slash.test.tsx"
  "desktop/src/react/__tests__/components/InputArea.media-send.test.tsx"
  "desktop/src/react/__tests__/services/ws-message-handler.test.ts"
  "desktop/src/react/__tests__/services/resource-url.test.ts"
  "desktop/src/react/__tests__/stores/chat-slice.test.ts"
  "desktop/src/react/__tests__/stores/selectors/file-refs.test.ts"
  "desktop/src/react/__tests__/components/shared/MediaViewer/media-source.test.ts"
  "desktop/src/react/__tests__/utils/open-media-viewer.test.ts"
  "desktop/src/react/__tests__/utils/user-attachment-media.test.ts"
  "desktop/src/react/__tests__/components/RightWorkspacePanel.test.tsx"
  "tests/upload-route.test.ts"
)

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
red()    { color "31" "$1"; }
green()  { color "32" "$1"; }
yellow() { color "33" "$1"; }
blue()   { color "34" "$1"; }
bold()   { color "1"  "$1"; }

die()  { red "✗ $*"; echo; exit 1; }
ok()   { green "✓ $*"; echo; }
info() { blue "→ $*"; echo; }
warn() { yellow "! $*"; echo; }

# --- preflight --------------------------------------------------------------

preflight() {
  command -v git >/dev/null || die "git not found"
  command -v node >/dev/null || die "node not found (need for issue tracker)"
  command -v npx >/dev/null || die "npx not found (need for vitest)"
  git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 || die "remote '$UPSTREAM_REMOTE' not configured. Run: git remote add upstream https://github.com/liliMozi/openhanako.git"
  [ -f "$SYNC_DOC" ] || die "$SYNC_DOC not found at repo root"
  [ -f "$ISSUE_TRACKER" ] || die "$ISSUE_TRACKER not found at repo root"
  info "preflight ok (repo: $REPO_ROOT)"
}

issue_tracking_report() {
  echo
  bold "Upstream issue tracking"; echo
  if ! command -v gh >/dev/null; then
    warn "gh not found — skip live issue search. Run '$ISSUE_TRACKER search' after GitHub CLI is available."
    return 0
  fi
  if node "$ISSUE_TRACKER" search; then
    ok "issue search complete"
  else
    warn "issue search failed — continue only after manually reviewing docs/upstream-issues/README.md and $SYNC_DOC"
  fi
}

# --- latest tag -------------------------------------------------------------

latest_upstream_tag() {
  if command -v gh >/dev/null; then
    local jq_filter
    if [ "$INCLUDE_PRERELEASE" -eq 1 ]; then
      jq_filter='.[] | select(.isDraft == false) | .tagName'
    else
      jq_filter='.[] | select(.isDraft == false and .isPrerelease == false) | .tagName'
    fi
    local release_tag
    release_tag=$(gh release list \
      --repo "$UPSTREAM_REPO" \
      --json tagName,isPrerelease,isDraft,publishedAt \
      --limit 50 \
      --jq "$jq_filter" 2>/dev/null | head -1)
    if [ -n "$release_tag" ]; then
      echo "$release_tag"
      return 0
    fi
    warn "GitHub release lookup found no matching releases; falling back to local git tags."
  else
    warn "gh not found — cannot filter draft/prerelease releases; falling back to local git tags."
  fi
  git tag --sort=-creatordate --list 'v*' --merged "$UPSTREAM_REMOTE/main" 2>/dev/null | head -1
}

last_synced_tag() {
  # parse from FORK_SYNC.md sync log: extract the most recent v* tag, including baseline rows
  awk -F'|' '
    /^\| [0-9]{4}-[0-9]{2}-[0-9]{2} / && $3 ~ /v[0-9]/ {
      if (match($3, /v[0-9]+(\.[0-9]+)+([-.][A-Za-z0-9]+)*/)) {
        print substr($3, RSTART, RLENGTH)
      }
    }
  ' "$SYNC_DOC" | tail -1
}

# --- --check mode -----------------------------------------------------------

do_check() {
  info "fetching upstream tags..."
  git fetch "$UPSTREAM_REMOTE" --tags --quiet || die "fetch failed"
  issue_tracking_report
  local latest tagged_last
  latest=$(latest_upstream_tag)
  [ -n "$latest" ] || die "no upstream tags found"
  tagged_last=$(last_synced_tag)

  echo
  bold "Upstream sync status"; echo
  if [ "$INCLUDE_PRERELEASE" -eq 1 ]; then
    echo "  Release channel:       stable + prerelease"
  else
    echo "  Release channel:       stable only"
  fi
  echo "  Latest upstream tag:   $latest"
  echo "  Last synced tag:       ${tagged_last:-<none — baseline>}"
  echo

  if [ "$latest" = "$tagged_last" ]; then
    green "✓ Already up to date — no new release to sync."; echo
    return 0
  fi

  warn "New upstream tag available: $latest"
  echo

  # Preflight report: which diverging files upstream touched since fork point
  local fork_point
  fork_point=$(git merge-base "$UPSTREAM_REMOTE/main" HEAD)
  if [ -n "$fork_point" ]; then
    bold "Files upstream changed since fork point (intersection with our diverging files):"; echo
    local touched=0
    for f in "${DIVERGING_FILES[@]}"; do
      if git diff --name-only "$fork_point..$UPSTREAM_REMOTE/main" -- "$f" 2>/dev/null | grep -q .; then
        red "  ✗ $f  — CONFLICT LIKELY, see $SYNC_DOC policy"; echo
        touched=$((touched+1))
      fi
    done
    if [ "$touched" -eq 0 ]; then
      green "  ✓ None of the diverging files touched upstream — rebase should be clean."; echo
    fi
  fi

  echo
  bold "Next step:"; echo "  Run $(bold "scripts/sync-upstream.sh") (no --check) to sync."
  echo  "  Use $(bold "scripts/sync-upstream.sh --include-prerelease --check") only for prerelease candidate review."
  echo  "  Check issue #1749 status: https://github.com/liliMozi/openhanako/issues/1749"
  return 1
}

# --- full sync --------------------------------------------------------------

do_sync() {
  preflight

  info "verifying working tree clean..."
  git diff --quiet || die "working tree dirty — commit or stash first"
  git diff --cached --quiet || die "index has staged changes — commit or stash first"

  info "current branch: $(git branch --show-current)"
  [ "$(git branch --show-current)" = "$FORK_BRANCH" ] || die "not on '$FORK_BRANCH' — checkout $FORK_BRANCH first"

  info "fetching upstream tags + main..."
  git fetch "$UPSTREAM_REMOTE" --tags --quiet || die "fetch failed"
  issue_tracking_report

  local latest
  latest=$(latest_upstream_tag)
  [ -n "$latest" ] || die "no upstream tags found"
  if [ "$INCLUDE_PRERELEASE" -eq 1 ]; then
    info "latest upstream tag: $latest (stable + prerelease mode)"
  else
    info "latest upstream tag: $latest (stable-only mode)"
  fi

  # Pre-rebase report
  echo
  bold "Per-file conflict policy (from $SYNC_DOC):"; echo
  cat "$SYNC_DOC" | awk '/^## Diverging files/,/^## The fixed commits/'
  echo

  # Rebase
  info "rebasing $FORK_BRANCH onto $latest..."
  echo
  if ! git rebase "$latest"; then
    red "✗ Rebase stopped — conflicts detected."; echo
    echo
    bold "Conflicting files:"; echo
    git diff --name-only --diff-filter=U | sed 's/^/  /'
    echo
    warn "Resolve each conflict per the policy above. For HUMAN-REVIEW files, inspect both sides carefully."
    echo
    bold "When done:"
    echo "  git add <resolved-files>"
    echo "  git rebase --continue"
    echo
    echo "Then re-run: scripts/sync-upstream.sh --post-rebase"
    exit 1
  fi
  ok "rebase clean"
  post_rebase_verify
}

# --- post-rebase verification (Tier 1 + Tier 2) -----------------------------

post_rebase_verify() {
  echo
  bold "Tier 1 — Unit tests"; echo
  local test_fail=0
  for t in "${TEST_FILES[@]}"; do
    info "running: $t"
    if npx vitest run "$t" >/tmp/sync-vitest.log 2>&1; then
      ok "$t passed"
    else
      red "✗ $t FAILED"; echo
      tail -20 /tmp/sync-vitest.log | sed 's/^/    /'
      test_fail=1
    fi
  done
  if [ "$test_fail" -ne 0 ]; then
    echo
    die "Tier 1 failed — do NOT deploy. Resolve test failures, then re-run with --post-rebase."
  fi

  echo
  bold "Tier 2 — Bundle content grep"; echo
  info "rebuilding bundles (main + preload)..."
  if ! npm run build:main >/tmp/sync-build-main.log 2>&1; then
    die "build:main failed — see /tmp/sync-build-main.log"
  fi
  if ! npm run build:preload >/tmp/sync-build-preload.log 2>&1; then
    die "build:preload failed — see /tmp/sync-build-preload.log"
  fi

  local bundle_fail=0
  if grep -q "connect:probe" desktop/main.bundle.cjs 2>/dev/null; then
    ok "connect:probe present in desktop/main.bundle.cjs"
  else
    red "✗ connect:probe MISSING from desktop/main.bundle.cjs"; echo
    bundle_fail=1
  fi
  if grep -q "probeConnection" desktop/preload.bundle.cjs 2>/dev/null; then
    ok "probeConnection present in desktop/preload.bundle.cjs"
  else
    red "✗ probeConnection MISSING from desktop/preload.bundle.cjs"; echo
    bundle_fail=1
  fi
  if grep -q "media-src" desktop/src/modules/connection-csp.js 2>/dev/null \
    && grep -q "httpSourcesOnly" desktop/src/modules/connection-csp.js 2>/dev/null; then
    ok "runtime connection CSP keeps scoped remote resource-origin logic"
  else
    red "✗ runtime connection CSP resource-origin logic missing"; echo
    bundle_fail=1
  fi
  if [ "$bundle_fail" -ne 0 ]; then
    echo
    die "Tier 2 failed — fix is absent from bundles. Do NOT deploy."
  fi

  echo
  bold "Tier 3 — Live smoke checklist (MANUAL)"; echo
  echo "  1. Clear localStorage in HanaAgent desktop (DevTools Console: localStorage.clear(); location.reload())"
  echo "  2. Settings → Access → Connect LAN Server → http://100.125.173.118:14500 + device key → Connect"
  echo "     Expect: connects with NO console hack, no CSP error"
  echo "  3. DevTools Console: no 'Refused to connect ... CSP' errors; no [WS_DISCONNECTED]; WS establishes"
  echo "  4. Paste/upload an image, send it, switch chats, return, and confirm chat thumbnail + Conversation Files preview still render"
  echo
  warn "Do NOT mark sync complete in $SYNC_DOC until all 4 steps pass."
  echo
  bold "After manual verification:"; echo
  echo "  - Rebuild server: npm run build:server; deploy to sg01 (see FORK_SYNC.md)"
  echo "  - Rebuild desktop package: npm run build:renderer; npx electron-builder --mac dmg; ad-hoc sign"
  echo "  - Replace /Applications/HanaAgent.app"
  echo "  - Append a row to the sync log in $SYNC_DOC"
  echo
  ok "sync-upstream.sh complete — awaiting manual Tier 3 + deploy"
}

# --- main -------------------------------------------------------------------

args=()
for arg in "$@"; do
  case "$arg" in
    --include-prerelease)
      INCLUDE_PRERELEASE=1
      ;;
    *)
      args+=("$arg")
      ;;
  esac
done

case "${args[0]:-}" in
  "")
    do_sync
    ;;
  --check)
    preflight
    do_check
    ;;
  --post-rebase)
    post_rebase_verify
    ;;
  --help|-h)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    die "unknown flag: ${args[0]} (try --help)"
    ;;
esac
