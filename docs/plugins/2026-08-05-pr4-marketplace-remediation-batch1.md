# PR #4 Marketplace Remediation — Batch 1 Evidence

Date: 2026-08-05
Branch: `remediation/pr4-marketplace-findings`
Base: PR #4 head `6d424bff7aa2ed2d2420449c59f09e29523b085f`

This document records Batch 1 remediation evidence separately from the immutable read-only review baseline. The review baseline `docs/plugins/2026-08-05-pr4-marketplace-review.md` was not modified or staged.

## Findings applied

| Finding | Remediation | Commits |
|---|---|---|
| 1 — Agent owner bypass | Host-derived owner principal, approval-gateway owner enforcement, tool de-attestation, and Operate-mode review routing | `e414e33c8..0ef46d164`, `36f51d945`, `a28b0408b` |
| 2 — Canonical IP/SSRF classification | Canonical IPv4/IPv6, mapped, NAT64, private, reserved, and metadata-address rejection | `bd7f1690f` |
| 3 — DNS rebinding / validation-only pinning | Validated DNS answers are bound to the actual undici connection per redirect hop; README route regression coverage added | `b1b14e612`, `997871756` |
| 4 — Source-switch authorization and lifecycle | Studio-owner route classification, signed plan/execute lifecycle, runtime hooks, health checks, rollback, and desktop preconditions | `cd798081e`, `26db23af9`, `dc81e5e38..a59f8428b`, `148197943` |
| 5 — Source-switch trust/marker loss | Active projection writes source-qualified `.hana-marketplace.json`, removes retained-artifact metadata, and restores the marker on rollback | `33348589a` |
| 6 — Uncalled recovery / boot journal safety | Boot-time recovery before community plugin scan, fail-closed journal retention, cross-plugin isolation, and committed-journal finalization | `64862b049..cd0bca17b` |
| 13 — PR-head whitespace defects | Removed only the identified trailing whitespace and final blank line | `00a20c0ba` |

The verification prerequisite for isolated server smoke runs was also completed in `a2e0639be`: the dev launcher preserves an explicitly supplied `HANA_HOME`.

## Verification outputs

### Focused Batch 1 suite

Command:

```bash
npx vitest run tests/plugin-marketplace-*.test.ts \
  tests/http-route-security.test.ts \
  tests/skill-manager.test.ts \
  tests/skills-route.test.ts \
  desktop/src/react/__tests__/settings/PluginMarketplaceTab.test.tsx \
  desktop/src/react/__tests__/settings/PluginsTab.test.tsx
```

Result: **22 test files passed, 366 tests passed**.

The suite emitted one expected stderr log from the existing `PluginsTab` fallback test (`skill package inventory load failed: inventory unsupported`); it did not fail the test or introduce a new warning path.

### Typecheck

Command:

```bash
npm run typecheck
```

Result: **pass** — all three TypeScript projects completed successfully.

### Server build

The first direct `npm run build:server` attempt stopped at the documented prerequisite because `desktop/dist-renderer` had not been generated. No source or tracked files were changed. The repository build order is `build:client` → `build:renderer` → `build:server`.

After running:

```bash
npm run build:renderer
npm run build:server
```

Result: **pass** — renderer assets generated, Vite/server/CLI bundles built, runtime dependencies installed and pruned, runtime smoke checks passed, Mach-O files ad-hoc signed, and server/renderer seed archives produced. Build output included existing Vite/dependency deprecation warnings but no errors.

### Lint

Command:

```bash
npm run lint
```

Result: **pass** — 0 errors and 7,812 pre-existing warnings. No lint warnings were promoted to errors.

### Whitespace checks

Commands:

```bash
git diff --check
git diff --check 6d424bff7aa2ed2d2420449c59f09e29523b085f..HEAD
```

Result: **both pass**. The remediation worktree is clean after the evidence commit preparation, and the full remediation branch is whitespace-clean relative to the PR head.

## Scope and safety statement

- No GitHub, pull request, remote branch, `dev`, `main`, or `sg01` state was changed.
- No deployment or external service mutation was performed.
- Native marketplace packages remain PluginManager-owned; Claude marketplace packages remain Hana skills through SkillManager.
- `GET /api/plugins` and the marketplace skill-package inventory contract remain unchanged.
- The read-only review baseline remains separate and unmodified.
