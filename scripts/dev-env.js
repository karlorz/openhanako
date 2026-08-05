import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDevHanaHome() {
  return join(homedir(), ".hanako-dev");
}

export function applyDevEnvironment(env = process.env, {
  nodeBin = process.execPath,
} = {}) {
  if (!env.HANA_HOME || !String(env.HANA_HOME).trim()) {
    env.HANA_HOME = defaultDevHanaHome();
  }
  env.HANA_DEV_NODE_BIN = nodeBin;
  return env;
}
