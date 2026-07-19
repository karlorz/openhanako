# Unified Linux Server Install Design

Status: initial implementation exists in `scripts/install-server.mjs`. The old sg01 SSH deploy helper is retired; this flow is the supported replacement.

## Goal

Provide a direct-on-box Linux installer for the HanaAgent server role. The server host runs the installer locally, pulls a verified tagged release artifact, installs or upgrades the service, and leaves a durable `install-server` command in `PATH` for future operations.

This is not an SSH deploy workflow. SSH can still be used by an operator to reach the box, but the install/upgrade authority is the command running on the Linux host.

## Entry Points

Supported bootstrap forms:

```sh
# Install only the durable /usr/local/bin/install-server command from a ref.
curl -fsSL https://raw.githubusercontent.com/karlorz/openhanako/<ref>/scripts/install-server-bootstrap.sh \
  | sudo bash -s -- --repo karlorz/openhanako --ref <ref> --install-cli-only

# Fresh host install from a pinned fork prerelease tag.
curl -fsSL https://raw.githubusercontent.com/karlorz/openhanako/<tag>/scripts/install-server-bootstrap.sh \
  | sudo bash -s -- --repo karlorz/openhanako --version <tag> --channel prerelease --execute

# Existing host upgrade from a pinned fork prerelease tag.
curl -fsSL https://raw.githubusercontent.com/karlorz/openhanako/<tag>/scripts/install-server-bootstrap.sh \
  | sudo bash -s -- --repo karlorz/openhanako --version <tag> --channel prerelease --upgrade --execute
```

The bootstrap script defaults to `--install-cli-only` behavior unless
`--execute` is passed. It always installs:

- `/opt/hanaagent/install/install-server.mjs`
- `/usr/local/bin/install-server`

When the downloaded `install-server.mjs` imports the shared status/release
modules (current refs), it also installs the same-ref dependency closure under
`/opt/hanaagent/shared/`:

- `/opt/hanaagent/shared/remote-server-assessment.cjs`
- `/opt/hanaagent/shared/remote-server-release-catalog.cjs`
- `/opt/hanaagent/shared/remote-server-release-loader.cjs`
- `/opt/hanaagent/shared/remote-server-policy.json`
- `/opt/hanaagent/shared/remote-feature-contracts.cjs`
- `/opt/hanaagent/shared/remote-feature-contracts.json`

Historical single-file installer refs (for example `v0.357.17-karlorz.1`) do
not import those modules, so the bootstrap skips the shared fetch and remains
installable. Current refs download the installer first, detect the import
markers, stage the complete dependency closure, and replace
`install-server.mjs` only after every required download succeeds, so a failed
dependency fetch cannot leave a newer CLI pointing at missing modules.

It does not run local builds, git resets, SSH deploy commands, or service
mutation unless the operator explicitly passes `--execute`.

Root mode:

- If `id -u` is `0`, privileged steps run directly.
- The bootstrap must not require `sudo` when already root. This matters for minimal Debian/root shells where `sudo` is intentionally absent.

Non-root mode:

- If `id -u` is not `0`, the bootstrap checks `command -v sudo` before doing any privileged work.
- If `sudo` is missing, fail early with a clear message naming root-mode as the supported fallback.
- Privileged commands run through `sudo`; non-privileged validation and downloads run as the invoking user where possible.

## Installed Command

The first install creates:

- `/usr/local/bin/install-server`
- `/opt/hanaagent/install/install-server.mjs`
- `/opt/hanaagent/releases/`
- `/opt/hanaagent/current -> /opt/hanaagent/releases/<version>-<platform>-<arch>/`
- `/var/lib/hanaagent/`
- `/etc/hanaagent/`
- `/etc/systemd/system/hanaagent.service`

`/usr/local/bin/install-server` is a small stable shim that executes the
implementation under `/opt/hanaagent/install/`. Runtime-only `install-server
upgrade` does not replace that implementation. The bootstrap refreshes the CLI
and its same-ref dependency closure before optionally forwarding an attended
`install` or `upgrade --execute`; the shim path remains stable.

Minimum command surface:

```sh
install-server install [--version <tag>] [--channel stable|prerelease]
install-server upgrade [--version <tag>] [--channel stable|prerelease]
install-server status
install-server backup [--output <path>]
```

Reserved future command:

```sh
install-server reinit-data
```

`reinit-data` is intentionally separate from `upgrade` and must require explicit opt-in plus a verified backup before destructive changes. See `docs/reinit-data-failsafe.md` for the failsafe reset/import design.

## Artifact Source

The installer pulls server release artifacts from tagged GitHub releases, not from the local developer checkout.

Required artifact metadata:

- Release tag.
- Platform and architecture (`linux-x64` or `linux-arm64`).
- Artifact URL.
- SHA-256 checksum.
- Build provenance metadata when available.

Rules:

- Stable channel ignores prerelease releases by default.
- Prerelease install or upgrade requires explicit `--channel prerelease`,
  including when pinning an exact fork prerelease tag.
- The downloaded artifact is verified before extraction.
- A checksum mismatch aborts before touching the active service.
- The default GitHub release source for the installer is the fork
  `karlorz/openhanako`. Override only when intentionally testing another repo.

Release asset shape (published by `.github/workflows/build.yml` on every `v*` tag):

Five server-bundle assets, one per target:

- `hanaagent-server-<tag>-linux-arm64.tar.gz`
- `hanaagent-server-<tag>-linux-x64.tar.gz`
- `hanaagent-server-<tag>-mac-arm64.tar.gz`
- `hanaagent-server-<tag>-mac-x64.tar.gz`
- `hanaagent-server-<tag>-win-x64.tar.gz`

Each tarball is produced by `scripts/pack-server-bundle.mjs` from the matching `dist-server/<os>-<arch>/` build output. The asset's sha256 is computed at pack time and published as a same-name `.sha256` sidecar used by `install-server upgrade` to verify the download before extraction. The release verify gate fails the release if any tarball or sidecar is missing.

Fork releases also publish `hanaagent-server-compatibility-TAG.json`. This
manifest binds the exact fork tag and source commit to the complete declared
server feature contracts and to checksum-paired bundle names. It enables
feature-specific upgrade claims; it does not replace the bundle sidecar, and
the installer still verifies the downloaded archive against that sidecar
before activation. `release-digest.v1.json` remains separate Desktop release
notes metadata and is not a server compatibility manifest.

## Staging And Build Space

The supported install and upgrade path is to consume tagged GitHub release
assets. Do not use the Linux host as the normal build machine for releases.

When an attended emergency hotfix must build or pack directly on a small
server, avoid `/tmp` for build output. On sg01, `/tmp` is tmpfs-backed; stale
build and upgrade directories there consumed several GiB of shared memory
during the 2026-07-01 model-removal hotfix validation and made overall memory
usage look high even while CPU was normal. Use a disk-backed directory such as
`/opt/hanaagent/build` for transient build artifacts, and remove it after the
installer has completed.

Before blaming CPU or DNS for a remote server stall, check memory pressure from
tmpfs first:

```sh
df -h /tmp /opt/hanaagent
du -sh /tmp/openhanako-* /tmp/hanaagent-* /opt/hanaagent/build 2>/dev/null
free -h
systemctl status hanaagent --no-pager -l
```

Only remove stale staging directories after confirming no `install-server`,
`npm`, `node`, or tar/extract process is still using them.

## Service Model

The server runs as the `hanaagent` system user and group.

Install behavior:

1. Detect OS and architecture. Support Linux only.
2. Refuse to continue if `/opt/hanaagent/current` already exists; existing
   installs must use `install-server upgrade`.
3. Create the `hanaagent` user/group if missing.
4. Create `/opt/hanaagent`, `/var/lib/hanaagent`, and `/etc/hanaagent`.
5. Download artifact and checksum to a staging directory.
6. Verify checksum.
7. Extract to `/opt/hanaagent/releases/<version>-<platform>-<arch>/`.
8. Write or update `/etc/systemd/system/hanaagent.service`.
9. Switch `/opt/hanaagent/current` atomically.
10. Install or refresh the durable `/usr/local/bin/install-server` shim.
11. Run `systemctl daemon-reload`.
12. Enable and restart `hanaagent`.
13. Run local health verification against the configured bind address.

Expected service defaults:

- Service name: `hanaagent`.
- Runtime user: `hanaagent`.
- State directory: `/var/lib/hanaagent`.
- Config directory: `/etc/hanaagent`.
- Active bundle: `/opt/hanaagent/current`.
- Default bind can remain the existing server default unless `/etc/hanaagent/server-network.json` is present.

Fresh install creates a new data root. It does not import provider, model,
device, LAN, or pairing configuration. To clear an existing data root while
keeping operational provider/model/LAN bootstrap, use `install-server
reinit-data --dry-run` followed by `install-server reinit-data --confirm
<plan-id>`. Passing `--reset-pairing` to `reinit-data` is the explicit
full-clear mode and does not preserve provider or device bootstrap data.

## Upgrade Behavior

`install-server upgrade` never deletes the current release before the new one is verified.

Resolution — `--metadata` is optional. When omitted, `upgrade` resolves the
target from the GitHub releases API:

```sh
# latest stable (auto-resolved from karlorz/openhanako)
node scripts/install-server.mjs upgrade --current-version v0.346.18-karlorz.6 --dry-run
# pinned fork release tag
node scripts/install-server.mjs upgrade --version v0.407.15-karlorz.6 --channel prerelease --current-version v0.346.18-karlorz.6 --dry-run
# apply
node scripts/install-server.mjs upgrade --version v0.407.15-karlorz.6 --channel prerelease --current-version v0.346.18-karlorz.6 --execute
# explicit metadata still accepted (skips the GitHub fetch)
node scripts/install-server.mjs upgrade --metadata release.json --current-version v0.346.18-karlorz.6 --execute
```

`--current-version` is required unless `/opt/hanaagent/current` resolves a
release name (then it is inferred). Resolution refuses prereleases unless
`--channel prerelease` is given. GitHub
Releases does not expose asset sha256, so the download step fetches the
`<asset>.sha256` sidecar published alongside each server bundle and verifies
the archive against it before extraction.

Current verified pinned example: `v0.407.15-karlorz.6` was published by
GitHub Actions run `29688911528` as a `legacy-raw` prerelease with 20 audited
assets: independently installable desktop packages, five standalone server
bundles with SHA-256 sidecars, the compatibility manifest, the immutable
release-profile marker, and `release-digest.v1.json`. It intentionally has no
updater metadata or signed-only train/mirror assets. The workflow publishes
fork tags as prereleases by default, so unattended "latest stable" resolution
may skip that tag; use `--version v0.407.15-karlorz.6 --channel prerelease` to
pin it.

The immutable `.6` tag predates the dependency-complete bootstrap revision.
During the `.6` sg01 closeout, the reviewed post-release bootstrap was staged
temporarily while still fetching `install-server.mjs` and all six shared
dependencies from the exact `.6` tag. The corrected bootstrap now lives on
`dev`, detects whether a ref's installer needs the shared modules, and must be
included in the next fork tag; do not move or rewrite `.6`.

The historical `v0.357.17-karlorz.1` install path did not require the newer
Hana Ed25519 seed key: its server archive was a standalone runtime verified by
its SHA-256 sidecar, while the local macOS install copied the app and ran the
recursive ad-hoc `scripts/sign-local.cjs` fallback. Those are separate from
Apple Developer ID credentials and from release-digest API keys. The current
legacy-raw profile preserves that installability explicitly: the complete
`HanaAgent.app` is ad-hoc signed and resource-sealed, while its DMG and ZIP
containers remain unsigned and unnotarized when Apple credentials are absent.

When upgrading a host with an existing `hanaagent.service`, the executable
upgrade preserves the unit's `User=`, `Group=`, and `HANA_*` environment
settings while migrating `WorkingDirectory=` and `ExecStart=` to the stable
`/opt/hanaagent/current` symlink. This keeps older sg01-style installs on
their existing `HANA_HOME` data root while moving the runtime to verified
release assets.

The installer also carries through non-managed directives from the prior unit
so an operator's hardening and logging configuration is not silently dropped
on upgrade. Preserved `[Unit]` directives include `Documentation=`; preserved
`[Service]` directives include `TimeoutStopSec=`, `StandardOutput=`,
`StandardError=`, `SyslogIdentifier=`, `PrivateTmp=`, `ProtectSystem=`,
`ProtectHome=`, `NoNewPrivileges=`, capability/system-call limits, and a
prior custom `RestartSec=` (which wins over the installer's default of `3`).
The installer owns and rewrites `Type=`, `User=`, `Group=`, `WorkingDirectory=`,
`ExecStart=`, `Environment=`, `Restart=`, `Description=`, `After=`, `Wants=`,
and `WantedBy=`; everything else in the prior unit is preserved verbatim.

For local/explicit metadata, the release metadata file has this shape:

```json
{
  "tag": "v0.400.0",
  "prerelease": false,
  "assets": [
    {
      "platform": "linux",
      "arch": "arm64",
      "name": "hanaagent-server-v0.400.0-linux-arm64.tar.gz",
      "url": "https://example.test/hanaagent-server-v0.400.0-linux-arm64.tar.gz",
      "sha256": "64_hex_chars"
    }
  ]
}
```

`--dry-run` is non-mutating and prints the plan. `--execute` is host-mutating and is intended to be run only on the target Linux server after release assets and checksums exist.

Fresh install resolution uses the same GitHub release API path as upgrade:

```sh
# latest stable from karlorz/openhanako
install-server install --dry-run
# pinned fork prerelease tag
install-server install --version v0.407.15-karlorz.6 --channel prerelease --dry-run
# apply on a fresh host
install-server install --version v0.407.15-karlorz.6 --channel prerelease --execute
```

Upgrade sequence:

1. Resolve target version from an explicit `--version` or latest stable release.
2. Refuse prerelease unless explicitly requested.
3. Run `install-server backup`.
4. Download and verify the new artifact in staging.
5. Extract into a new release directory.
6. Stop or restart the service only after extraction succeeds.
7. Switch the `current` symlink atomically.
8. Write or update the systemd unit to run from `current`.
9. Restart service and verify health.
10. If health verification fails, switch `current` back to the previous release and restart.
11. Keep failed release artifacts for inspection unless `--cleanup` is explicitly provided.

## Backup Behavior

`install-server backup` creates a timestamped archive containing:

- `/etc/hanaagent/`
- `/var/lib/hanaagent/`
- Current release metadata.
- `systemctl cat hanaagent` output when systemd is available.

The command prints the backup path and exits nonzero if the archive cannot be verified after writing.

## Status Behavior

`install-server status` reports:

- The `current` symlink target and resolved release path.
- The exact installed fork tag when the release directory matches
  `vMAJOR.MINOR.PATCH-karlorz.REVISION-linux-ARCH`.
- Structured absent and broken-link states instead of throwing.
- Service enabled/active state and main PID when systemd is available.
- A read-only server assessment that keeps core readiness, release freshness,
  feature support, and host deployability as separate evidence.

Status is read-only and does not require root or sudo. Plain status performs no
network request:

```bash
install-server status --json
```

If an older durable CLI rejects `--json` or `--check-updates`, refresh it with
the first tag- or commit-pinned `--install-cli-only` bootstrap form in this
document before using status. A direct runtime upgrade does not self-update the
durable CLI.

To explicitly check the fork's published server releases and include update
evidence, use:

```bash
install-server status --check-updates --json
```

The update check does not download, install, restart, or change the service. If
the release directory and optional embedded `server-build-info.json` disagree, the report adds
`installed_release_evidence_mismatch` instead of guessing which identity is
current.

## Desktop Remote Smoke Gates

The desktop smoke helper can require one or more explicit server contracts and
write short-lived evidence:

```bash
node scripts/hana-desktop-smoke-helper.mjs --restart --verify \
  --url http://100.125.173.118:14500 \
  --require-contract input.drafts@1 \
  --assessment-out .claude/remote-assessment/latest.json
```

`--require-contract NAME@VERSION` is repeatable. Names are lowercase dotted
identifiers and versions are positive integers. A complete server declaration
at or above the requested version is `satisfied`; a lower or missing entry in
a complete declaration is `missing`; an incomplete or legacy declaration is
`unconfirmed`. A valid future compatibility manifest produces
`deployment-coupled` evidence only. Release freshness never substitutes for a
contract declaration.

Exit `3` means functional identity/WebSocket verification passed but an
explicit prerequisite is missing, unconfirmed, or deployment-coupled.
Functional failure retains exit `1`. With no explicit requirements,
environment attention remains non-fatal and a functional pass exits `0`. The
top-level `ok` field remains an alias for functional status.

Evidence defaults to `.claude/remote-assessment/latest.json`. The helper creates
parent directories and writes the file atomically with mode `0600`; evidence
expires after 30 minutes. The schema excludes URLs, tokens, credentials,
authorization/cookie/header data, CDP endpoints, user-data paths, and raw
localStorage. `websocket.ticket@1` is migration-readiness evidence, not a
generic LAN core requirement.

Repository work items can consume that short-lived evidence with the offline
prerequisite checker. An attended operator sets `WORK_ITEM_SPEC` to the
candidate spec's absolute path, refreshes the evidence deliberately, and runs:

```bash
node scripts/check-remote-prerequisites.mjs \
  --work-item "$WORK_ITEM_SPEC" \
  --assessment .claude/remote-assessment/latest.json \
  --json
```

The checker reports `unknown` when the assessment is absent, invalid, or stale.
It only reads the two supplied files and must not obtain credentials, inspect
renderer/localStorage state, use SSH, or contact sg01 merely because prep runs.
Generic `/dev-loop prep` does not call it. Automatic prep integration requires
a separate dev-loop plugin source change and release, never an installed-cache
patch. For `deployment-coupled` work, plan client, server, release, upgrade,
and post-upgrade verification as explicit stages; future manifest evidence is
not proof that the current host asset is installed.

## Failure Policy

- Unsupported OS or architecture: fail before download.
- Non-root without sudo: fail before download.
- Missing systemd: fail unless a future non-systemd mode is explicitly designed.
- Checksum mismatch: fail before extraction.
- Health check failure after upgrade: rollback to previous `current` release.
- Backup failure before upgrade: abort upgrade.
- Existing local config is preserved by default.

## Implementation Prerequisites

Before implementation starts:

- CI must publish Linux server artifacts and checksums for `linux-x64` and `linux-arm64`.
- The release metadata format must be documented.
- The service health endpoint and default local verification command must be fixed in tests.
- The reinit-data failsafe design must stay separate from install/upgrade so
  provider preservation remains an explicit data operation.

## Test Plan For Implementation

- Unit-test privilege detection for root, non-root with sudo, and non-root without sudo.
- Unit-test stable/prerelease release selection.
- Unit-test checksum mismatch aborts before extraction or service changes.
- Unit-test upgrade rollback when health verification fails.
- Unit-test generated systemd unit content.
- Unit-test durable `/usr/local/bin/install-server` shim installation.
- Unit-test bootstrap script root/non-root/sudo behavior, conditional same-ref
  status dependency closure detection, and shell lint where available.
- Integration-test install/upgrade in a disposable Linux container or VM.
- Verify that the old sg01 SSH deploy helper is not invoked by the new flow.
