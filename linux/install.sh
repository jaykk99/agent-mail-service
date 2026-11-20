#!/usr/bin/env bash
# Install local Monico Linux prerequisites. Does NOT enable a public mail server.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v apt-get >/dev/null 2>&1; then
  echo "Automatic OS package installation is supported on Debian/Ubuntu Linux only." >&2
  echo "Install python3, python3-venv, python3-pip, git, and openssl manually." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  APT=(apt-get)
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required to install missing OS packages." >&2
    exit 1
  fi
  APT=(sudo apt-get)
fi

echo "Installing Python, venv, Git and OpenSSL from your Linux distribution."
"${APT[@]}" update
"${APT[@]}" install -y python3 python3-venv python3-pip git openssl
echo "Installing the local Monico MCP runtime; phone/SMS-style messaging use Python stdlib."
bash start.sh --full up --install "$@"
echo "Local supervisor started. Use: bash start.sh --full doctor"
echo "Public SMTP/MX, carrier calling/SMS and outside-network reachability are NOT enabled."
