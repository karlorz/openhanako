# [Bug] Vision auxiliary model picker misses models until capability re-toggle because Settings catalog is not SoT

> Local draft only. Codex and Claude must never submit, comment, edit, label, react, close, or otherwise publish this upstream. Human approval changes the draft wording state only; a human must post manually outside the agent session.

Tracked fix: `vision-capability-settings-sot`
Classification: `upstream`
Current status: `local-verified`
Suggested grouping: `fix: provider catalog is SoT for vision capability; no dictionary-only UI lie`
Commits: `a98f86a9`

Related upstream issues:

- #1904: https://github.com/liliMozi/openhanako/issues/1904
- #538: https://github.com/liliMozi/openhanako/issues/538
- #594: https://github.com/liliMozi/openhanako/issues/594
- #1854: https://github.com/liliMozi/openhanako/issues/1854
- #1919: https://github.com/liliMozi/openhanako/issues/1919

## Summary

The Vision auxiliary model dropdown only lists models whose runtime projection has `input` including `"image"`. For custom OpenAI-compatible providers, a model can appear Vision-capable in the model edit panel (dictionary/reference merge) while the provider catalog still has a bare string id. Saving without re-toggling Vision did not persist `image: true`, so the model never appeared in Vision auxiliary until the user toggled Vision off and on and saved again.

This is a Settings catalog vs dictionary precedence bug, not a missing hard-coded fallback entry. `known-model-fallbacks.json` may stay outdated; user-edited provider model fields must remain the durable source of truth.

## Expected

- Provider catalog model object fields (`image` / legacy `vision`, `video`, `audio`, `reasoning`) are the durable authority after Settings add/edit.
- The model edit panel does not show Vision ON solely by borrowing another provider's known-models partition when the current provider is known.
- Saving a model with Vision shown ON materializes `image: true` into the catalog without requiring a fake re-toggle.
- Vision auxiliary lists the model after save once projection refreshes.
- Saving a bare Ollama VL model without touching Vision does not stamp `image: false` over runtime name-inference.
- Unknown custom model ids still work via explicit Vision ON + Save; no repo list update is required.

## Actual

- Client reference lookup could cross-scan other known-models partitions for display.
- Runtime `model-sync` only used provider partition + generic fallbacks + Ollama infer when catalog fields were absent.
- Model edit Save used dirty-only capability writes, so dictionary-true Vision never entered the catalog until a toggle dirtied the field.
- Capability icons in the added-models list could reflect dictionary merge rather than catalog-saved fields.

## Local fork fix

- Align settings reference lookup with server layers when provider is set: provider partition → generic fallbacks only (no cross-provider steal).
- Hybrid capability Save patch: always materialize `true` capabilities; materialize `false` only if the catalog already had that field or the user toggled it.
- Show list capability icons from catalog-saved fields only.
- One-shot stamp of reference defaults into the catalog on custom model add when a provider-scoped/fallback hit exists.
- Invalidate settings config cache after model metadata Save so Vision auxiliary re-reads projection.
- Clarify locale hint: enable Vision and Save; catalog hints may be outdated.

## Verification

- Custom provider + known-looking model id: edit → Vision ON → Save once → model appears under Vision auxiliary.
- Bare unknown id: remains text-only until user enables Vision and Saves.
- Bare Ollama VL family id: Save without toggle does not persist `image: false`.
- User turns Vision OFF and Saves: stays off (catalog wins over dictionary).
- Unit tests for `buildCapabilitySavePatch`, catalog-only icons, no cross-provider reference steal, and model-sync user catalog projection.
