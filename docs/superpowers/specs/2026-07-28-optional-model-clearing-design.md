# Optional Model Clearing and Effective Fallback Design

Date: 2026-07-28

## Context

The Providers settings allow the small utility, large utility, and auxiliary vision model preferences to be cleared with `None (empty)`. Persistence already accepts `null` and removes the stored preference. The primary Agent chat model remains required.

Pre-release review found two contracts that must be reconciled before publishing this behavior:

- Clearing either utility preference makes Agent Memory appear unavailable even though runtime execution can fall back to the required chat model.
- The interface says an empty large utility preference falls back to the small utility model, while the runtime currently skips directly to chat.

The model health-test button is also represented only by an icon, which makes its purpose and status unclear.

## Approved Behavior

Model resolution uses this order:

1. Small utility: shared small utility, agent small utility, required agent chat.
2. Large utility: shared large utility, agent large utility, effective small utility, required agent chat.
3. Auxiliary vision: selected auxiliary vision model when configured and enabled; existing vision fallback behavior remains unchanged when it is empty.

Clearing an optional preference removes only that preference. It does not disable Agent Memory or modify `memory.enabled`.

## Runtime Design

Utility resolution must derive one effective small-utility reference first. Large-utility resolution then uses that effective reference as its fallback. All runtime paths that initialize or refresh an agent must apply the same order so startup, live preference updates, and routed execution cannot diverge.

If no utility preference exists, the required agent chat model satisfies utility readiness. Existing missing-model and unresolved-model errors remain in effect if no reference can be resolved or the selected/fallback reference is unknown.

## Settings Design

Agent Memory readiness must represent effective runtime readiness, not the presence of both optional global preference fields. Because the Agent chat model is required, clearing a global utility preference must leave the Memory toggle, controls, and health polling available. Loading state remains indeterminate until the relevant settings resources are loaded.

The model health-test control remains hidden when `None (empty)` is selected because there is no concrete model to test. When present, it must:

- use `type="button"`;
- have a localized accessible name and matching tooltip describing the action;
- expose localized testing, success, and failure labels instead of relying only on icon shape or color;
- mark decorative SVGs as hidden from assistive technology;
- retain the existing temporary visual status transitions.

No new reusable visual component or layout pattern is introduced; the existing compact settings-row styling is preserved.

## Data Flow

1. The user chooses `None (empty)` in an optional `ModelWidget`.
2. `ModelWidget` calls `onSelect(null)`.
3. Settings auto-save sends the corresponding model field as `null`.
4. The backend deletes that preference and returns the refreshed effective configuration.
5. Runtime utility resolution applies `utility_large -> utility -> chat` as needed.
6. Agent Memory remains governed by its own persisted enabled state and effective model readiness.

## Verification

Focused tests must cover:

- clearing all three optional model fields saves `null`;
- required model widgets still reject clearing;
- large utility resolves to small utility before chat;
- small utility resolves to required chat when empty;
- live configuration refresh and initial agent construction use the same fallback order;
- clearing one or both utility preferences does not disable or visually switch off Agent Memory;
- the model health-test button has an accessible action/status label and is absent for an empty model;
- all added localization keys exist in every supported locale.

Before release, run the focused suites, the full test suite, TypeScript checks, and `git diff --check`. Reinstall and verify the local macOS desktop package if runtime/UI behavior changed after the previous packaged smoke test.

## Release

Keep product version `0.416.51`; package-version changes are reserved for attended stable upstream sync. Prepare the release digests and publish fork tag `v0.416.51-karlorz.9` from `dev` after all gates pass. The tag may publish a legacy-raw GitHub prerelease; signed beta-train publication remains unavailable without the production `HANA_SIGN_KEY` repository secret.

## Non-goals

- Making the primary Agent chat model optional.
- Changing auxiliary vision fallback semantics beyond allowing its explicit preference to be empty.
- Deploying or upgrading the `sg01` server.
- Publishing a production-signed train with a temporary local key.
