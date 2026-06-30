# [Bug] Provider model removal can fail to persist for slash-bearing local provider models

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `provider-model-removal-persistence`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fix: make provider model removal persist for slash-bearing local provider models`
Commits: `v0.346.18-karlorz.6`

## Summary

Removing an added provider model from Settings can appear to succeed but the model can reappear after refresh, especially for local/custom providers and model ids containing slashes such as `vendor/model-a`. The failure was first observed through a remote Hana server connection, but the persistence path is shared with local provider plugin definitions.

## Expected

- Clicking remove for an added provider model deletes that exact model from the provider registry.
- Model ids containing `/` are matched as model ids, not split or left URL-encoded.
- Saving an explicit provider `models` list replaces the local provider plugin model list, including the empty-list case after the last model is removed.
- Refreshing Settings or reconnecting to a remote server does not bring the deleted model back.

## Actual

- The Settings UI removed models by sending a broad `/api/config` provider rewrite instead of the dedicated provider-model delete endpoint.
- The provider model route could receive a still-encoded path param such as `vendor%2Fmodel-a`, so slash-bearing ids were not always removed from the registry.
- Local provider plugin saves merged existing plugin models back into the explicit `models` list, so `models: []` could be normalized back to the prior plugin definition.

## Local fork fix

- Use `DELETE /api/providers/:providerId/models/:modelId` from `ProviderModelList` for model removal.
- Decode provider model route params once before calling registry update/remove operations.
- Treat an explicit `models` field in local provider config as a replacement list; only merge existing plugin models when the save did not include `models`.

## Verification

- Add a slash-bearing model such as `vendor/model-a` to a local/custom provider.
- Remove it through Settings.
- Refresh Settings or reconnect through a remote server and confirm the model does not return.
- Regression tests should cover the UI delete endpoint, encoded route params, and local provider plugin persistence.
