#!/usr/bin/env bash
# One copy/paste Linux installer for Agent Mail + Lin-2-Mux.
# If run via curl | bash outside a checkout, clone the official repository.
# No passwords, API keys, port edits or USB drive names are requested.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [[ -f "$SCRIPT_DIR/linux/cohost.sh" && -f "$SCRIPT_DIR/start.sh" ]]; then
    exec bash "$SCRIPT_DIR/linux/cohost.sh" up "$@"
fi

TARGET="${MONICO_MAIL_DIR:-$HOME/agent-mail-service}"
if ! command -v git >/dev/null 2>&1; then
    if ! command -v apt-get >/dev/null 2>&1; then
        echo "ERROR: Git is missing. Install git for this Linux distribution and retry." >&2
        exit 1
    fi
    if [[ "$EUID" -eq 0 ]]; then
        apt-get update && apt-get install -y git
    elif command -v sudo >/dev/null 2>&1; then
        sudo apt-get update && sudo apt-get install -y git
    else
        echo "ERROR: Git is missing and sudo is unavailable." >&2
        exit 1
    fi
fi
if [[ -d "$TARGET/.git" ]]; then
    echo "Using existing Agent Mail checkout at $TARGET"
    git -C "$TARGET" pull --ff-only
elif [[ ! -e "$TARGET" ]]; then
    git clone https://github.com/jaykk99/agent-mail-service.git "$TARGET"
else
    echo "ERROR: $TARGET exists but is not a Git checkout; refusing to overwrite." >&2
    exit 1
fi
exec bash "$TARGET/install.sh" "$@"
