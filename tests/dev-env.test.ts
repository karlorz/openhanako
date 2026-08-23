import { describe, expect, it } from "vitest";
import { applyDevEnvironment, defaultDevHanaHome } from "../scripts/dev-env.js";

describe("applyDevEnvironment", () => {
  it("preserves an explicitly requested HANA_HOME for isolated server launches", () => {
    const env: Record<string, string | undefined> = { HANA_HOME: "/tmp/isolated-hana-home" };
    applyDevEnvironment(env);
    expect(env.HANA_HOME).toBe("/tmp/isolated-hana-home");
  });

  it("still defaults HANA_HOME to the dev home when unset", () => {
    const env: Record<string, string | undefined> = {};
    applyDevEnvironment(env);
    expect(env.HANA_HOME).toBe(defaultDevHanaHome());
  });
});
