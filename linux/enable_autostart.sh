#!/usr/bin/env bash
# One-command install and autostart for the local Monico stack.
#
#   bash linux/enable_autostart.sh
#
# That single command:
#   1. detects (or creates) private storage, reusing any previous selection
#   2. installs the FastMCP runtime dependency into monico-mail-usb/.venv
#   3. starts the phone dashboard (127.0.0.1:8765) and mail MCP (127.0.0.1:8787)
#   4. installs a systemd --user watchdog unit that restarts both services and
#      starts them with your session, enabling lingering for boot start
#
# Everything is idempotent: run it again after a reboot, an update or a crash.
# Options exist only for non-default choices; see --help.
#
# Autostart pins the storage directory it selected and never re-runs USB
# discovery, so a detached drive fails closed instead of silently creating a
# second identity store. Public HTTPS for the browser gateway is still an
# explicit opt-in (BOTH --public-ip and --allow-public). This supervises LOCAL
# services only: it does not enable public SMTP/IMAP, DNS/MX records, carrier
# calls/SMS, or outside-network reachability.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_PATH" ]]; then
  ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
else
  # Pasted straight into a shell: the repository must be the current directory.
  ROOT="$PWD"
  if [[ ! -f "$ROOT/start.sh" || ! -d "$ROOT/linux" ]]; then
    printf 'Monico autostart: run this from the cloned agent-mail-service directory, or as bash linux/enable_autostart.sh\n' >&2
    exit 1
  fi
fi
UNIT_NAME="monico-agent.service"
MARKER="# Managed by linux/enable_autostart.sh"
WATCHDOG="$ROOT/linux/watchdog.py"
LAUNCHER="$ROOT/start.sh"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PYTHON="$(command -v python3 || true)"
LOGIN_USER="$(id -un)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/monico-autostart.XXXXXX")"
trap 'rm -f "$LOG_FILE"' EXIT

STATE_DIR=""
DOMAIN=""
FREE_DOMAIN=0
TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/monico/duckdns.token"
INTERVAL=60
PUBLIC_IP=""
ALLOW_PUBLIC=0
MODE="install"
FORCE=0

usage() {
  cat <<'EOF'
Usage: bash linux/enable_autostart.sh [options]

Run without options for a complete install: storage, dependencies, both local
services, and a systemd --user watchdog that restarts them and starts at boot.

  --state-dir DIR   Pin private storage instead of auto-detecting it
  --domain DOMAIN   First-run mailbox domain (default mail.example.invalid)
  --free-domain     Claim a free DuckDNS subdomain when no domain is set
  --interval SEC    Watchdog check interval, 10-3600 seconds (default 60)
  --public-ip IP    Public IPv4 for the HTTPS browser gateway (opt-in)
  --allow-public    Required together with --public-ip
  --print           Show the unit for existing storage; change nothing
  --status          Show unit file, enablement and lingering state
  --uninstall       Disable, stop and remove the unit this script installed
  --force           Replace a unit file that this script did not create
  -h, --help        Show this help

Run as your normal Linux user. Running it with sudo is corrected automatically,
and a root shell with no user is refused.
EOF
}

die() {
  printf 'Monico autostart: %s\n' "$1" >&2
  exit 1
}

# A user service must belong to the human user, not to root's manager.
if [[ "$(id -u)" -eq 0 ]]; then
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" && -n "$SCRIPT_PATH" ]]; then
    exec sudo -u "$SUDO_USER" -H \
      env XDG_RUNTIME_DIR="/run/user/$(id -u "$SUDO_USER")" \
      bash "$SCRIPT_PATH" "$@"
  fi
  printf 'Monico autostart: run as your normal Linux user, not root\n' >&2
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir)
      [[ $# -ge 2 ]] || die "--state-dir needs a directory"
      STATE_DIR="$2"; shift 2 ;;
    --domain)
      [[ $# -ge 2 ]] || die "--domain needs a domain name"
      DOMAIN="$2"; shift 2 ;;
    --free-domain)
      FREE_DOMAIN=1; shift ;;
    --interval)
      [[ $# -ge 2 ]] || die "--interval needs a number of seconds"
      INTERVAL="$2"; shift 2 ;;
    --public-ip)
      [[ $# -ge 2 ]] || die "--public-ip needs an address"
      PUBLIC_IP="$2"; shift 2 ;;
    --allow-public)
      ALLOW_PUBLIC=1; shift ;;
    --print)
      MODE="print"; shift ;;
    --status)
      MODE="status"; shift ;;
    --uninstall)
      MODE="uninstall"; shift ;;
    --force)
      FORCE=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      usage >&2; die "unknown option: $1" ;;
  esac
done

validate_interval() {
  [[ "$INTERVAL" =~ ^[0-9]+$ ]] || die "--interval must be a whole number of seconds"
  (( INTERVAL >= 10 && INTERVAL <= 3600 )) || die "--interval must be between 10 and 3600 seconds"
}

validate_public() {
  if [[ -n "$PUBLIC_IP" && "$ALLOW_PUBLIC" -ne 1 ]] \
     || [[ -z "$PUBLIC_IP" && "$ALLOW_PUBLIC" -eq 1 ]]; then
    die "public HTTPS autostart requires BOTH --public-ip and --allow-public"
  fi
  if [[ -n "$PUBLIC_IP" && ! "$PUBLIC_IP" =~ ^[0-9a-fA-F:.]+$ ]]; then
    die "--public-ip must be a plain IP address, not '$PUBLIC_IP'"
  fi
}

saved_storage() {
  local marker="$HOME/.config/agent-comms/storage.json"
  [[ -f "$marker" ]] || return 1
  "$PYTHON" - "$marker" <<'PY'
import json
import sys
try:
    print(json.load(open(sys.argv[1], encoding="utf-8"))["path"])
except (OSError, ValueError, KeyError, TypeError):
    raise SystemExit(1)
PY
}

venv_ok() {
  "$PYTHON" -c 'import venv, ensurepip' >/dev/null 2>&1
}

normalise_domain() {
  local domain
  domain="$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d '[:space:]')"
  [[ -n "$domain" ]] || die "a domain name is required"
  [[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] \
    || die "'$1' is not a domain name (use letters, digits, dots and dashes)"
  (( ${#domain} <= 253 )) || die "domain is longer than 253 characters"
  case "$domain" in
    *..*|.*|*.) die "'$domain' has an empty label" ;;
  esac
  printf '%s\n' "$domain"
}

# Claim a free DuckDNS name; prints the domain, or nothing when it cannot.
claim_free_domain() {
  local token="${DUCKDNS_TOKEN:-}"
  if [[ -z "$token" && -r "$TOKEN_FILE" ]]; then
    token="$(<"$TOKEN_FILE")"
  fi
  if [[ -z "$token" ]]; then
    if [[ ! -t 0 ]]; then
      die "no DuckDNS token for --free-domain; export DUCKDNS_TOKEN or run interactively"
    fi
    printf 'Create a free token at https://www.duckdns.org (sign in, copy the token).\n' >&2
    printf 'DuckDNS token (hidden, saved to %s): ' "$TOKEN_FILE" >&2
    read -r -s token || token=""
    printf '\n' >&2
    [[ -n "$token" ]] || die "no DuckDNS token entered"
    mkdir -p "$(dirname "$TOKEN_FILE")"
    chmod 700 "$(dirname "$TOKEN_FILE")" 2>/dev/null || true
    printf '%s\n' "$token" >"$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
  fi
  local args=(--prefix monico) output domain
  [[ -n "$PUBLIC_IP" ]] && args+=(--ip "$PUBLIC_IP")
  if ! output="$(DUCKDNS_TOKEN="$token" "$PYTHON" "$ROOT/linux/free_domain.py" "${args[@]}" 2>&1)"; then
    printf 'Monico autostart: free domain not claimed: %s\n' "$output" >&2
    printf 'Continuing with the local-only placeholder domain.\n' >&2
    return 0
  fi
  domain="$(printf '%s' "$output" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["domain"])' 2>/dev/null)" \
    || domain=""
  if [[ -z "$domain" ]]; then
    printf 'Monico autostart: DuckDNS answered without a domain; using the local placeholder.\n' >&2
    return 0
  fi
  printf 'Free domain claimed: %s (pointed at your public IP).\n' "$domain" >&2
  printf 'The name resolves, but inbound mail still needs TCP/25 and reverse DNS, so external email remains separate work.\n' >&2
  printf '%s\n' "$domain"
}

# Prints the domain to use; prompts only on an interactive first run.
choose_domain() {
  local state="$1" existing="" choice="" typed=""
  if [[ -n "$state" && -f "$state/monico/linux-config.json" ]]; then
    existing="$("$PYTHON" - "$state/monico/linux-config.json" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["domain"])
PY
)" || existing=""
    if [[ -n "$DOMAIN" && "$DOMAIN" != "$existing" ]]; then
      die "this storage already uses $existing; changing the domain is blocked to protect agent addresses"
    fi
    printf '%s\n' "$existing"
    return 0
  fi
  if [[ -n "$DOMAIN" ]]; then
    normalise_domain "$DOMAIN"
    return 0
  fi
  if [[ "$FREE_DOMAIN" -eq 1 ]]; then
    claim_free_domain
    return 0
  fi
  [[ -t 0 ]] || return 0
  printf "\nMailbox domain for your agents' addresses:\n" >&2
  printf '  1) claim a free DuckDNS subdomain now (needs a free duckdns.org token)\n' >&2
  printf '  2) type a domain you already control\n' >&2
  printf '  3) local-only placeholder mail.example.invalid\n' >&2
  printf 'Choose 1-3 [1]: ' >&2
  read -r choice || choice="1"
  case "${choice:-1}" in
    1) claim_free_domain ;;
    2)
      printf 'Domain: ' >&2
      read -r typed || typed=""
      normalise_domain "$typed"
      ;;
    *) return 0 ;;
  esac
}

prepare_paths() {
  [[ -n "$STATE_DIR" ]] || die "--print needs an initialized --state-dir; run the installer once without --print first"
  [[ "$STATE_DIR" = /* ]] || die "--state-dir must be an absolute path so boot never depends on the current directory"
  [[ -d "$STATE_DIR" ]] || die "storage directory not found: $STATE_DIR"
  STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"
  CONFIG="$STATE_DIR/monico/linux-config.json"
  [[ -f "$CONFIG" ]] || die "no Monico configuration at $CONFIG; run: bash start.sh --full up --install --state-dir $STATE_DIR"
  local perms
  perms="$(stat -c '%a' "$CONFIG" 2>/dev/null || echo unknown)"
  case "$perms" in
    600|400) ;;
    *) die "operator credentials $CONFIG must be mode 0600 (found $perms); fix it with chmod 600 before enabling autostart" ;;
  esac
  [[ -f "$WATCHDOG" ]] || die "watchdog missing: $WATCHDOG"
  [[ -f "$LAUNCHER" ]] || die "launcher missing: $LAUNCHER"
  [[ -n "$PYTHON" && -x "$PYTHON" ]] || die "python3 was not found on PATH"
  case "$ROOT$STATE_DIR" in
    *\"*|*$'\n'*) die "paths containing quotes or newlines are not supported" ;;
  esac
}

render_unit() {
  cat <<EOF
$MARKER
# Regenerate with: bash linux/enable_autostart.sh --state-dir "$STATE_DIR"
# Local supervisor only: no public SMTP/IMAP, carrier calls/SMS or DNS claims.
[Unit]
Description=Monico local agent communications watchdog (phone dashboard + mail MCP)
After=network-online.target

[Service]
Type=simple
WorkingDirectory="$ROOT"
Environment=PYTHONUNBUFFERED=1
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart="$PYTHON" "$WATCHDOG" --state-dir "$STATE_DIR" --interval $INTERVAL${PUBLIC_IP:+ --public-ip $PUBLIC_IP --allow-public}
Restart=always
RestartSec=10
TimeoutStopSec=75
KillMode=control-group

[Install]
WantedBy=default.target
EOF
}

have_user_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

linger_state() {
  command -v loginctl >/dev/null 2>&1 || { echo "unknown"; return 0; }
  loginctl show-user "$LOGIN_USER" -p Linger --value 2>/dev/null || echo "unknown"
}

# Start or reuse both local services, installing distribution packages once if
# the Python venv module is the only thing missing.
ensure_launch() {
  local state="$1"
  local args=(--full up)
  if ! "$ROOT/monico-mail-usb/.venv/bin/python" -c 'import fastmcp, pydantic' >/dev/null 2>&1; then
    args+=(--install)
  fi
  [[ -n "$state" ]] && args+=(--state-dir "$state")
  [[ -n "$DOMAIN" ]] && args+=(--domain "$DOMAIN")
  if bash "$LAUNCHER" "${args[@]}" >>"$LOG_FILE" 2>&1; then
    return 0
  fi
  if ! venv_ok && command -v apt-get >/dev/null 2>&1; then
    echo "First launch needs Linux packages; sudo may ask for your password." >&2
    local os_args=()
    [[ -n "$state" ]] && os_args+=(--state-dir "$state")
    [[ -n "$DOMAIN" ]] && os_args+=(--domain "$DOMAIN")
    bash "$ROOT/linux/install.sh" "${os_args[@]}" >>"$LOG_FILE" 2>&1 || true
    if bash "$LAUNCHER" "${args[@]}" >>"$LOG_FILE" 2>&1; then
      return 0
    fi
  fi
  tail -40 "$LOG_FILE" >&2
  die "could not start the local services; the log above shows why"
}

apply_linger() {
  local linger
  linger="$(linger_state)"
  if [[ "$linger" != "yes" ]] && loginctl enable-linger "$LOGIN_USER" >/dev/null 2>&1; then
    linger="yes"
  fi
  if [[ "$linger" != "yes" ]] && [[ -t 0 ]] && command -v sudo >/dev/null 2>&1; then
    sudo loginctl enable-linger "$LOGIN_USER" >/dev/null && linger="yes"
  fi
  echo "$linger"
}

install_unit() {
  have_user_systemd || die "systemd --user is unavailable in this session; the local services are running, but autostart needs a real user systemd session (log in locally and re-run)"
  local target="$UNIT_DIR/$UNIT_NAME"
  mkdir -p "$UNIT_DIR"
  if [[ -f "$target" ]] && ! grep -qF "$MARKER" "$target" && [[ "$FORCE" -ne 1 ]]; then
    die "$target already exists but was not created by this script; inspect it, then re-run with --force"
  fi
  local tmp
  tmp="$(mktemp "$UNIT_DIR/.$UNIT_NAME.XXXXXX")"
  render_unit > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$target"
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME" \
    || die "unit written but 'systemctl --user enable --now $UNIT_NAME' failed; inspect: systemctl --user status $UNIT_NAME"

  local linger
  linger="$(apply_linger)"

  echo "Installed $target"
  echo "Storage: $STATE_DIR"
  echo "Dashboard: http://127.0.0.1:8765"
  echo "Mail MCP: http://127.0.0.1:8787/mcp"
  echo "Watchdog: checks every ${INTERVAL}s, restarts both services after a crash."
  if [[ "$linger" == "yes" ]]; then
    echo "Lingering enabled: the stack also starts at boot before you log in."
  else
    echo "Lingering is off: the stack starts when you log in, not at boot."
    echo "Enable boot start with: sudo loginctl enable-linger $LOGIN_USER"
  fi
  if [[ -n "$PUBLIC_IP" ]]; then
    echo "Public HTTPS gateway opt-in recorded for $PUBLIC_IP:8766."
    echo "Router/ISP forwarding, trusted CA install and outside-network reachability remain unverified."
  else
    echo "Public HTTPS gateway: NOT enabled (local 127.0.0.1 dashboard and MCP only)."
  fi
  echo "Internal-only addresses (@agents.invalid) and extensions (2000-2999). Public email and telephone service are separate, unverified work."
}

install_all() {
  local state=""
  if [[ -n "$DOMAIN" && "$FREE_DOMAIN" -eq 1 ]]; then
    die "use either --domain or --free-domain, not both"
  fi
  if [[ -n "$STATE_DIR" ]]; then
    [[ "$STATE_DIR" = /* ]] || die "--state-dir must be an absolute path so boot never depends on the current directory"
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    state="$(cd "$STATE_DIR" && pwd -P)"
  elif saved="$(saved_storage)"; then
    state="$saved"
  fi

  local domain
  domain="$(choose_domain "$state")"
  [[ -n "$domain" ]] && DOMAIN="$domain"

  echo "Preparing private storage and starting the local services..."
  ensure_launch "$state"
  if [[ -z "$state" ]]; then
    state="$(saved_storage || true)"
  fi
  [[ -n "$state" ]] || die "the launcher started without recording its storage; run: bash start.sh --full up --install"
  STATE_DIR="$state"
  prepare_paths
  echo "Installing the systemd --user watchdog for $state..."
  install_unit
}

show_status() {
  local target="$UNIT_DIR/$UNIT_NAME"
  if [[ -f "$target" ]]; then
    echo "unit file: $target"
  else
    echo "unit file: not installed ($target)"
  fi
  if have_user_systemd; then
    echo "enabled: $(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null || echo no)"
    echo "active: $(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || echo no)"
  else
    echo "enabled: unknown (systemctl --user unavailable in this session)"
    echo "active: unknown (systemctl --user unavailable in this session)"
  fi
  echo "linger: $(linger_state)"
  echo "Local services themselves: bash start.sh --full status"
}

uninstall_unit() {
  local target="$UNIT_DIR/$UNIT_NAME"
  if [[ -f "$target" ]] && ! grep -qF "$MARKER" "$target" && [[ "$FORCE" -ne 1 ]]; then
    die "$target was not created by this script; inspect it, then re-run with --force"
  fi
  if have_user_systemd; then
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -f "$target" ]]; then
    rm -f "$target"
    echo "Removed $target"
  else
    echo "Nothing to remove; $target was not installed"
  fi
  if have_user_systemd; then
    systemctl --user daemon-reload || true
  fi
  echo "The watchdog stops the phone dashboard and mail MCP on SIGTERM; verify with:"
  echo "  bash start.sh --full status"
}

validate_interval
validate_public

case "$MODE" in
  print)
    prepare_paths
    render_unit
    ;;
  install)
    install_all
    ;;
  status)
    show_status
    ;;
  uninstall)
    uninstall_unit
    ;;
esac
