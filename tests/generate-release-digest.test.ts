import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDigestFileToHistoryFile, collectDigestSource, generateDigestWithOpenAI, parseArgs, resolveDigestConfig } from "../scripts/generate-release-digest.mjs";

const describeEnvrc = process.platform === "win32" ? describe.skip : describe;

function runEnvrcContract({
  configureSecret = false,
  configuredPath,
  secretExists = false,
  secretMode = "600",
  malformed = false,
}: {
  configureSecret?: boolean;
  configuredPath?: string;
  secretExists?: boolean;
  secretMode?: string;
  malformed?: boolean;
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-digest-envrc-"));
  const binDir = path.join(tmpDir, "bin");
  const secretPath = path.join(tmpDir, "release-digest-secret");
  fs.mkdirSync(binDir);
  if (secretExists) {
    fs.writeFileSync(secretPath, "api_key=synthetic-test-key\n", { mode: 0o600 });
  }

  fs.writeFileSync(path.join(binDir, "uname"), "#!/bin/sh\nprintf '%s\\n' Linux\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "stat"),
    "#!/bin/sh\nprintf '%s\\n' \"${TEST_SECRET_MODE:-600}\"\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "direnv"),
    [
      "#!/bin/sh",
      "if [ \"${TEST_DIRENV_MALFORMED:-false}\" = true ]; then",
      "  printf '%s\\n' 'invalid line: api_key=synthetic-test-key' >&2",
      "  exit 1",
      "fi",
      "printf '%s\\n' \"export api_key=synthetic-test-key\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const script = [
    "dotenv_if_exists() {",
    "  if [ \"${TEST_CONFIGURE_SECRET:-false}\" = true ]; then",
    "    export OPENHANAKO_RELEASE_DIGEST_SECRET_FILE=\"$TEST_CONFIGURED_SECRET_PATH\"",
    "  fi",
    "}",
    "dotenv() { printf 'dotenv-loaded:%s\\n' \"$1\"; }",
    "source \"$TEST_ENVRC_PATH\"",
  ].join("\n");

  try {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      HOME: tmpDir,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      TEST_CONFIGURE_SECRET: configureSecret ? "true" : "false",
      TEST_CONFIGURED_SECRET_PATH: configuredPath ?? secretPath,
      TEST_DIRENV_MALFORMED: malformed ? "true" : "false",
      TEST_ENVRC_PATH: path.resolve(".envrc"),
      TEST_SECRET_MODE: secretMode,
    };
    // The .envrc contract test is hermetic: an operator's real
    // OPENHANAKO_RELEASE_DIGEST_SECRET_FILE must not switch the .envrc into
    // its configured-secret branch on a developer machine.
    delete childEnv.OPENHANAKO_RELEASE_DIGEST_SECRET_FILE;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: childEnv,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      secretPath,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("generate-release-digest", () => {
  it("maps a fork release tag to the installed product version", async () => {
    const source = await collectDigestSource({
      tag: "v0.407.15-karlorz.1",
      previousTag: "v0.407.15",
      ref: "HEAD",
      owner: "karlorz",
      repo: "openhanako",
      releaseUrl: "",
    });

    expect(source.tag).toBe("v0.407.15-karlorz.1");
    expect(source.version).toBe("0.407.15");
  });

  it("documents a non-executing direnv BYOK contract", () => {
    const envrc = fs.readFileSync(path.resolve(".envrc"), "utf-8");
    const example = fs.readFileSync(path.resolve(".env.example"), "utf-8");
    const gitignore = fs.readFileSync(path.resolve(".gitignore"), "utf-8");

    expect(envrc).toContain("dotenv_if_exists .env");
    expect(envrc).toContain("OPENHANAKO_RELEASE_DIGEST_SECRET_FILE");
    expect(envrc).toContain('if [ -f "$secret_file" ]; then');
    expect(envrc).toContain("Release-digest secret file not loaded");
    expect(envrc).not.toMatch(/^\s*(?:source|\.)\s+/m);
    expect(example).toContain("base_url=https://api.openai.com/v1");
    expect(example).toContain("model=gpt-5.5");
    expect(example).toContain("api_backend=responses");
    expect(example).not.toContain("api_key=");
    expect(gitignore).toContain("!.env.example");
  });

  it("parses local pre-tag defaults without requiring release lookup", () => {
    const args = parseArgs(["--out", "tmp/digest.json"], {
      GITHUB_REF_NAME: "v0.425.4",
      GITHUB_REPOSITORY: "liliMozi/openhanako",
    });
    expect(args).toEqual(expect.objectContaining({
      tag: "v0.425.4",
      previousTag: "auto",
      ref: "HEAD",
      owner: "liliMozi",
      repo: "openhanako",
      out: "tmp/digest.json",
    }));
  });

  it("accepts an explicit git ref and local release notes file", () => {
    const args = parseArgs([
      "--tag", "v0.425.4",
      "--ref", "HEAD",
      "--release-notes-file", "notes.md",
    ], {});

    expect(args).toEqual(expect.objectContaining({
      tag: "v0.425.4",
      ref: "HEAD",
      releaseNotesFile: "notes.md",
    }));
  });

  it("requests strict JSON schema output from OpenAI", async () => {
    const digest = {
      schemaVersion: 1,
      tag: "v0.425.4",
      version: "0.425.4",
      previousTag: "v0.425.3",
      generatedAt: "2026-07-05T00:00:00.000Z",
      noUserFacingChanges: false,
      summary: { zh: "更新说明更清楚。", en: "Update notes are clearer." },
      counts: { feature: 1, fix: 0, improvement: 0, migration: 0 },
      source: {
        owner: "liliMozi",
        repo: "openhanako",
        commitRange: "v0.425.3..v0.425.4",
        releaseUrl: "https://github.com/liliMozi/openhanako/releases/tag/v0.425.4",
        releaseNotes: "",
      },
      items: [
        {
          id: "digest",
          kind: "feature",
          importance: "high",
          title: { zh: "更新摘要", en: "Update digest" },
          summary: { zh: "About 页展示更新内容。", en: "The About page shows update content." },
          details: [],
          sources: [{ type: "commit", ref: "abc123", title: "Add digest" }],
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ output_text: JSON.stringify(digest) }),
    });

    const result = await generateDigestWithOpenAI(
      { tag: "v0.425.4", version: "0.425.4", commits: [] },
      {
        env: { OPENAI_API_KEY: "test-key" },
        fetchImpl,
        model: "gpt-5.5",
      },
    );

    expect(result.tag).toBe("v0.425.4");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
    }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.text.format).toEqual(expect.objectContaining({
      type: "json_schema",
      name: "hana_release_digest",
      strict: true,
    }));
  });

  it("resolves provider-neutral BYOK settings with CLI precedence", () => {
    expect(resolveDigestConfig({
      env: {
        api_key: "test-key",
        base_url: "https://env.example/v1///",
        model: "env-model",
        api_backend: "chat-completions",
      },
      baseUrl: "https://cli.example/v1/",
      model: "cli-model",
      backend: "responses",
    })).toMatchObject({
      apiKey: "test-key",
      baseUrl: "https://cli.example/v1",
      model: "cli-model",
      backend: "responses",
    });
  });

  it("prefers canonical lowercase BYOK values over inherited aliases", () => {
    expect(resolveDigestConfig({
      env: {
        api_key: "project-key",
        API_KEY: "inherited-key",
        OPENAI_API_KEY: "legacy-key",
        base_url: "https://project.example/v1",
        BASE_URL: "https://inherited.example/v1",
        model: "project-model",
        MODEL: "inherited-model",
        api_backend: "chat-completions",
        API_BACKEND: "responses",
      },
    })).toEqual({
      apiKey: "project-key",
      baseUrl: "https://project.example/v1",
      model: "project-model",
      backend: "chat-completions",
    });
  });

  it("supports Chat Completions-compatible BYOK responses", async () => {
    const digest = {
      schemaVersion: 1,
      tag: "v0.425.4",
      version: "0.425.4",
      previousTag: "v0.425.3",
      generatedAt: "2026-07-05T00:00:00.000Z",
      noUserFacingChanges: false,
      summary: { zh: "更新说明更清楚。", en: "Update notes are clearer." },
      counts: { feature: 1, fix: 0, improvement: 0, migration: 0 },
      source: {
        owner: "liliMozi",
        repo: "openhanako",
        commitRange: "v0.425.3..v0.425.4",
        releaseUrl: "https://github.com/liliMozi/openhanako/releases/tag/v0.425.4",
        releaseNotes: "",
      },
      items: [{
        id: "digest",
        kind: "feature",
        importance: "high",
        title: { zh: "更新摘要", en: "Update digest" },
        summary: { zh: "About 页展示更新内容。", en: "The About page shows update content." },
        details: [],
        sources: [{ type: "commit", ref: "abc123", title: "Add digest" }],
      }],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(digest)}\n\`\`\`` } }],
      }),
    });

    const result = await generateDigestWithOpenAI(
      { tag: "v0.425.4", version: "0.425.4", commits: [] },
      {
        env: {
          API_KEY: "test-key",
          BASE_URL: "https://proxy.example/v1/",
          MODEL: "provider-model",
          API_BACKEND: "chat-completions",
        },
        fetchImpl,
      },
    );

    expect(result.tag).toBe("v0.425.4");
    expect(fetchImpl).toHaveBeenCalledWith("https://proxy.example/v1/chat/completions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
    }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("provider-model");
    expect(body.messages).toHaveLength(2);
    expect(body.response_format).toMatchObject({ type: "json_schema" });
    expect(body.store).toBe(false);
  });

  it("rejects unsupported provider-neutral backend values", () => {
    expect(() => resolveDigestConfig({ env: { API_BACKEND: "unsupported" } })).toThrow(/API_BACKEND/);
  });

  it("rejects URLs that could leak credentials or alter endpoint joining", () => {
    expect(() => resolveDigestConfig({ env: { base_url: "https://user:pass@example.test/v1" } })).toThrow(/credentials/);
    expect(() => resolveDigestConfig({ env: { base_url: "https://example.test/v1?token=secret" } })).toThrow(/query/);
  });

  it("fails closed without a key and never sends a request", async () => {
    const fetchImpl = vi.fn();
    await expect(generateDigestWithOpenAI({ tag: "v0.425.4" }, { env: {}, fetchImpl })).rejects.toThrow(/API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not echo a key in HTTP, malformed-output, or schema errors", async () => {
    const key = "test-key-that-must-not-escape";
    const failingFetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: vi.fn().mockResolvedValue(`upstream ${key}`) });
    await expect(generateDigestWithOpenAI({ tag: "v0.425.4" }, { env: { api_key: key }, fetchImpl: failingFetch })).rejects.toThrow(/401/);
    await expect(generateDigestWithOpenAI({ tag: "v0.425.4" }, {
      env: { api_key: key },
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ output_text: "not-json" }) }),
    })).rejects.toThrow(/JSON/);
    await expect(generateDigestWithOpenAI({ tag: "v0.425.4" }, {
      env: { api_key: key },
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ output_text: "{}" }) }),
    })).rejects.toThrow(/Invalid release digest/);
    await expect(generateDigestWithOpenAI({ tag: "v0.425.4" }, {
      env: { api_key: key, api_backend: "chat-completions" },
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ choices: [] }) }),
    })).rejects.toThrow(/Chat Completions/);
    expect(failingFetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${key}`);
  });
});

describeEnvrc("release-digest .envrc execution contract", () => {
  it("keeps the default secret optional for normal development", () => {
    const result = runEnvrcContract();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("optional for normal development");
  });

  it("fails when the configured secret path is empty or missing", () => {
    const empty = runEnvrcContract({ configureSecret: true, configuredPath: "" });
    const missing = runEnvrcContract({
      configureSecret: true,
      configuredPath: "/synthetic/missing/release-digest-secret",
    });

    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("OPENHANAKO_RELEASE_DIGEST_SECRET_FILE must not be empty");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Configured release-digest secret file not found");
  });

  it("rejects group/world permissions before parsing the secret", () => {
    const result = runEnvrcContract({
      configureSecret: true,
      secretExists: true,
      secretMode: "640",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not be group/world accessible");
    expect(result.stdout).not.toContain("dotenv-loaded");
  });

  it("rejects malformed dotenv data without echoing parser output", () => {
    const result = runEnvrcContract({
      configureSecret: true,
      secretExists: true,
      malformed: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not valid dotenv data");
    expect(`${result.stdout}${result.stderr}`).not.toContain("synthetic-test-key");
    expect(`${result.stdout}${result.stderr}`).not.toContain("api_key=");
  });

  it("loads a valid mode-0600 configured secret through dotenv", () => {
    const result = runEnvrcContract({
      configureSecret: true,
      secretExists: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`dotenv-loaded:${result.secretPath}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain("synthetic-test-key");
  });
});

function digestFixture(version: string, previous: string) {
  return {
    schemaVersion: 1,
    tag: `v${version}`,
    version,
    previousTag: `v${previous}`,
    generatedAt: "2026-07-05T00:00:00.000Z",
    noUserFacingChanges: false,
    summary: { zh: "更新说明更清楚。", en: "Update notes are clearer." },
    counts: { feature: 1, fix: 0, improvement: 0, migration: 0 },
    source: {
      owner: "liliMozi",
      repo: "openhanako",
      commitRange: `v${previous}..v${version}`,
      releaseUrl: `https://github.com/liliMozi/openhanako/releases/tag/v${version}`,
      releaseNotes: "",
    },
    items: [
      {
        id: "digest",
        kind: "feature",
        importance: "high",
        title: { zh: "更新摘要", en: "Update digest" },
        summary: { zh: "About 页展示更新内容。", en: "The About page shows update content." },
        details: [],
        sources: [{ type: "commit", ref: "abc123", title: "Add digest" }],
      },
    ],
  };
}

describe("appendDigestFileToHistoryFile（手写工作流：追加一节进 v2 史册）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-history-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("史册不存在时创建单条 v2 史册", async () => {
    const digestPath = path.join(tmpDir, "release-digest.v1.json");
    const historyPath = path.join(tmpDir, "release-digest.v2.json");
    fs.writeFileSync(digestPath, JSON.stringify(digestFixture("0.425.4", "0.425.3")));

    await appendDigestFileToHistoryFile(digestPath, historyPath);

    const history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    expect(history.schema).toBe(2);
    expect(history.entries.map((entry: { version: string }) => entry.version)).toEqual(["0.425.4"]);
  });

  it("已有史册时新版本插到头部，老 entries 原样保留", async () => {
    const digestPath = path.join(tmpDir, "release-digest.v1.json");
    const historyPath = path.join(tmpDir, "release-digest.v2.json");
    const oldEntry = digestFixture("0.425.3", "0.425.2");
    fs.writeFileSync(historyPath, JSON.stringify({ schema: 2, entries: [oldEntry] }));
    fs.writeFileSync(digestPath, JSON.stringify(digestFixture("0.425.4", "0.425.3")));

    await appendDigestFileToHistoryFile(digestPath, historyPath);

    const history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    expect(history.entries.map((entry: { version: string }) => entry.version)).toEqual(["0.425.4", "0.425.3"]);
    expect(history.entries[1]).toEqual(oldEntry);
  });

  it("同版本重跑覆盖头部条目（幂等修订）", async () => {
    const digestPath = path.join(tmpDir, "release-digest.v1.json");
    const historyPath = path.join(tmpDir, "release-digest.v2.json");
    fs.writeFileSync(historyPath, JSON.stringify({ schema: 2, entries: [digestFixture("0.425.4", "0.425.3")] }));
    const revised = digestFixture("0.425.4", "0.425.3");
    revised.summary = { zh: "修订后的摘要。", en: "Revised summary." };
    fs.writeFileSync(digestPath, JSON.stringify(revised));

    await appendDigestFileToHistoryFile(digestPath, historyPath);

    const history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].summary.en).toBe("Revised summary.");
  });

  it("旧版本拒绝追加（防止倒灌）", async () => {
    const digestPath = path.join(tmpDir, "release-digest.v1.json");
    const historyPath = path.join(tmpDir, "release-digest.v2.json");
    fs.writeFileSync(historyPath, JSON.stringify({ schema: 2, entries: [digestFixture("0.425.4", "0.425.3")] }));
    fs.writeFileSync(digestPath, JSON.stringify(digestFixture("0.425.3", "0.425.2")));

    await expect(appendDigestFileToHistoryFile(digestPath, historyPath)).rejects.toThrow(/older|decreasing|head/i);
  });

  it("parseArgs 支持 --append-history / --history-file", () => {
    const args = parseArgs(["--tag", "v0.425.4", "--append-history", "--history-file", "tmp/history.json"], {});
    expect(args).toEqual(expect.objectContaining({
      appendHistory: true,
      historyFile: "tmp/history.json",
    }));
  });

  it("--append-history 模式不要求 --tag（append 路径不接触 git/LLM）", () => {
    const args = parseArgs(["--append-history"], {});
    expect(args.appendHistory).toBe(true);
    expect(args.historyFile).toBe("release-digest.v2.json");
  });
});
