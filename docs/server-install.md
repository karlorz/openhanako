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
`--execute` is passed. It installs:

- `/opt/hanaagent/install/install-server.mjs`
- `/usr/local/bin/install-server`

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

`/usr/local/bin/install-server` should be a small stable shim that executes the versioned implementation under `/opt/hanaagent/install/`. Upgrading HanaAgent may replace the implementation, but the shim path remains stable.

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
node scripts/install-server.mjs upgrade --current-version v0.345.3-karlorz.3 --dry-run
# pinned fork release tag
node scripts/install-server.mjs upgrade --version v0.346.18-karlorz.1 --current-version v0.345.3-karlorz.3 --dry-run
# apply
node scripts/install-server.mjs upgrade --version v0.346.18-karlorz.1 --current-version v0.345.3-karlorz.3 --execute
# explicit metadata still accepted (skips the GitHub fetch)
node scripts/install-server.mjs upgrade --metadata release.json --current-version v0.345.3-karlorz.3 --execute
```

`--current-version` is required unless `/opt/hanaagent/current` resolves a
release name (then it is inferred). Resolution refuses prereleases unless
`--channel prerelease` is given. GitHub
Releases does not expose asset sha256, so the download step fetches the
`<asset>.sha256` sidecar published alongside each server bundle and verifies
the archive against it before extraction.

Current verified pinned example: `v0.346.18-karlorz.1` was published by
GitHub Actions run `28293195697` with all required desktop installers,
update metadata, and server bundles. The workflow publishes fork tags as
prereleases by default, so unattended "latest stable" resolution may skip that
tag until an operator explicitly promotes it; use `--version` to pin it.

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
install-server install --version v0.346.18-karlorz.1 --channel prerelease --dry-run
# apply on a fresh host
install-server install --version v0.346.18-karlorz.1 --channel prerelease --execute
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

- Installed version and release path.
- Service enabled/active state.
- Listening address/port if known.
- Last backup path if known.
- Current channel policy.
- Whether the running binary matches the `current` symlink target.

Status must be read-only.

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
- Unit-test bootstrap script root/non-root/sudo behavior by static contract and shell lint where available.
- Integration-test install/upgrade in a disposable Linux container or VM.
- Verify that the old sg01 SSH deploy helper is not invoked by the new flow.
