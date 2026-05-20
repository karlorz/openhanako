import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import {
  collectWin32LegacySandboxMigrationTargets,
  runWin32LegacySandboxMigration,
} from "../lib/sandbox/win32-legacy-migration.js";

function dirent(name, directory = true) {
  return {
    name,
    isDirectory: () => directory,
  };
}

function fakeSpawnFactory({ code = 0, stdout = "", stderr = "" } = {}) {
  return vi.fn((_file, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  });
}

describe("Windows legacy sandbox migration", () => {
  it("collects old ACL roots and stale Hana AppContainer profile names", () => {
    const existing = new Set([
      "C:\\",
      "D:\\",
      "C:\\Users\\Hana",
      "C:\\Users\\Hana\\.hanako",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "C:\\Users\\Hana\\.hanako\\agents",
      "C:\\Users\\Hana\\.hanako\\session-files",
      "C:\\Users\\Hana\\.hanako\\uploads",
      "C:\\Program Files\\Hanako\\resources",
      "C:\\Program Files\\Hanako\\resources\\git",
      "D:\\workspace",
      "C:\\Users\\Hana\\AppData\\Local\\Packages",
    ]);
    const readdirSync = vi.fn((target) => {
      if (target === "C:\\Users\\Hana\\AppData\\Local\\Packages") {
        return [
          dirent("com.hanako.sandbox.1288.475900"),
          dirent("Microsoft.WindowsCalculator_8wekyb3d8bbwe"),
          dirent("com.hanako.sandbox.5104.475988"),
          dirent("com.hanako.sandbox.file", false),
        ];
      }
      return [];
    });

    const targets = collectWin32LegacySandboxMigrationTargets({
      platform: "win32",
      hanakoHome: "C:\\Users\\Hana\\.hanako",
      workspaceRoots: ["D:\\workspace"],
      env: {
        USERPROFILE: "C:\\Users\\Hana",
        LOCALAPPDATA: "C:\\Users\\Hana\\AppData\\Local",
        SystemDrive: "C:",
        HOMEDRIVE: "D:",
      },
      resourcesPath: "C:\\Program Files\\Hanako\\resources",
      existsSync: (target) => existing.has(target),
      readdirSync,
      homedir: () => "C:\\Users\\Hana",
    });

    expect(targets.aclPaths).toEqual([
      "C:\\Users\\Hana\\.hanako",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "C:\\Users\\Hana\\.hanako\\agents",
      "C:\\Users\\Hana\\.hanako\\session-files",
      "C:\\Users\\Hana\\.hanako\\uploads",
      "D:\\workspace",
      "C:\\Program Files\\Hanako\\resources",
      "C:\\Program Files\\Hanako\\resources\\git",
      "C:\\Users\\Hana",
      "C:\\",
      "D:\\",
    ]);
    expect(targets.profileNames).toEqual([
      "com.hanako.sandbox.1288.475900",
      "com.hanako.sandbox.5104.475988",
    ]);
  });

  it("runs cleanup through the helper and treats ACL findings as a diagnostic result", async () => {
    const spawn = fakeSpawnFactory({
      code: 3,
      stderr: "hana-win-sandbox: legacy-appcontainer-acl path=\"C:\\\\\" sid=\"S-1-15-2-1\"",
    });

    const result = await runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      targets: {
        aclPaths: ["C:\\"],
        profileNames: ["com.hanako.sandbox.1288.475900"],
      },
      spawn,
    });

    expect(result.status).toBe("findings");
    expect(result.cleanup).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Hanako\\hana-win-sandbox.exe",
      [
        "--legacy-appcontainer-profile",
        "com.hanako.sandbox.1288.475900",
        "--cleanup-legacy-acl",
        "--diagnose-legacy-acl",
        "C:\\",
        "--cleanup-legacy-profile",
        "com.hanako.sandbox.1288.475900",
      ],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it("skips cleanly on non-Windows and when the packaged helper is absent", async () => {
    await expect(runWin32LegacySandboxMigration({ platform: "darwin" }))
      .resolves.toMatchObject({ status: "skipped", reason: "platform" });

    await expect(runWin32LegacySandboxMigration({
      platform: "win32",
      resolveHelper: () => null,
    })).resolves.toMatchObject({ status: "skipped", reason: "helper-unavailable" });
  });
});
