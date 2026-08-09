#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const UPSTREAM_REPOSITORY = "lilimozi/openhanako";
export const FORK_REPOSITORY = "karlorz/openhanako";
export const PERMANENT_DASHBOARD_PR = "1";

const SHELL_OPERATORS = new Set([";", "&&", "||", "|", "|&", "&", "\n"]);
const SHELL_WRAPPERS = new Set(["command", "exec", "nohup", "sudo", "time"]);
const EXTENDED_SHELL_WRAPPERS = new Set(["env", ...SHELL_WRAPPERS, "nice", "stdbuf", "timeout", "xargs"]);
const CLASSIFIED_EXECUTABLES = new Set([
  "bash",
  "bun",
  "curl",
  "dash",
  "deno",
  "gh",
  "git",
  "node",
  "nodejs",
  "sh",
  "wget",
  "zsh",
]);
const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const GH_READ_ACTIONS = new Set(["list", "view", "status", "checks", "diff"]);
const GH_SOCIAL_GROUPS = new Set(["issue", "pr", "discussion", "label"]);
const GH_ENGINEERING_GROUPS = new Set(["cache", "release", "run", "workflow"]);
const GH_ENGINEERING_MUTATIONS = new Set([
  "cancel",
  "create",
  "delete",
  "disable",
  "edit",
  "enable",
  "rerun",
  "run",
  "upload",
]);
const MUTATION_TOOL_PATTERN = /(?:^|[_-])(add|approve|archive|close|comment|create|delete|disable|dispatch|edit|enable|label|lock|mark|merge|mutate|publish|push|react|remove|reopen|request|review|submit|transfer|unlock|update|upload|write)(?:$|[_-])/i;
const SOCIAL_TOOL_PATTERN = /(?:^|[_-])(discussion|issue|label|pull(?:_request)?|reaction|review|comment)(?:$|[_-])/i;
const READ_TOOL_PATTERN = /(?:^|[_-])(check|diff|download|fetch|get|list|navigate|open|read|screenshot|search|snapshot|status|view)(?:$|[_-])/i;
const GITHUB_SOCIAL_PATH_PATTERN = /\/(?:issues|comments|pulls|discussions|labels|reactions)(?:\/|\s|$)/i;

function pass(reasonCode = "NO_PROTECTED_MUTATION") {
  return { decision: "pass", reasonCode };
}

function deny(reasonCode, reason) {
  return { decision: "deny", reasonCode, reason };
}

function basename(command) {
  return String(command ?? "").replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
}

function normalizeRepository(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^https?:\/\/(?:api\.|uploads\.)?github\.com\/(?:repos\/)?/i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/\.git(?:\/.*)?$/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const match = normalized.match(/^([^/\s]+\/[^/\s]+)$/);
  return match ? match[1] : null;
}

function repositoriesFromText(text) {
  const source = String(text ?? "");
  const repositories = [];
  const patterns = [
    /(?:https?:\/\/(?:api\.|uploads\.)?github\.com\/(?:repos\/)?|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s/'"?#]+\/[^\s/'"?#]+?)(?:\.git)?(?=[/\s'"?#]|$)/ig,
    /\brepos\/([^\s/'"?#]+\/[^\s/'"?#]+)(?=[/\s'"?#]|$)/ig,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const repository = normalizeRepository(match[1]);
      if (repository && !repositories.includes(repository)) repositories.push(repository);
    }
  }
  return repositories;
}

function repositoryFromUrl(text) {
  const repositories = repositoriesFromText(text);
  if (repositories.includes(UPSTREAM_REPOSITORY)) return UPSTREAM_REPOSITORY;
  if (repositories.includes(FORK_REPOSITORY)) return FORK_REPOSITORY;
  return repositories[0] ?? null;
}

function optionValue(args, ...names) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    for (const name of names) {
      if (value === name) return args[index + 1] ?? null;
      if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
    }
  }
  return null;
}

function attachedOptionValue(args, shortName, longName) {
  const direct = optionValue(args, shortName, longName);
  if (direct) return direct;
  const short = args.find((value) => value.startsWith(shortName) && value.length > shortName.length);
  return short ? short.slice(shortName.length) : null;
}

function ghRepository(args, text = "") {
  const optionRepository = normalizeRepository(optionValue(args, "--repo", "-R"));
  return optionRepository ?? repositoryFromUrl(text);
}

function isProtectedRepository(repository) {
  return repository === UPSTREAM_REPOSITORY || repository === FORK_REPOSITORY;
}

function denyProtectedMutation(repository, { social = false, ambiguous = false } = {}) {
  if (repository === UPSTREAM_REPOSITORY) {
    return deny(
      "UPSTREAM_READONLY",
      "Codex and Claude may read liliMozi/openhanako and draft locally, but every upstream mutation is permanently human-only.",
    );
  }
  if (repository === FORK_REPOSITORY && social) {
    return deny(
      "SOCIAL_HUMAN_ONLY",
      "Issues, comments, reviews, discussions, reactions, labels, and direct PR edits on karlorz/openhanako are human-only; prepare a local Markdown draft instead.",
    );
  }
  if (ambiguous || !repository) {
    return deny(
      "AMBIGUOUS_GITHUB_MUTATION",
      "The GitHub mutation target or operation is ambiguous. Use an explicit fork engineering command, or keep the communication as a local draft.",
    );
  }
  return pass("OUTSIDE_PROTECTED_REPOSITORIES");
}

export function tokenizeShell(command) {
  const tokens = [];
  let token = "";
  let quote = null;

  const pushToken = () => {
    if (token) tokens.push(token);
    token = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        token += command[++index];
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      token += command[++index];
      continue;
    }
    if (/\s/.test(char)) {
      pushToken();
      if (char === "\n") tokens.push("\n");
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      pushToken();
      if (char === "|" && command[index + 1] === "&") {
        tokens.push("|&");
        index += 1;
        continue;
      }
      if (command[index + 1] === char) {
        tokens.push(`${char}${char}`);
        index += 1;
      } else {
        tokens.push(char);
      }
      continue;
    }
    token += char;
  }
  pushToken();
  return tokens;
}

function executableSubcommands(command) {
  const subcommands = [];
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === "'") continue;

    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      if (end < 0) return { subcommands, malformed: true };
      subcommands.push(command.slice(index + 1, end));
      index = end;
      continue;
    }

    if (["$", "<", ">"].includes(char) && command[index + 1] === "(") {
      const start = index + 2;
      let depth = 1;
      let nestedQuote = null;
      let end = start;
      for (; end < command.length; end += 1) {
        const nestedChar = command[end];
        if (nestedChar === "\\") {
          end += 1;
          continue;
        }
        if ((nestedChar === "'" || nestedChar === '"')) {
          nestedQuote = nestedQuote === nestedChar ? null : (nestedQuote ?? nestedChar);
          continue;
        }
        if (nestedQuote) continue;
        if (nestedChar === "(") depth += 1;
        if (nestedChar === ")") depth -= 1;
        if (depth === 0) break;
      }
      if (depth !== 0) return { subcommands, malformed: true };
      subcommands.push(command.slice(start, end));
      index = end;
    }
  }
  return { subcommands, malformed: false };
}

function shellSegments(command) {
  const segments = [];
  let current = [];
  for (const token of tokenizeShell(command)) {
    if (SHELL_OPERATORS.has(token)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function commandPosition(segment) {
  let index = 0;
  while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index])) index += 1;
  if (basename(segment[index]) === "env") {
    index += 1;
    while (index < segment.length && (segment[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index]))) index += 1;
  }
  while (SHELL_WRAPPERS.has(basename(segment[index]))) {
    index += 1;
    while (index < segment.length && segment[index].startsWith("-")) index += 1;
  }
  return index;
}

function classifyGhApi(args, segmentText) {
  const endpoint = args[1] ?? "";
  const repository = ghRepository(args, `${endpoint} ${segmentText}`);
  const explicitMethod = attachedOptionValue(args, "-X", "--method")?.toUpperCase();
  const sendsFields = args.some((value) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(value)
    || /^(?:-f|-F).+/.test(value)
    || /^--(?:field|raw-field|input)=/.test(value));
  const graphqlText = segmentText;
  let graphqlDocument = "";
  for (let index = 0; index < args.length && !graphqlDocument; index += 1) {
    if (/^query=/.test(args[index])) graphqlDocument = args[index].slice("query=".length);
    else if (args[index] === "query" && index + 1 < args.length) graphqlDocument = args[index + 1];
  }
  const isGraphql = endpoint === "graphql" || /\/graphql(?:\s|$)/i.test(segmentText);

  if (isGraphql) {
    if (/^\s*mutation\b/i.test(graphqlDocument) || /\bmutation\b/i.test(graphqlText)) {
      return denyProtectedMutation(repository, {
        social: repository === FORK_REPOSITORY && SOCIAL_TOOL_PATTERN.test(graphqlText),
        ambiguous: !repository,
      });
    }
    if (/^\s*query\b/i.test(graphqlDocument)) return pass("GITHUB_GRAPHQL_READ");
    return denyProtectedMutation(repository, { ambiguous: true });
  }

  const method = explicitMethod ?? (sendsFields ? "POST" : "GET");
  if (READ_ONLY_HTTP_METHODS.has(method)) return pass("GITHUB_API_READ");
  const social = GITHUB_SOCIAL_PATH_PATTERN.test(endpoint);
  return denyProtectedMutation(repository, { social, ambiguous: true });
}

function classifyGh(args, segmentText) {
  const group = args[0]?.toLowerCase();
  const action = args[1]?.toLowerCase();
  if (!group || ["help", "version"].includes(group)) return pass("GH_LOCAL_OR_HELP");
  if (group === "api") return classifyGhApi(args, segmentText);

  const repository = ghRepository(args, segmentText);
  if (GH_SOCIAL_GROUPS.has(group)) {
    if (!action || GH_READ_ACTIONS.has(action)) return pass("GITHUB_SOCIAL_READ");
    return denyProtectedMutation(repository, { social: true, ambiguous: !repository });
  }

  if (GH_ENGINEERING_GROUPS.has(group)) {
    if (!action || GH_READ_ACTIONS.has(action) || ["download", "watch"].includes(action)) {
      return pass("GITHUB_ENGINEERING_READ");
    }
    if (GH_ENGINEERING_MUTATIONS.has(action)) {
      if (repository === FORK_REPOSITORY) return pass("FORK_ENGINEERING_AUTH_REQUIRED");
      return denyProtectedMutation(repository, { ambiguous: !repository });
    }
  }

  if (group === "search") return pass("GITHUB_SEARCH_READ");
  if (group === "repo") {
    if (["list", "view", "clone"].includes(action)) return pass("GITHUB_REPOSITORY_READ");
    if (action === "set-default") {
      const selected = normalizeRepository(args[2]);
      return selected === UPSTREAM_REPOSITORY
        ? denyProtectedMutation(selected)
        : pass("LOCAL_DEFAULT_REPOSITORY_CONFIGURATION");
    }
    if (repository === UPSTREAM_REPOSITORY) return denyProtectedMutation(repository);
    if (repository === FORK_REPOSITORY || !repository) {
      return denyProtectedMutation(repository, { ambiguous: true });
    }
  }

  if (["auth", "config", "extension", "secret", "ssh-key", "variable"].includes(group)) {
    if (["status", "get", "list"].includes(action)) return pass("GH_CONFIGURATION_READ");
    return denyProtectedMutation(repository, { ambiguous: true });
  }

  return denyProtectedMutation(repository, { ambiguous: !repository || isProtectedRepository(repository) });
}

function gitSubcommandArgs(args) {
  const optionsWithValues = new Set([
    "-C",
    "-c",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
  ]);
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (value === "--") return args.slice(index + 1);
    if (!value.startsWith("-")) break;
    if (optionsWithValues.has(value)) index += 2;
    else index += 1;
  }
  return args.slice(index);
}

function classifyGit(args, segmentText) {
  const subcommandArgs = gitSubcommandArgs(args);
  const action = subcommandArgs[0]?.toLowerCase();
  if (action !== "push") {
    if (action === "remote" && ["add", "set-url"].includes(subcommandArgs[1]?.toLowerCase())) {
      const repository = repositoryFromUrl(segmentText);
      if (repository === UPSTREAM_REPOSITORY) return denyProtectedMutation(repository);
    }
    return pass("GIT_LOCAL_OR_READ");
  }

  let remote = null;
  for (let index = 1; index < subcommandArgs.length; index += 1) {
    if (subcommandArgs[index].startsWith("-")) continue;
    remote = subcommandArgs[index];
    break;
  }
  const configuredRepository = repositoryFromUrl(segmentText);
  if (configuredRepository === UPSTREAM_REPOSITORY) {
    return denyProtectedMutation(UPSTREAM_REPOSITORY);
  }
  const repository = repositoryFromUrl(remote ?? "");
  if (remote === "upstream" || repository === UPSTREAM_REPOSITORY) {
    return denyProtectedMutation(UPSTREAM_REPOSITORY);
  }
  if (remote === "origin" || repository === FORK_REPOSITORY) {
    return pass("FORK_ENGINEERING_AUTH_REQUIRED");
  }
  if (repository && !isProtectedRepository(repository)) return pass("OUTSIDE_PROTECTED_REPOSITORIES");
  return denyProtectedMutation(null, { ambiguous: true });
}

function classifyHttpClient(executable, args, segmentText) {
  const repository = repositoryFromUrl(segmentText);
  if (!isProtectedRepository(repository)) return pass("HTTP_OUTSIDE_PROTECTED_REPOSITORIES");

  let method = "GET";
  if (executable === "curl") {
    const explicitMethod = attachedOptionValue(args, "-X", "--request");
    if (explicitMethod) method = explicitMethod.toUpperCase();
    if (args.some((value) => /^(?:-d.+|-F.+|-T.+|--json(?:=|$)|--data(?:-ascii|-binary|-raw|-urlencode)?(?:=|$)|--form(?:=|$)|--upload-file(?:=|$)|-d$|-F$|-T$)/.test(value))) {
      method = explicitMethod?.toUpperCase() ?? "POST";
    }
  } else {
    const explicitMethod = optionValue(args, "--method");
    if (explicitMethod) method = explicitMethod.toUpperCase();
    else if (args.some((value) => /^(?:--post-data|--post-file)(?:=|$)/.test(value))) method = "POST";
  }
  if (READ_ONLY_HTTP_METHODS.has(method)) return pass("PUBLIC_GITHUB_HTTP_READ");
  const social = GITHUB_SOCIAL_PATH_PATTERN.test(segmentText);
  return denyProtectedMutation(repository, { social, ambiguous: repository === FORK_REPOSITORY && !social });
}

function classifyNodeScript(args, segmentText) {
  const script = args.find((value) => !value.startsWith("-")) ?? "";
  if (/track-upstream-issues\.mjs$/.test(script)) return pass("LOCAL_UPSTREAM_TRACKER");
  if (/sync-upstream\.mjs$/.test(script) && args.includes("--conflict-plan")) {
    const requestedPr = optionValue(args, "--pr");
    if (requestedPr && requestedPr !== PERMANENT_DASHBOARD_PR) {
      return denyProtectedMutation(FORK_REPOSITORY, { social: true });
    }
    return pass("FORK_DASHBOARD_AUTH_REQUIRED");
  }
  if (/publish-train\.mjs$/.test(script)) {
    const repository = repositoryFromUrl(segmentText)
      ?? normalizeRepository(segmentText.match(/\bGITHUB_REPOSITORY=([^\s]+)/)?.[1]);
    if (repository === FORK_REPOSITORY) return pass("FORK_ENGINEERING_AUTH_REQUIRED");
    return denyProtectedMutation(repository ?? UPSTREAM_REPOSITORY, { ambiguous: !repository });
  }
  if (args.includes("-e") || args.includes("--eval")) {
    const repository = repositoryFromUrl(segmentText);
    if (isProtectedRepository(repository) && /\b(?:POST|PATCH|PUT|DELETE|mutation|createIssue|addComment)\b/i.test(segmentText)) {
      return denyProtectedMutation(repository, {
        social: repository === FORK_REPOSITORY && SOCIAL_TOOL_PATTERN.test(segmentText),
        ambiguous: repository === FORK_REPOSITORY,
      });
    }
  }
  return pass("LOCAL_SCRIPT");
}

function classifySegment(segment) {
  let position = commandPosition(segment);
  const firstPosition = segment.findIndex((value) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value));
  if (EXTENDED_SHELL_WRAPPERS.has(basename(segment[firstPosition]))) {
    const classifiedPosition = segment.findIndex(
      (value, index) => index > firstPosition && CLASSIFIED_EXECUTABLES.has(basename(value)),
    );
    if (classifiedPosition >= 0) position = classifiedPosition;
  }
  const executable = basename(segment[position]);
  const args = segment.slice(position + 1);
  const segmentText = segment.join(" ");
  if (!executable) return pass();

  if (["bash", "dash", "sh", "zsh"].includes(executable)) {
    const commandOption = args.findIndex((value) => value === "--command" || /^-[^-]*c/.test(value));
    const nested = commandOption >= 0 ? args[commandOption + 1] : null;
    if (commandOption < 0) return pass("INTERACTIVE_SHELL");
    return nested ? classifyShellCommand(nested) : denyProtectedMutation(null, { ambiguous: true });
  }
  if (executable === "xargs") {
    const nestedPosition = args.findIndex((value) => CLASSIFIED_EXECUTABLES.has(basename(value)));
    return nestedPosition >= 0 ? classifySegment(args.slice(nestedPosition)) : pass("XARGS_WITHOUT_COMMAND");
  }
  if (executable === "gh") return classifyGh(args, segmentText);
  if (executable === "git") return classifyGit(args, segmentText);
  if (["curl", "wget"].includes(executable)) return classifyHttpClient(executable, args, segmentText);
  if (["node", "nodejs", "bun", "deno"].includes(executable)) return classifyNodeScript(args, segmentText);
  return pass("LOCAL_COMMAND");
}

export function classifyShellCommand(command) {
  if (typeof command !== "string" || !command.trim()) {
    return deny("INVALID_HOOK_INPUT", "The intercepted shell command was missing; refusing to fail open.");
  }
  const nested = executableSubcommands(command);
  if (nested.malformed) {
    return deny("AMBIGUOUS_GITHUB_MUTATION", "The shell command contains malformed executable substitution; refusing to fail open.");
  }
  for (const subcommand of nested.subcommands) {
    const nestedResult = classifyShellCommand(subcommand);
    if (nestedResult.decision === "deny") return nestedResult;
  }

  let classifiedPass = pass();
  for (const segment of shellSegments(command)) {
    const result = classifySegment(segment);
    if (result.decision === "deny") return result;
    if (result.reasonCode !== "NO_PROTECTED_MUTATION") classifiedPass = result;
  }
  return classifiedPass;
}

function flattenStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flattenStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => flattenStrings(item, output));
  return output;
}

function classifyMcpEvent(toolName, toolInput) {
  const normalizedToolName = toolName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (READ_TOOL_PATTERN.test(normalizedToolName) && !MUTATION_TOOL_PATTERN.test(normalizedToolName)) {
    return pass("MCP_GITHUB_READ");
  }
  const explicitRepository = (toolInput?.owner && toolInput?.repo
    ? normalizeRepository(`${toolInput.owner}/${toolInput.repo}`)
    : null)
    ?? normalizeRepository(toolInput?.repository)
    ?? normalizeRepository(toolInput?.repo);
  const namedMutation = MUTATION_TOOL_PATTERN.test(normalizedToolName);
  const namedSocial = SOCIAL_TOOL_PATTERN.test(normalizedToolName);
  const serialized = explicitRepository && (namedMutation || namedSocial)
    ? ""
    : flattenStrings(toolInput).join(" ");
  const repository = explicitRepository ?? repositoryFromUrl(serialized);
  const githubTool = /(?:^|__)github(?:__|$)/i.test(normalizedToolName) || /github\.com|api\.github\.com/i.test(serialized);
  if (!githubTool && !repository) return pass("MCP_OUTSIDE_GITHUB_BOUNDARY");
  const mutation = namedMutation || /\b(?:POST|PATCH|PUT|DELETE|mutation)\b/i.test(serialized);
  const social = namedSocial || SOCIAL_TOOL_PATTERN.test(serialized);
  if (!mutation && !social) return denyProtectedMutation(repository, { ambiguous: true });
  if (repository === UPSTREAM_REPOSITORY) return denyProtectedMutation(repository);
  if (repository === FORK_REPOSITORY && social) return denyProtectedMutation(repository, { social: true });
  return denyProtectedMutation(repository, { ambiguous: true });
}

export function classifyHookEvent(event) {
  if (!event || typeof event !== "object") {
    return deny("INVALID_HOOK_INPUT", "The hook event was not valid JSON; refusing to fail open.");
  }
  const toolName = String(event.tool_name ?? "");
  if (toolName === "Bash") return classifyShellCommand(event.tool_input?.command);
  if (toolName.startsWith("mcp__")) return classifyMcpEvent(toolName, event.tool_input ?? {});
  return pass("READ_ONLY_OR_UNMATCHED_TOOL");
}

export function denyHookOutput(result) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[${result.reasonCode}] ${result.reason}`,
    },
  };
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function main() {
  let result;
  try {
    const raw = await readStdin();
    result = classifyHookEvent(JSON.parse(raw));
  } catch {
    result = deny("INVALID_HOOK_INPUT", "The hook input could not be parsed; refusing to fail open.");
  }
  if (result.decision === "deny") {
    process.stdout.write(`${JSON.stringify(denyHookOutput(result))}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
