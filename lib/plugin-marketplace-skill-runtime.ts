export async function refreshMarketplaceSkillRuntime(
  engine: any,
  options: { emitSkillsChanged?: () => void } = {},
) {
  let reloadError: string | null = null;
  try {
    await engine.reloadSkills?.();
  } catch (err: any) {
    reloadError = err?.message || String(err);
  }
  options.emitSkillsChanged?.();
  return { reloadError };
}
