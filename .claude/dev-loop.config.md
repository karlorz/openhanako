# Dev Loop - OpenHanako

Compact config for dev-loop v1.24.7. The operating guide remains in
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
# manual/attended through install-server.
publish_via: ci-tag-trigger
release_workflow: .github/workflows/build.yml
ci_configured: true
ci_discovery: explicit
required_checks:
  - "test (macos-latest, 24.15.0)"
  - "test (windows-latest, 24.15.0)"
remote_hosts: []
release_policy:
  auto_bump: false
  tag_format: "v{version}"
  verify_after_push: true

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
      - scripts/install-server.mjs
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
    - desktop/src/modules/**/*.js
  prerequisites:
    - "curl -fsS \"${HANA_BROWSER_VERIFY_URL:-http://localhost:5173}\" >/dev/null"
  driver: playwright-cli
  base_url: "${HANA_BROWSER_VERIFY_URL:-http://localhost:5173}"
  smoke_routes: [/]
  reviser_workflow: [take_snapshot, list_console_messages, evaluate_script]
  e2e_fallback: "npx vitest run desktop/src/react/__tests__/components/RightWorkspacePanel.test.tsx"

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

notes:
  github_repo: karlorz/openhanako
  upstream_repo: liliMozi/openhanako
  permanent_dashboard_pr: "https://github.com/karlorz/openhanako/pull/1"
  permanent_dashboard_pr_policy: "Draft forever, never merge. Use it to review dev vs mirrored upstream main conflicts."
  fork_sync_post_rebase_gate: "Run `node scripts/sync-upstream.mjs --post-rebase`; Tier 3A local desktop install/version verification must pass before Tier 3B sg01 live smoke. A smoke run against a stale /Applications/HanaAgent.app is invalid."
  remote_server_url: http://100.125.173.118:14500
  gh_default_repo_hint: "Run `gh repo set-default karlorz/openhanako` if gh resolves to upstream."
```
