import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const rootDir = process.cwd();
const workflowPath = path.join(rootDir, ".github", "workflows", "build.yml");

function readWorkflow() {
  return fs.readFileSync(workflowPath, "utf8");
}

function section(source, heading) {
  const start = source.indexOf(`      - name: ${heading}`);
  if (start < 0) return "";
  const next = source.indexOf("\n      - name: ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function job(source, name) {
  const start = source.indexOf(`  ${name}:`);
  if (start < 0) return "";
  const tail = source.slice(start + 1);
  const nextJob = tail.match(/\n  \S[^\n]*:/);
  const end = nextJob?.index == null ? source.length : start + 1 + nextJob.index;
  return source.slice(start, end);
}

describe("legacy-raw release workflow contract", () => {
  it("serializes release runs for the same ref without cancelling the earlier guard", () => {
    const workflow = readWorkflow();

    expect(workflow).toMatch(/concurrency:\s*\n\s+group:\s*\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}/);
    expect(workflow).toMatch(/concurrency:[\s\S]{0,180}cancel-in-progress:\s*false/);
  });

  it("uses automatic raw fallback for tag pushes", () => {
    const workflow = readWorkflow();

    expect(workflow).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+release_profile:/);
    expect(workflow).toMatch(/release_profile:[\s\S]{0,300}default:\s*auto/);
    expect(workflow).toMatch(/release_profile:[\s\S]{0,500}options:[\s\S]{0,120}auto[\s\S]{0,160}signed[\s\S]{0,160}legacy-raw/);
    expect(workflow).toContain("resolve-release-profile");
    expect(workflow).toContain("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && 'auto'");
    expect(workflow).not.toContain("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && 'signed'");
    expect(job(workflow, "resolve-release-profile")).toContain("HANA_SIGN_KEY_PEM");
  });

  it("guards an existing release profile before creating or uploading assets", () => {
    const release = job(readWorkflow(), "release");
    const guardIndex = release.indexOf("Guard immutable release profile");
    const createIndex = release.indexOf("Create draft release");
    const uploadIndex = release.indexOf("gh release upload");

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(createIndex);
    expect(guardIndex).toBeLessThan(uploadIndex);
    expect(release).toContain("scripts/guard-release-profile.mjs");
    expect(release).toContain("hana-release-profile-$HANA_RELEASE_PROFILE.json");
  });

  it("resolves the profile once and propagates only a concrete output", () => {
    const workflow = readWorkflow();
    const resolver = job(workflow, "resolve-release-profile");
    expect(resolver).toContain("HANA_SIGN_KEY_PEM");
    expect(resolver).toContain("scripts/resolve-release-profile.mjs");
    expect(resolver).toContain("GITHUB_OUTPUT");
    expect(workflow).toContain("needs: resolve-release-profile");
    expect(workflow).toContain("needs.resolve-release-profile.outputs.release_profile");
    expect(workflow).not.toContain("HANA_RELEASE_PROFILE: ${{ github.event_name == 'push'");
    for (const name of ["renderer-box", "build", "server-bundles", "release", "publish-train", "mirror-atomgit"]) {
      expect(job(workflow, name)).toContain("resolve-release-profile");
    }
  });

  it("lets a manual raw build skip signed-only renderer preparation without skipping the build", () => {
    const workflow = readWorkflow();
    const renderer = job(workflow, "renderer-box");
    const build = job(workflow, "build");

    expect(renderer).toContain("needs.resolve-release-profile.outputs.release_profile == 'signed'");
    expect(build).toContain("always()");
    expect(build).toContain("needs.renderer-box.result");
    expect(build).toContain("legacy-raw");
  });

  it("lets a raw release continue past the intentionally skipped renderer job", () => {
    const workflow = YAML.parse(readWorkflow());
    const condition = workflow.jobs.release.if.replace(/\s+/g, " ").trim();

    expect(condition).toBe(
      "always() && !cancelled() && startsWith(github.ref, 'refs/tags/v') && " +
      "needs.resolve-release-profile.result == 'success' && " +
      "needs.build.result == 'success' && " +
      "needs.server-bundles.result == 'success'",
    );
  });

  it("materializes signing material and shared renderer inputs only for signed packages", () => {
    const workflow = readWorkflow();
    const signing = section(workflow, "Materialize seed signing key");
    const rendererDownload = section(workflow, "Download shared renderer box");
    const rendererPointer = section(workflow, "Point seed packer at the shared renderer box");

    for (const block of [signing, rendererDownload, rendererPointer]) {
      expect(block).toContain("if: env.HANA_RELEASE_PROFILE == 'signed'");
    }
    expect(signing).toContain("HANA_SIGN_KEY");
    expect(signing).toContain("HANA_SIGN_KEY_PEM");
  });

  it("builds standalone server bundles in runtime-only mode", () => {
    const workflow = readWorkflow();
    const bundles = job(workflow, "server-bundles");

    expect(bundles).toContain("HANA_SERVER_BUILD_MODE: runtime-only");
    expect(bundles).toContain("HANA_RELEASE_PROFILE");
  });

  it("passes the profile-aware Electron Builder config to every direct builder invocation", () => {
    const workflow = readWorkflow();
    const builderLines = workflow
      .split("\n")
      .filter((line) => line.includes("npx electron-builder"));

    expect(builderLines.length).toBeGreaterThan(0);
    expect(builderLines.every((line) => line.includes("--config scripts/electron-builder.config.cjs"))).toBe(true);
  });

  it("signs and startup-smokes the unpacked raw macOS runtime before packaging", () => {
    const workflow = readWorkflow();
    const signing = section(workflow, "Sign legacy raw macOS server runtime");
    const packageIndex = workflow.indexOf("npx electron-builder --mac");

    expect(signing).toContain("env.HANA_RELEASE_PROFILE == 'legacy-raw'");
    expect(signing).toContain("signAndSmokeTestServerRuntime");
    expect(workflow.indexOf("signAndSmokeTestServerRuntime")).toBeLessThan(packageIndex);
  });

  it("ad-hoc signs and strictly verifies macOS app bundles when Developer ID credentials are absent", () => {
    const workflow = readWorkflow();
    const signingSetup = section(workflow, "Setup macOS signing keychain");
    const macBuild = section(workflow, "Build macOS (DMG + ZIP)");
    const verification = section(workflow, "Verify macOS app bundle signatures");
    const signedUpload = section(workflow, "Upload signed build artifacts");
    const rawUpload = section(workflow, "Upload legacy raw build artifacts");

    expect(signingSetup).toContain("SKIP_NOTARIZE=true");
    expect(macBuild).toContain("-c.mac.identity=-");
    expect(macBuild).not.toContain("-c.mac.identity=null");
    expect(macBuild).toContain("-c.mac.hardenedRuntime=false");
    expect(verification).toContain("if: runner.os == 'macOS'");
    expect(verification).toContain("codesign --verify --deep --strict");
    expect(workflow.indexOf("Verify macOS app bundle signatures")).toBeGreaterThan(
      workflow.indexOf("Build macOS (DMG + ZIP)"),
    );
    for (const uploadHeading of ["Upload signed build artifacts", "Upload legacy raw build artifacts"]) {
      expect(workflow.indexOf("Verify macOS app bundle signatures")).toBeLessThan(
        workflow.indexOf(uploadHeading),
      );
    }
    expect(signedUpload).not.toBe("");
    expect(rawUpload).not.toBe("");
  });

  it("keeps signed-only train and AtomGit jobs out of raw releases", () => {
    const workflow = readWorkflow();

    for (const name of ["publish-train", "mirror-atomgit"]) {
      const block = job(workflow, name);
      expect(block).toContain("needs.resolve-release-profile.outputs.release_profile == 'signed'");
    }
  });

  it("has profile-specific artifact upload surfaces", () => {
    const workflow = readWorkflow();
    const signed = section(workflow, "Upload signed artifacts");
    const raw = section(workflow, "Upload legacy raw artifacts");

    expect(signed).toContain("if: env.HANA_RELEASE_PROFILE == 'signed'");
    expect(signed).toContain("latest");
    expect(signed).toContain("dist-server-artifact");
    expect(signed).toContain("renderer-*.tar.gz");

    expect(raw).toContain("if: env.HANA_RELEASE_PROFILE == 'legacy-raw'");
    expect(raw).toContain("hanaagent-server-*.tar.gz");
    expect(raw).toContain(".sha256");
    expect(raw).toContain("hanaagent-server-compatibility");
    expect(raw).toContain("release-digest.v1.json");
    expect(raw).not.toMatch(/latest(?:-mac|-linux)?\.yml|latest\*|hot-update|renderer-\*\.tar\.gz|seed-train/);
  });

  it("gates release verification by profile and always preserves the committed digest", () => {
    const workflow = readWorkflow();
    const verification = section(workflow, "Verify release assets");

    expect(verification).toContain("HANA_RELEASE_PROFILE");
    expect(verification).toContain("legacy-raw");
    expect(verification).toContain("signed");
    expect(verification).toContain("release profile marker");
    expect(verification).toContain("signed release contains legacy-raw installer assets");
    expect(verification).toContain("legacy-raw release contains signed installer assets");
    expect(verification).toContain("release-digest.v1.json");
    expect(workflow).toContain("Validate committed release digest");
    expect(workflow).toContain("gh release upload \"${{ github.ref_name }}\" release-digest.v1.json");
  });
});
