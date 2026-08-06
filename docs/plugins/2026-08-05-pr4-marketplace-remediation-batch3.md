# PR #4 Marketplace Remediation — Batch 3 Evidence

Date: 2026-08-05
Branch: `remediation/pr4-marketplace-findings`
Base: PR #4 head `6d424bff7aa2ed2d2420449c59f09e29523b085f`

This document records Batch 3 remediation evidence separately from the immutable read-only review baseline. The review baseline `docs/plugins/2026-08-05-pr4-marketplace-review.md` was not modified or staged.

## Findings applied

| Finding | Remediation | Commits |
|---|---|---|
| 8 — Marketplace localization | Localized the original Marketplace copy contract across five locales, added literal/key coverage tests, then localized the 23 remaining canary offenders and four named regex blind spots; existing Marketplace component tests now use the translated mock keys | `497037697`, `dd242c5bd`, `fa6c260d7` |
| 10 — UI decomposition | Split `PluginMarketplaceTab` into data/actions hooks and inspector; split `PluginsTab` into config editor and Manage Plugins skill-package panel; preserved optimistic action state, busy semantics, and config-editor identity isolation with regression tests | `5e409901b..2a5d8b7d7`, `8212c6aa3..e7644d3f3` |
| 10 — Server decomposition | Extracted Marketplace route registration/handlers with route-order parity and real-server composition coverage; registered the new route module in the export manifest | `39e2f1689`, `6a2520ae3` |
| 10 — Service decomposition | Extracted `MarketplaceCatalogProjection` for catalog, resolution, inventory, and activation reads while keeping service mutations/control-plane methods; registered the projection in the export manifest | `5c590f8a6`, `6a2520ae3` |
| 10 — Tool decomposition | Split Marketplace tool helpers and action handlers, preserving all 19 action keys, owner propagation, validation, result/error shapes, and the unchanged tool test; registered both new tool modules in the export manifest | `e8df79e28`, `d358165e7` |

## Verification outputs

### Focused Batch 3 suite

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

Expected diagnostics were observed from the existing PluginsTab inventory-fallback test and the malformed marketplace snapshot/artifact tests. These are intentional diagnostics; no test failed.

### Broader Batch 3 suite

Command:

```bash
npx vitest run tests/plugin-marketplace-*.test.ts \
  tests/approval-gateway.test.ts \
  tests/http-route-security.test.ts \
  tests/plugin-routes.test.ts \
  tests/plugin-manager.test.ts \
  tests/skill-manager.test.ts \
  tests/skills-route.test.ts \
  tests/plugin-source-switch.test.ts \
  tests/plugin-trust-store.test.ts \
  tests/marketplace-skill-preferences.test.ts \
  tests/engine-marketplace-skill-preferences.test.ts \
  tests/hana-agent-marketplace-smoke.test.mjs \
  desktop/src/react/__tests__/settings/AddMarketplaceSourceDialog.test.tsx \
  desktop/src/react/__tests__/settings/MarketplaceSourcesPanel.test.tsx \
  desktop/src/react/__tests__/settings/PluginMarketplaceTab.test.tsx \
  desktop/src/react/__tests__/settings/PluginsTab.test.tsx \
  desktop/src/react/settings/tabs/__tests__/SkillsTab.test.tsx \
  desktop/src/react/settings/tabs/skills/__tests__/marketplace-package.test.ts
```

Result: **34 test files passed, 621 tests passed**.

### Typecheck, builds, and lint

Commands:

```bash
npm run typecheck
npm run build:client
npm run build:server
npm run lint
```

Results:

- **Typecheck passed** across all three TypeScript projects.
- **Client build passed**, including main, preload, renderer, splash, and theme bundles.
- **Server build passed** after the required client build sequence.
- **Lint passed** with exit 0, **0 errors**, and 7,832 warnings. The warnings are existing/project lint debt; none were promoted to errors.
- Build output included existing Vite/dependency warnings but no build errors.

### Export boundary and whitespace checks

Commands:

```bash
node scripts/lint-open-boundary.mjs
git diff --check 6d424bff7aa2ed2d2420449c59f09e29523b085f..HEAD
```

Results:

- **Boundary lint passed**: one already-known open→closed edge remains in the ratchet baseline; no new edge remains from the Batch 3 modules.
- **Full remediation diff check passed** relative to the PR #4 head.

### File-size table

| Original container | Lines | Gate |
|---|---:|---|
| `desktop/src/react/settings/tabs/PluginMarketplaceTab.tsx` | 416 | `<1000` |
| `desktop/src/react/settings/tabs/PluginsTab.tsx` | 764 | `<1000` |
| `lib/tools/plugin-marketplace-tool.ts` | 103 | `<500` |
| `server/routes/plugins.ts` | 1122 | `<1600` |
| `lib/plugin-marketplace-service.ts` | 1021 | `<1100` |

Extracted modules remain focused: `useMarketplaceData.ts` 377, `useMarketplaceActions.ts` 412, `MarketplacePluginInspector.tsx` 315, `PluginConfigEditor.tsx` 230, `ManagePluginsSkillPackagesPanel.tsx` 166, `plugins-marketplace.ts` 1203, `plugin-marketplace-catalog.ts` 570, `plugin-marketplace-shared.ts` 459, and `plugin-marketplace-actions.ts` 410 lines.

## Review status

- Every Batch 3 implementation task received a task-scoped review.
- Critical/Important review findings were fixed and re-reviewed for B3-T3, B3-T4, and B3-T6.
- Remaining review notes are Minor and recorded in the SDD ledger: pre-existing Marketplace bridge/skills-uninstall copy outside the approved localization scope, cosmetic logger/manifest-order notes, and soft line-target/unused-interface notes.
- Existing Marketplace test files remained unchanged where the task contracts required them to remain frozen.

## Final merge-ready gates

The post-remediation final gates were completed on 2026-08-05 without changing
GitHub, the PR, `dev`, `main`, remote branches, or `sg01`:

### Isolated real-entry Marketplace lifecycle smokes

Both disposable real-entry homes completed the full lifecycle in both
permission modes:

```text
list_sources → add_source → refresh_source → source toggles
→ catalog/inspect → plan_install/install → inventory
→ package toggles → plan_uninstall/uninstall → remove_source
```

- Home A: `/tmp/hana-marketplace-probe-YxHFpP`, port `14613`.
- Home B: `/tmp/hana-marketplace-probe-b-qShiPY`, port `14612`.
- `auto`: automatic-review evidence was recorded for owner-reviewed mutations.
- `operate`: the same lifecycle completed without reviewer confirmations.
- Both runs verified persisted permission/access metadata, no active source, installed package, or skill residue, activation restoration, and unchanged native PluginManager inventory. The smoke harness intentionally retains source snapshot/cache generations as non-installed acquisition evidence; those cache directories are not active source, package, or skill state. Both temporary servers were stopped and ports `14612`/`14613` were free afterward.

### Late smoke-task reconciliation

A later standalone invocation of `node scripts/hana-agent-marketplace-smoke.mjs` exited with code 1 because it was run after the isolated server had already stopped; the disposable home had no live `server-info.json` to connect to. This was a harness-lifecycle/setup failure, not a Marketplace lifecycle result. The server was relaunched on port `14612`, and the smoke was rerun fresh on 2026-08-05. The rerun exited 0 and returned `ok: true` for both `auto` and `operate`, with all 15 ordered actions, owner-review/access evidence, cleanup, activation restoration, and native-inventory preservation verified. The retained Marketplace cache directories were classified as expected non-installed snapshot evidence rather than residue.

### Attended macOS desktop smoke

The freshly installed local `/Applications/HanaAgent.app` was exercised
against a disposable isolated `HANA_HOME` through the packaged UI:

1. Added a temporary server-local Marketplace source through Settings →
   Plugins.
2. Opened Plugin Marketplace, inspected the Claude-compatible package, and
   installed it through the displayed install plan confirmation.
3. Verified the installed package appeared under Manage Plugins as a **Hana
   skills** row with the source-qualified identity and enabled global gate.
4. Toggled the package off and verified the row reported **disabled globally**.
5. Toggled it back on and verified the row reported **enabled**.
6. Uninstalled the package through Manage Plugins using the displayed uninstall
   plan confirmation.
7. Removed the temporary Marketplace source and verified Manage Plugins again
   showed **No plugins installed** while the native PluginManager inventory
   remained empty and the native folder/ZIP dropzone remained visible.

The temporary skill directory and package record were absent after uninstall;
the temporary source was removed before shutdown. Native HyperFrames remained a
catalog-only native PluginManager package and was not installed or mutated.

### Final source/tests/build evidence

- Final Marketplace/security/skill/desktop/engine regression suite: **35 files, 643 tests passed**.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- `npm run lint`: exit 0, 0 errors; repository warning debt remains non-blocking.
- `npm run build:client`: passed.
- `npm run build:server`: passed.
- `SKIP_NOTARIZE=true npm run install:local`: passed.
- `codesign --verify --deep --strict --verbose=2 /Applications/HanaAgent.app`:
  passed.
- Installed bundle metadata reported `channel: local`, source repository
  `karlorz/openhanako`, and the intended local build SHA.

A final local diff review covered the four remediation code/test files and this
evidence section after the fresh test/build/install gates; no actionable defect
was found. Two delegated read-only review workers were cancelled after
exceeding their bounded runtime without producing a verdict. No integration
action is authorized by this evidence.

## Scope and safety statement

- No GitHub, pull request, remote branch, `dev`, `main`, or `sg01` state was changed.
- No deployment or external service mutation was performed.
- Native marketplace packages remain PluginManager-owned; Claude marketplace packages remain Hana skills through SkillManager.
- `GET /api/plugins` and the Marketplace skill-package inventory contract remain unchanged.
- The read-only review baseline remains separate and unmodified.
