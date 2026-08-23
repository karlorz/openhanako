#!/usr/bin/env sh
set -eu

REPO="${REPO:-karlorz/openhanako}"
VERSION="${INSTALL_SERVER_VERSION:-}"
CHANNEL="${INSTALL_SERVER_CHANNEL:-}"
REF="${INSTALL_SERVER_REF:-}"
MODE="install"
EXECUTE=0
INSTALL_CLI_ONLY=0

usage() {
  cat <<'EOF'
install-server-bootstrap.sh - bootstrap HanaAgent Linux server installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/karlorz/openhanako/<ref>/scripts/install-server-bootstrap.sh | bash -s -- [options]

Options:
  --repo <owner/repo>        GitHub repository for raw installer source (default: karlorz/openhanako)
  --ref <git-ref>           Git ref for scripts/install-server.mjs (default: --version, INSTALL_SERVER_REF, then dev)
  --version <tag>           Release tag passed to install-server install/upgrade
  --channel <channel>       stable or prerelease, forwarded to install-server
  --upgrade                 Run install-server upgrade when --execute is present
  --install-cli-only        Install /usr/local/bin/install-server only, do not run install/upgrade
  --execute                 After CLI bootstrap, execute install or upgrade
  -h, --help                Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:?--repo requires a value}"
      shift 2
      ;;
    --ref)
      REF="${2:?--ref requires a value}"
      shift 2
      ;;
    --version)
      VERSION="${2:?--version requires a value}"
      shift 2
      ;;
    --channel)
      CHANNEL="${2:?--channel requires a value}"
      shift 2
      ;;
    --upgrade)
      MODE="upgrade"
      shift
      ;;
    --install-cli-only)
      INSTALL_CLI_ONLY=1
      shift
      ;;
    --execute)
      EXECUTE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$REF" ]; then
  if [ -n "$VERSION" ]; then
    REF="$VERSION"
  else
    REF="dev"
  fi
fi

if [ "$(id -u)" = "0" ]; then
  as_root() {
    "$@"
  }
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required for non-root bootstrap. Re-run as root or install sudo first." >&2
    exit 1
  fi
  as_root() {
    sudo "$@"
  }
fi

command -v node >/dev/null 2>&1 || {
  echo "node is required before bootstrapping install-server." >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "curl is required before bootstrapping install-server." >&2
  exit 1
}

INSTALL_ROOT="/opt/hanaagent"
INSTALL_IMPL="/opt/hanaagent/install/install-server.mjs"
INSTALL_BIN="/usr/local/bin/install-server"
RAW_BASE_URL="https://raw.githubusercontent.com/${REPO}/${REF}"
RAW_URL="${RAW_BASE_URL}/scripts/install-server.mjs"
SHARED_ROOT="/opt/hanaagent/shared"
SHARED_FILES="
remote-server-assessment.cjs
remote-server-release-catalog.cjs
remote-server-release-loader.cjs
remote-server-policy.json
remote-feature-contracts.cjs
remote-feature-contracts.json
"
TMP_DIR="$(mktemp -d /tmp/hanaagent-install-bootstrap.XXXXXX)"
INSTALLER_TMP="${TMP_DIR}/install-server.mjs"
SHARED_TMP_DIR="${TMP_DIR}/shared"
SHIM_TMP="${TMP_DIR}/install-server"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

# Download the installer first, then only fetch the shared status/release
# modules when this ref's install-server.mjs actually imports them. Historical
# tags (e.g. v0.357.17-karlorz.1) are single-file and must remain bootstrappable.
curl -fsSL "$RAW_URL" -o "$INSTALLER_TMP"

NEEDS_STATUS_DEPENDENCIES=0
if grep -Eq '\.\./shared/(remote-server-|remote-feature-contracts)' "$INSTALLER_TMP"; then
  NEEDS_STATUS_DEPENDENCIES=1
fi

if [ "$NEEDS_STATUS_DEPENDENCIES" = "1" ]; then
  mkdir -p "$SHARED_TMP_DIR"
  for file in $SHARED_FILES; do
    curl -fsSL "${RAW_BASE_URL}/shared/${file}" -o "${SHARED_TMP_DIR}/${file}"
  done
fi

cat > "$SHIM_TMP" <<EOF
#!/usr/bin/env sh
set -eu
exec node "$INSTALL_IMPL" "\$@"
EOF

if [ "$NEEDS_STATUS_DEPENDENCIES" = "1" ]; then
  as_root mkdir -p "$(dirname "$INSTALL_IMPL")" "$(dirname "$INSTALL_BIN")" "$INSTALL_ROOT" "$SHARED_ROOT"
  for file in $SHARED_FILES; do
    as_root cp "${SHARED_TMP_DIR}/${file}" "${SHARED_ROOT}/${file}"
    as_root chmod 0644 "${SHARED_ROOT}/${file}"
  done
else
  as_root mkdir -p "$(dirname "$INSTALL_IMPL")" "$(dirname "$INSTALL_BIN")" "$INSTALL_ROOT"
fi
# Install the implementation last so a failed dependency download never leaves
# a new CLI pointing at an incomplete dependency set.
as_root cp "$INSTALLER_TMP" "$INSTALL_IMPL"
as_root chmod 0755 "$INSTALL_IMPL"
as_root cp "$SHIM_TMP" "$INSTALL_BIN"
as_root chmod 0755 "$INSTALL_BIN"

if [ "$NEEDS_STATUS_DEPENDENCIES" = "1" ]; then
  echo "Installed install-server and status dependencies from ${REPO}@${REF} to ${INSTALL_BIN}"
else
  echo "Installed install-server from ${REPO}@${REF} to ${INSTALL_BIN}"
fi

if [ "$INSTALL_CLI_ONLY" = "1" ] || [ "$EXECUTE" != "1" ]; then
  echo "CLI bootstrap complete. Run install-server install or install-server upgrade explicitly when ready."
  exit 0
fi

INSTALL_ARGS=""
if [ -n "$VERSION" ]; then
  INSTALL_ARGS="${INSTALL_ARGS} --version ${VERSION}"
fi
if [ -n "$CHANNEL" ]; then
  INSTALL_ARGS="${INSTALL_ARGS} --channel ${CHANNEL}"
fi

# shellcheck disable=SC2086
exec "$INSTALL_BIN" "$MODE" $INSTALL_ARGS --execute
