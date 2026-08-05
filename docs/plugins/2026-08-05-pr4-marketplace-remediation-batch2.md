# PR #4 Marketplace Remediation — Batch 2 Evidence

Date: 2026-08-05
Branch: `remediation/pr4-marketplace-findings`
Base: PR #4 head `6d424bff7aa2ed2d2420449c59f09e29523b085f`

This document records Batch 2 remediation evidence separately from the immutable read-only review baseline. The review baseline `docs/plugins/2026-08-05-pr4-marketplace-review.md` was not modified or staged.

## Findings applied

| Finding | Remediation | Commits |
|---|---|---|
| 7 — Skill preference persistence | Full-list skill PUT now persists ordinary skills in `skills.enabled` and keeps package-owned state canonical in `marketplace_overrides` | `ea5d84bd7` |
| 9 — Legacy install preconditions | Catalog rows carry source snapshots; legacy Claude install forwards registry/source facts; stale plans fail before mutation; direct real-service gate coverage added | `1368c7033`, `03bf05d56` |
| 11 — Malformed cache/artifact scanners | Stray marketplace, plugin, and digest directories are skipped with diagnostics while valid entries remain listable | `167d60045` |
| 12 — Skill uninstall provenance | Install records store per-skill directory digests; mismatched or unreadable live skills refuse deletion with partial-cleanup reporting; legacy records retain name-based compatibility | `cff5c8a42` |

## Verification outputs

### Focused Batch 2 suite

Command:

```bash
npx vitest run tests/plugin-marketplace-*.test.ts \
  tests/http-route-security.test.ts \
  tests/skill-manager.test.ts \
  tests/skills-route.test.ts \
  desktop/src/react/__tests__/settings/PluginMarketplaceTab.test.tsx \
  desktop/src/react/__tests__/settings/PluginsTab.test.tsx
```

Result: **22 test files passed, 379 tests passed**.

Expected diagnostic stderr was observed from the new malformed-entry tests (one warning per skipped cache/artifact entry) and from the existing PluginsTab inventory-fallback test. These are intentional diagnostics; the suite exited successfully.

### Typecheck

Command:

```bash
npm run typecheck
```

Result: **pass** — all three TypeScript projects completed successfully.

### Lint

Command:

```bash
npm run lint
```

Result: **pass** — 0 errors and 7,820 existing/project warnings. No lint warnings were promoted to errors.

### Whitespace checks

Commands:

```bash
git diff --check
git diff --check 6d424bff7aa2ed2d2420449c59f09e29523b085f..HEAD
```

Result: **both pass**. The working tree and the full remediation branch are whitespace-clean relative to the PR head.

## Scope and safety statement

- No GitHub, pull request, remote branch, `dev`, `main`, or `sg01` state was changed.
- No deployment or external service mutation was performed.
- Native marketplace packages remain PluginManager-owned; Claude marketplace packages remain Hana skills through SkillManager.
- `GET /api/plugins` and the marketplace skill-package inventory contract remain unchanged.
- The read-only review baseline remains separate and unmodified.
