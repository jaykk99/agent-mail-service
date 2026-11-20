#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
echo
echo "Setup complete. Share a USB folder with Linux using ChromeOS Files."
echo "Set MONICO_DATA to that shared folder (usually /mnt/chromeos/removable/DRIVE/FOLDER)."
echo "Generate MONICO_ADMIN_KEY with: python3 -c 'import secrets; print(secrets.token_urlsafe(48))'"
echo "Run: .venv/bin/python server.py"
