# Dev Loop - OpenHanako

Compact config for dev-loop v1.26.3. The operating guide remains in
`CLAUDE.md`, `CONTEXT.md`, `FORK_SYNC.md`, and
`docs/agents/openhanako-dev-loop-setup.md`.

```yaml
# Identity
slug: openhanako
release_branch: dev

# Branch and PR safety. Dev-loop works from `dev`; `main` is only the
# upstream-mirror dashboard base. PR #1 is permanent review infrastructure,
# not a merge vehicle.
merge_safety:
  working_branch: dev
  protected_dashboard_pr: 1
  protected_dashboard_base: main
  protected_dashboard_head: dev
  dashboard_pr_policy: never_merge
  dashboard_pr_refresh_command: "node scripts/sync-upstream.mjs --conflict-plan"
  origin_main_policy: "origin/main may be replaced from upstream/main during dashboard refresh only."
  forbidden_actions:
    - "Do not merge PR #1."
    - "Do not enable auto-merge for PR #1."
    - "Do not close PR #1 as a completed merge vehicle."
    - "Do not treat origin/main as the dev-loop release branch."
    - "Do not merge, rebase, or reset dev from main during dashboard refresh."

# PRD: use Superpowers for brainstorm -> spec -> plan -> execute -> review.
prd_layer: superpowers
prd_pipeline: full
prd_backends:
  superpowers:
    capabilities: [brainstorm, spec, plan, execute, review, subagent_dispatch]
    skills:
      brainstorm: superpowers:brainstorming
      plan: superpowers:writing-plans
      execute: superpowers:subagent-driven-development
      execute_fallback: superpowers:executing-plans
      review: simplify

# Knowledge: persist work items, retros, and queries in SkillWiki.
knowledge_layer: skillwiki
project_wiki: projects/openhanako
vault_auto_commit: true
knowledge_backends:
  skillwiki:
    vault: auto
    cli_entry: skillwiki
    capabilities: [query_vault, create_work_item, save_retro, crystallize, distill, lint_vault, audit_vault, drift_check]
vault_sync:
  # Installed SkillWiki uses `skillwiki sync lock/unlock`; dev-loop v1.24.5
  # still probes an older `--acquire-lock` flag.
  peer_aware: false
  lock_timeout_seconds: 30
  retry_budget: 3
  presync_skill: auto-detect

# Release and CI. Keep deploy_script unset; host install/upgrade stays
# manual/attended through install-server on the Linux host.
publish_via: ci-tag-trigger
release_workflow: .github/workflows/build.yml
ci_configured: true
ci_discovery: explicit
required_checks:
  - "test (macos-latest, 24.15.0)"
  - "test (windows-latest, 24.15.0)"
deploy_script: ""
remote_hosts: [sg01]
release_policy:
  auto_bump: false
  upstream_tag_format: "v{version}"
  tag_format: "v{version}-karlorz.N"
  tag_namespace_rule: "Plain v{version} tags belong to upstream sync targets; fork release tags must use the -karlorz.N suffix."
  latest_verified_fork_tag: v0.346.18-karlorz.5
  fork_release_channel: prerelease
  verify_after_push: true

# sg01 deployment is attended. Dev-loop may surface this target in DEPLOY, but
# it must not invent an SSH deployment script or mutate the host without an
# operator running the install-server dry-run and execute steps deliberately.
server_deploy:
  mode: attended
  authority: install-server-on-host
  target: sg01
  service: hanaagent
  url: http://100.125.173.118:14500
  release_asset_arch: linux-arm64
  current_verified_target: v0.346.18-karlorz.5
  install_server:
    bootstrap_cli_only_command: "curl -fsSL https://raw.githubusercontent.com/karlorz/openhanako/<ref>/scripts/install-server-bootstrap.sh | sudo bash -s -- --repo karlorz/openhanako --ref <ref> --install-cli-only"
    status_command: "install-server status"
    fresh_install_dry_run_command: "install-server install --version <tag> --channel prerelease --dry-run"
    fresh_install_execute_command: "install-server install --version <tag> --channel prerelease --execute"
    bootstrap_fresh_install_command: "curl -fsSL https://raw.githubusercontent.com/karlorz/openhanako/<tag>/scripts/install-server-bootstrap.sh | sudo bash -s -- --repo karlorz/openhanako --version <tag> --channel prerelease --execute"
    upgrade_dry_run_command: "install-server upgrade --version <tag> --channel prerelease --dry-run"
    upgrade_execute_command: "install-server upgrade --version <tag> --channel prerelease --execute"
    bootstrap_upgrade_execute_command: "curl -fsSL https://raw.githubusercontent.com/karlorz/openhanako/<tag>/scripts/install-server-bootstrap.sh | sudo bash -s -- --repo karlorz/openhanako --version <tag> --channel prerelease --upgrade --execute"
    local_planner_fallback: "node scripts/install-server.mjs upgrade --version <tag> --channel prerelease --current-version <current-release> --platform linux --arch arm64 --dry-run"
    local_planner_scope: "Validates release asset selection and generic upgrade shape only; host-side dry-run is authoritative because it reads sg01's live systemd unit and preserved HANA_* settings."
  release_checks:
    view_release: "gh release view <tag> --repo karlorz/openhanako --json assets,isPrerelease,isDraft"
    required_server_assets:
      - "hanaagent-server-<tag>-linux-arm64.tar.gz"
      - "hanaagent-server-<tag>-linux-arm64.tar.gz.sha256"
  post_upgrade_checks:
    - "readlink -f /opt/hanaagent/current"
    - "systemctl status hanaagent --no-pager -l"
    - "curl -fsS http://100.125.173.118:14500/mobile/ >/tmp/hana-mobile.html"
    - "curl -fsS http://100.125.173.118:14500/mobile/locales/zh.json >/tmp/hana-mobile-zh.json"
    - "Verify /mobile/ login text is translated, not raw mobile.auth.* keys."
  policy:
    - "Run release asset check before touching sg01."
    - "Run upgrade dry-run before execute."
    - "Use --channel prerelease for fork tags such as v0.346.18-karlorz.5."
    - "Do not use or recreate the retired sg01 SSH deploy helper."
    - "Do not set deploy_script unless an attended release explicitly approves automatic host deployment."
    - "If install-server is missing on sg01, run the CLI-only bootstrap command as a separate attended host mutation before upgrade."
    - "Only use the raw-GitHub bootstrap curl command with a ref or tag that contains scripts/install-server-bootstrap.sh."

# Interviews happen before spec/plan unless the loop is running unattended
# under /goal, where preflight readiness gates are required instead.
interview:
  setup:
    skill: setup-dev-loop
    glossary: grill-with-docs
  work_item:
    upgrade: grill-me
    trigger: auto
    goal_override: never

# Critical paths bias search/research priority. TDD scoping below is the hard
# execution gate; this list is intentionally compact.
critical_paths:
  lan_connect_auth:
    code:
      - core/server-auth.ts
      - desktop/main.cjs
      - desktop/preload.cjs
      - desktop/src/react/services/server-connection.ts
    vault:
      - projects/openhanako/fork-sync-policy
      - concepts/openhanako-desktop-access-methods
  remote_attachment_preview:
    code:
      - desktop/src/modules/connection-csp.js
      - desktop/src/react/services/resource-url.ts
      - desktop/src/react/utils/user-attachment-media.ts
      - server/routes/upload.ts
    vault:
      - concepts/openhanako-remote-session-file-preview
  remote_plugin_credentials:
    code:
      - desktop/src/react/hooks/use-plugin-surface-url.ts
      - desktop/src/react/__tests__/hooks/use-plugin-surface-url.test.tsx
    vault:
      - projects/openhanako/fork-sync-policy
  mobile_pwa_runtime:
    code:
      - desktop/src/mobile.html
      - desktop/src/mobile-main.tsx
      - desktop/src/mobile-sw.js
      - desktop/src/react/mobile/MobileApp.tsx
      - desktop/src/react/mobile/mobile-init.ts
      - desktop/src/react/mobile/mobile-platform.ts
      - desktop/src/react/mobile/mobile-entry.css
      - desktop/src/react/__tests__/mobile/MobileApp.test.tsx
      - desktop/src/react/__tests__/mobile/MobileEntrySplit.test.ts
      - desktop/src/react/__tests__/mobile/mobile-platform.test.ts
      - server/routes/mobile-static.ts
      - tests/mobile-static-route.test.ts
      - scripts/build-server.mjs
      - scripts/build-server-runtime-assets.mjs
      - scripts/pack-server-bundle.mjs
      - tests/build-server-runtime-assets.test.ts
      - tests/pack-server-bundle.test.mjs
      - .github/workflows/build.yml
    vault:
      - projects/openhanako/requirements/2026-06-28-office-hours-remote-mobile-pwa-missing-lang-file
    history_pins:
      - "2026-06-28: sg01 /mobile/ rendered raw mobile.auth.* keys because the host was on v0.323.0-karlorz.3 while the auth-locale fix exists in the v0.346.18 fork line."
  fork_sync_maintenance:
    code:
      - FORK_SYNC.md
      - docs/fork-sync/rules.yml
      - scripts/sync-upstream.mjs
      - scripts/hana-desktop-smoke-helper.mjs
      - scripts/track-upstream-issues.mjs
      - package.json
      - package-lock.json
      - desktop/src/react/__tests__/services/ws-message-handler.test.ts
      - docs/upstream-issues/**
      - tests/sync-upstream.test.mjs
      - tests/hana-desktop-smoke-helper.test.mjs
      - tests/upstream-issue-tracker.test.mjs
    vault:
      - projects/openhanako/fork-sync-policy
  install_server_maintenance:
    code:
      - scripts/install-server.mjs
      - scripts/install-server-bootstrap.sh
      - tests/install-server-upgrade.test.mjs
      - docs/server-install.md
      - docs/reinit-data-failsafe.md
      - .claude/dev-loop.config.md
    vault:
      - projects/openhanako/work/2026-06-16-design-unified-linux-install-server
      - projects/openhanako/work/2026-06-16-implement-install-server-upgrade
      - projects/openhanako/work/2026-06-16-replace-sg01-deploy-helper

# TDD with Superpowers:
# - mandatory on deterministic credential/CSP/upload paths
# - advisory everywhere else
# - systematic debugging when execution fails
prd_disciplines:
  - skill: superpowers:test-driven-development
    when: execute
    mode: mandatory
    include_paths:
      - core/server-auth.ts
      - desktop/src/modules/connection-csp.js
      - desktop/src/react/hooks/use-plugin-surface-url.ts
      - desktop/src/react/services/server-connection.ts
      - desktop/src/react/services/resource-url.ts
      - desktop/src/react/utils/user-attachment-media.ts
      - desktop/src/react/mobile/MobileApp.tsx
      - desktop/src/react/mobile/mobile-init.ts
      - desktop/src/react/mobile/mobile-platform.ts
      - desktop/src/react/__tests__/mobile/MobileApp.test.tsx
      - scripts/install-server.mjs
      - scripts/build-server-runtime-assets.mjs
      - scripts/pack-server-bundle.mjs
      - server/routes/upload.ts
  - skill: superpowers:test-driven-development
    when: execute
    mode: advisory
  - skill: superpowers:systematic-debugging
    when: failure
    mode: reactive

# Lightweight support gates.
fact_check:
  enabled: true
  source_order: [local_repo, vault_query, web_search]
  evidence_contract:
    require_sources_used_section: true
  triggers: ["Electron API", "Content-Security-Policy", "GitHub Actions", "version ", "deprecat", "CVE-"]

browser_verification:
  enabled: true
  trigger:
    - desktop/src/react/**/*.tsx
    - desktop/src/react/**/*.ts
    - desktop/src/mobile.html
    - desktop/src/mobile-main.tsx
    - desktop/src/mobile-sw.js
    - desktop/src/modules/**/*.js
    - server/routes/mobile-static.ts
    - scripts/build-server.mjs
    - scripts/build-server-runtime-assets.mjs
  prerequisites:
    - "curl -fsS \"${HANA_BROWSER_VERIFY_URL:-http://localhost:5173}\" >/dev/null"
  driver: playwright-cli
  base_url: "${HANA_BROWSER_VERIFY_URL:-http://localhost:5173}"
  smoke_routes: [/, /mobile/]
  reviser_workflow: [take_snapshot, list_console_messages, evaluate_script]
  e2e_fallback: "npx vitest run desktop/src/react/__tests__/mobile/MobileApp.test.tsx desktop/src/react/__tests__/mobile/MobileEntrySplit.test.ts tests/mobile-static-route.test.ts tests/build-server-runtime-assets.test.ts desktop/src/react/__tests__/components/RightWorkspacePanel.test.tsx"

reactive_debugging:
  enabled: true
  auto_retry_attempts: 2
  evidence_dir: .claude/dev-loop-debug/
  evidence_capture:
    - "npm run typecheck 2>&1 | tee {evidence_dir}/{cycle}-typecheck.log"
    - "git diff > {evidence_dir}/{cycle}-diff.patch"
    - "git status --short > {evidence_dir}/{cycle}-status.txt"
  escalate_after:
    consecutive_idle_cycles: 3
    same_error_signature: true

code_review:
  parallel: true
  base: dev-loop:simplify-worker
  codex:
    enabled_in_normal: false
    enabled_in_high: false
    agent: dev-loop:codex-review-worker

preflight:
  enabled: true
  default_limit: 5
  default_lanes: [work, captures, hygiene]
  require_approved_spec_and_plan: true
  unattended_not_ready_behavior: skip
  defaults:
    remote_deploy_policy: "sg01 deployment is attended and install-server based; dry-run before execute."
    fork_release_channel: "Fork tags publish as GitHub prereleases; use --channel prerelease for sg01."
    mobile_pwa_acceptance: "No raw mobile.auth.* keys on /mobile/ login; locale JSON and mobile runtime assets return 200."

notes:
  github_repo: karlorz/openhanako
  upstream_repo: liliMozi/openhanako
  permanent_dashboard_pr: "https://github.com/karlorz/openhanako/pull/1"
  permanent_dashboard_pr_policy: "Draft forever, never merge. Use it to review dev vs mirrored upstream main conflicts."
  fork_sync_post_rebase_gate: "Run `node scripts/sync-upstream.mjs --post-rebase`; Tier 3A local desktop install/version verification must pass before Tier 3B sg01 live smoke. A smoke run against a stale /Applications/HanaAgent.app is invalid."
  remote_server_url: http://100.125.173.118:14500
  sg01_service: hanaagent
  sg01_pre_upgrade_release_observed: "2026-06-28 before attended temp-script upgrade: /opt/hanaagent/current -> /opt/hanaagent/releases/v0.323.0-karlorz.3-linux-arm64; install-server not found in PATH."
  sg01_post_upgrade_release_observed: "2026-06-28 after attended temp-script upgrade: /opt/hanaagent/current -> /opt/hanaagent/releases/v0.346.18-karlorz.1-linux-arm64; service active; install-server was still not installed in PATH at upgrade time because the bootstrap script had not yet been added to a released ref."
  sg01_replay_patch_release_target: "2026-06-30 patch target: v0.346.18-karlorz.5 includes marker-only image replay, ToolGroup file-detail link context, and code-review hardening follow-ups; deploy with install-server upgrade --channel prerelease."
  sg01_mobile_pwa_diagnosis: "Raw mobile.auth.* text was deployment drift from the old v0.323 server bundle. After upgrading to v0.346.18-karlorz.1, the live MobileApp chunk preloads the auth locale before login and zh.json returns translated mobile.auth labels."
  gh_default_repo_hint: "Run `gh repo set-default karlorz/openhanako` if gh resolves to upstream."
```
