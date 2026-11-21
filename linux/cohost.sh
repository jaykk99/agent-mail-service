#!/usr/bin/env bash
# Agent Mail + Lin-2-Mux: install, update, start, stop, or diagnose together.
# All local services; no public SMTP delivery is implied.
set -euo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="${MONICO_BRIDGE_DIR:-$HOME/linuxtomux}"
BRIDGE_DATA="${MONICO_HOME:-$HOME/.monico-bridge}"
BRIDGE_PORT=8767
BRIDGE_PID="$BRIDGE_DATA/cohost-server.pid"
BRIDGE_LOG="$BRIDGE_DATA/cohost-server.log"
LAUNCHER="$HOME/.local/bin/monico-server"
ACTION="${1:-up}"

say() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

bridge_health() {
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$BRIDGE_PORT" <<'PY' >/dev/null 2>&1
import json, sys, urllib.request
url = "http://127.0.0.1:" + sys.argv[1] + "/health"
try:
    with urllib.request.urlopen(url, timeout=1) as resp:
        value = json.load(resp)
    assert value.get("ok") and value.get("service") == "monico-bridge"
except Exception:
    sys.exit(1)
PY
}

# Only stop a process started by this wrapper; a PID alone is never enough.
managed_bridge_pid() {
    [[ -f "$BRIDGE_PID" ]] || return 1
    local pid args
    pid="$(cat "$BRIDGE_PID" 2>/dev/null)" || return 1
    [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
    args="$(ps -p "$pid" -o args= 2>/dev/null)" || return 1
    [[ "$args" == *"monico-server"* ]] || return 1
    printf '%s\n' "$pid"
}

stop_bridge() {
    local pid
    if pid="$(managed_bridge_pid)"; then
        say "Stopping the Lin-2-Mux process started by this installer."
        kill "$pid" 2>/dev/null || true
        for _ in {1..30}; do
            if ! bridge_health; then break; fi
            sleep 0.2
        done
        rm -f "$BRIDGE_PID"
    elif bridge_health; then
        say "Lin-2-Mux is running outside this installer; leaving it untouched."
    else
        rm -f "$BRIDGE_PID"
        say "Lin-2-Mux is not running."
    fi
}

ensure_runtime() {
    if command -v python3 >/dev/null 2>&1 && command -v git >/dev/null 2>&1 &&
       command -v openssl >/dev/null 2>&1 && python3 -m venv --help >/dev/null 2>&1; then
        return
    fi
    command -v apt-get >/dev/null 2>&1 ||
        fail "Missing Python/Git/OpenSSL/venv. Automatic package installation requires Debian or Ubuntu."
    local apt=(apt-get)
    if [[ "$EUID" -ne 0 ]]; then
        command -v sudo >/dev/null 2>&1 || fail "OS dependencies need sudo."
        apt=(sudo apt-get)
    fi
    say "Installing Linux prerequisites (system may ask for sudo password)."
    "${apt[@]}" update
    "${apt[@]}" install -y python3 python3-venv python3-pip git openssl
}

checkout_bridge() {
    if [[ -n "${MONICO_BRIDGE_SOURCE:-}" ]]; then
        # CI/offline fixture path; never used unless explicitly set.
        [[ -f "$MONICO_BRIDGE_SOURCE/monico-server" ]] ||
            fail "MONICO_BRIDGE_SOURCE does not contain Lin-2-Mux."
        if [[ "$BRIDGE_DIR" != "$MONICO_BRIDGE_SOURCE" ]]; then
            mkdir -p "$BRIDGE_DIR"
            cp -a "$MONICO_BRIDGE_SOURCE/." "$BRIDGE_DIR/"
        fi
    elif [[ -d "$BRIDGE_DIR/.git" ]]; then
        say "Updating existing Lin-2-Mux checkout without overwriting local changes."
        git -C "$BRIDGE_DIR" pull --ff-only ||
            fail "Lin-2-Mux contains diverging changes. Resolve them before an automatic update."
    elif [[ ! -e "$BRIDGE_DIR" ]]; then
        git clone https://github.com/jaykk99/linuxtomux.git "$BRIDGE_DIR"
    else
        fail "$BRIDGE_DIR exists and is not a Git checkout. Refusing to overwrite."
    fi
}

start_bridge() {
    mkdir -p "$BRIDGE_DATA"
    chmod 700 "$BRIDGE_DATA"
    if bridge_health; then
        if managed_bridge_pid >/dev/null; then
            # Restart only our process to pick up newly installed code.
            stop_bridge
        else
            say "Lin-2-Mux already running on $BRIDGE_PORT; leaving it untouched."
            return 0
        fi
    fi
    [[ -x "$LAUNCHER" ]] || fail "Lin-2-Mux Linux launcher was not installed."
    if python3 - "$BRIDGE_PORT" <<'PY'
import socket,sys
with socket.socket() as s:
    sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) != 0 else 1)
PY
    then :; else
        fail "Port $BRIDGE_PORT is taken by another process; cannot start Lin-2-Mux."
    fi
    nohup "$LAUNCHER" start --port "$BRIDGE_PORT" >>"$BRIDGE_LOG" 2>&1 </dev/null &
    local pid=$!
    printf '%s\n' "$pid" >"$BRIDGE_PID"
    for _ in {1..60}; do
        if bridge_health; then return 0; fi
        if ! kill -0 "$pid" 2>/dev/null; then
            say "Last Lin-2-Mux logs:"
            tail -n 30 "$BRIDGE_LOG" >&2 || true
            fail "Lin-2-Mux exited during startup."
        fi
        sleep 0.25
    done
    kill "$pid" 2>/dev/null || true
    rm -f "$BRIDGE_PID"
    fail "Lin-2-Mux did not become healthy. Inspect $BRIDGE_LOG."
}

# ADB reverse is optional, but it allows a paired Termux phone to
# communicate and download its bridge installer entirely over the USB cable,
# without WiFi, mobile data, router port forwarding, or an Android IP.
ensure_adb() {
    if command -v adb >/dev/null 2>&1; then return 0; fi
    if [[ "${MONICO_SKIP_ADB_INSTALL:-0}" == "1" ]]; then return 1; fi
    if ! command -v apt-get >/dev/null 2>&1; then
        say "ADB not installed: local WiFi works; USB reverse needs Android platform-tools."
        return 1
    fi
    local apt=(apt-get)
    if [[ "$EUID" -ne 0 ]]; then
        if ! command -v sudo >/dev/null 2>&1; then
            say "ADB not installed: sudo is unavailable; local WiFi still works."
            return 1
        fi
        apt=(sudo apt-get)
    fi
    say "Installing free Android platform tools (ADB) for offline USB pairing."
    if "${apt[@]}" update && "${apt[@]}" install -y adb; then
        return 0
    fi
    say "ADB could not be installed. Local WiFi pairing still works."
    return 1
}

enable_usb_reverse() {
    command -v adb >/dev/null 2>&1 || return 1
    # Never claim USB pairing unless the physical phone is attached AND
    # the user accepted Android's trust/USB-debugging authorization prompt.
    local status
    status="$(adb devices 2>/dev/null || true)"
    if grep -qE '^[[:alnum:]_.:-]+[[:space:]]+device
    say "Both services started locally on this Linux machine:"
    say "  Agent Mail dashboard: http://127.0.0.1:8765"
    say "  Agent Mail MCP:       http://127.0.0.1:8787/mcp"
    say "  Lin-2-Mux dashboard:  http://127.0.0.1:8767/dashboard"
    say ""
    local usb_ready=0
    if enable_usb_reverse; then usb_ready=1; fi
    say "Pair your Android Termux phone with the fresh 4-digit code below."
    "$HOME/.local/bin/monico-pair"
    if (( usb_ready )); then
        say "Android USB bridge: CONNECTED and authorized, no Android internet needed."
        say "Run monico-connect on Termux and enter the displayed code."
        say "If Termux is not installed yet, copy/paste this one line on Termux:"
        say "  curl -fsSL http://127.0.0.1:$BRIDGE_PORT/install-termux.sh | bash -s -- http://127.0.0.1:$BRIDGE_PORT"
        say "It downloads everything from Linux itself. Termux needs bash, curl, Python installed once."
    fi
    local ip
    ip="$(python3 - <<'PY'
import socket
try:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("1.1.1.1", 80))
        print(s.getsockname()[0])
except OSError:
    pass
PY
)"
    if [[ -n "$ip" ]]; then
        say "If Termux cannot find Linux automatically, paste this into Termux:"
        say "  monico-connect --server http://$ip:$BRIDGE_PORT"
        say "It will ask for the same four-digit code. No script edits needed."
    fi
    if [[ -d /mnt/chromeos ]]; then
        say "Chromebook Linux note: its container IP may not be reachable from Android."
        say "Use an authorized ADB reverse tunnel or an explicitly enabled HTTPS tunnel."
    fi
    if command -v adb >/dev/null 2>&1 && adb devices 2>/dev/null | grep -qE 'device$'; then
        if adb reverse tcp:$BRIDGE_PORT tcp:$BRIDGE_PORT >/dev/null 2>&1; then
            say "ADB USB tunnel enabled. From Termux use:"
            say "  monico-connect --server http://127.0.0.1:$BRIDGE_PORT"
        fi
    fi
    say ""
    say "Once paired, run monico-usb on Termux or Linux to see drives attached to Linux."
    say "To give proxy-aware Termux tools Linux's internet, run: monico-net on"
    say "For local WiFi with no phone internet, use the Linux address above."
    say "For USB-only pairing, connect a cable, enable USB debugging once and authorize this Linux computer."
    say "If ADB wasn't ready at startup, re-run the SAME installer after authorization."
    "$HOME/.local/bin/monico-usb" || true
    say "To check later: bash $ROOT/linux/cohost.sh status"
    say "Public Internet email still needs real DNS, reachable SMTP and external tests."
}

case "$ACTION" in
    up|install)
        ensure_runtime
        say "Starting Agent Mail (auto-detecting safe USB storage)."
        if [[ -x "$ROOT/monico-mail-usb/.venv/bin/python" ]] &&
           "$ROOT/monico-mail-usb/.venv/bin/python" -c 'import fastmcp, pydantic' >/dev/null 2>&1; then
            bash "$ROOT/start.sh" --full up
        else
            # Existing installer installs system Python packages and MCP dependencies.
            # If Python/venv are already installed, avoid sudo and apt refresh.
            bash "$ROOT/start.sh" --full up --install || {
                say "Retrying with distro package prerequisites." >&2
                bash "$ROOT/linux/install.sh"
            }
        fi
        checkout_bridge
        bash "$BRIDGE_DIR/install-linux.sh"
        start_bridge
        bridge_health || fail "Lin-2-Mux health endpoint is unavailable."
        ensure_adb || true
        print_device_help
        ;;
    status|doctor)
        bash "$ROOT/start.sh" --full "$ACTION"
        if bridge_health; then
            say "Lin-2-Mux: reachable at http://127.0.0.1:$BRIDGE_PORT"
            "$HOME/.local/bin/monico-usb" || true
        else
            fail "Lin-2-Mux is not running at port $BRIDGE_PORT."
        fi
        ;;
    stop)
        stop_bridge
        bash "$ROOT/start.sh" --full stop
        ;;
    *)
        say "Usage: bash install.sh   (install and start both)"
        say "       bash linux/cohost.sh [up|status|doctor|stop]"
        exit 2
        ;;
esac
 <<<"$status"; then
        if adb reverse "tcp:$BRIDGE_PORT" "tcp:$BRIDGE_PORT" >/dev/null 2>&1; then
            return 0
        fi
    fi
    if grep -q 'unauthorized' <<<"$status"; then
        say "Android USB is detected but not authorized. Accept the USB debugging prompt on the phone."
    fi
    return 1
}

print_device_help() {
    say ""
    say "Both services started locally on this Linux machine:"
    say "  Agent Mail dashboard: http://127.0.0.1:8765"
    say "  Agent Mail MCP:       http://127.0.0.1:8787/mcp"
    say "  Lin-2-Mux dashboard:  http://127.0.0.1:8767/dashboard"
    say ""
    say "Pair your Android Termux phone with the fresh 4-digit code below."
    "$HOME/.local/bin/monico-pair"
    local ip
    ip="$(python3 - <<'PY'
import socket
try:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("1.1.1.1", 80))
        print(s.getsockname()[0])
except OSError:
    pass
PY
)"
    if [[ -n "$ip" ]]; then
        say "If Termux cannot find Linux automatically, paste this into Termux:"
        say "  monico-connect --server http://$ip:$BRIDGE_PORT"
        say "It will ask for the same four-digit code. No script edits needed."
    fi
    if [[ -d /mnt/chromeos ]]; then
        say "Chromebook Linux note: its container IP may not be reachable from Android."
        say "Use an authorized ADB reverse tunnel or an explicitly enabled HTTPS tunnel."
    fi
    if command -v adb >/dev/null 2>&1 && adb devices 2>/dev/null | grep -qE 'device$'; then
        if adb reverse tcp:$BRIDGE_PORT tcp:$BRIDGE_PORT >/dev/null 2>&1; then
            say "ADB USB tunnel enabled. From Termux use:"
            say "  monico-connect --server http://127.0.0.1:$BRIDGE_PORT"
        fi
    fi
    say ""
    say "Once paired, run monico-usb on Termux or Linux to see drives attached to Linux."
    "$HOME/.local/bin/monico-usb" || true
    say "To check later: bash $ROOT/linux/cohost.sh status"
    say "Public Internet email still needs real DNS, reachable SMTP and external tests."
}

case "$ACTION" in
    up|install)
        ensure_runtime
        say "Starting Agent Mail (auto-detecting safe USB storage)."
        if [[ -x "$ROOT/monico-mail-usb/.venv/bin/python" ]] &&
           "$ROOT/monico-mail-usb/.venv/bin/python" -c 'import fastmcp, pydantic' >/dev/null 2>&1; then
            bash "$ROOT/start.sh" --full up
        else
            # Existing installer installs system Python packages and MCP dependencies.
            # If Python/venv are already installed, avoid sudo and apt refresh.
            bash "$ROOT/start.sh" --full up --install || {
                say "Retrying with distro package prerequisites." >&2
                bash "$ROOT/linux/install.sh"
            }
        fi
        checkout_bridge
        bash "$BRIDGE_DIR/install-linux.sh"
        start_bridge
        bridge_health || fail "Lin-2-Mux health endpoint is unavailable."
        print_device_help
        ;;
    status|doctor)
        bash "$ROOT/start.sh" --full "$ACTION"
        if bridge_health; then
            say "Lin-2-Mux: reachable at http://127.0.0.1:$BRIDGE_PORT"
            "$HOME/.local/bin/monico-usb" || true
        else
            fail "Lin-2-Mux is not running at port $BRIDGE_PORT."
        fi
        ;;
    stop)
        stop_bridge
        bash "$ROOT/start.sh" --full stop
        ;;
    *)
        say "Usage: bash install.sh   (install and start both)"
        say "       bash linux/cohost.sh [up|status|doctor|stop]"
        exit 2
        ;;
esac
