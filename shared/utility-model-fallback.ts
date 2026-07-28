export type UtilityModelRefs = {
  utilityModelRef: any;
  largeModelRef: any;
};

/**
 * Resolve optional utility preferences against per-agent configuration.
 * The primary chat model is required and is therefore the final fallback.
 */
export function resolveUtilityModelRefs(
  agentConfig: any = {},
  sharedModels: any = {},
): UtilityModelRefs {
  const agentModels = agentConfig?.models || {};
  const utilityModelRef = sharedModels?.utility
    || agentModels.utility
    || agentModels.chat
    || null;
  const largeModelRef = sharedModels?.utility_large
    || agentModels.utility_large
    || utilityModelRef;

  return { utilityModelRef, largeModelRef };
}

export function hasEffectiveUtilityModel(
  agentConfig: any = {},
  sharedModels: any = {},
): boolean {
  return !!resolveUtilityModelRefs(agentConfig, sharedModels).utilityModelRef;
}
