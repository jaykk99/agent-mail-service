#!/usr/bin/env python3
"""Configure a self-hosted Monico domain and ChromeOS-shared USB data directory.

This configures LOCAL SOFTWARE. It does NOT register a domain, publish DNS,
open TCP/25 or install/configure Postfix or Dovecot.
"""
import argparse
import os
from pathlib import Path
import shlex
import sqlite3
import tempfile

from selfhost.configure_domain import write_domain_config
from selfhost.generate_config import check_domain


CONFIG_DIR = Path.home() / ".config" / "monico-mail"
REMOVABLE = Path("/mnt/chromeos/removable")


def save_storage_config(data_dir, output):
    """Save a private shell-compatible data-path setting, atomically."""
    data_dir = Path(data_dir).expanduser().resolve(strict=True)
    if not data_dir.is_dir():
        raise ValueError("USB data path must be an existing directory")
    if not os.access(data_dir, os.W_OK):
        raise ValueError("USB data path is not writable")
    # Exercise SQLite on the actual filesystem (but do not overwrite an account DB).
    handle, probe = tempfile.mkstemp(prefix=".monico-storage-probe-", dir=data_dir)
    os.close(handle)
    try:
        with sqlite3.connect(probe, timeout=5) as db:
            db.execute("CREATE TABLE probe (value TEXT)")
            db.execute("INSERT INTO probe VALUES ('ok')")
            assert db.execute("SELECT value FROM probe").fetchone()[0] == "ok"
    finally:
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                os.unlink(probe + suffix)
            except FileNotFoundError:
                pass

    target = Path(output).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".storage-", dir=target.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write("export MONICO_DATA=" + shlex.quote(str(data_dir)) + "\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return target


def setup(domain=None, usb_name=None, data_path=None, config_dir=CONFIG_DIR, removable=REMOVABLE):
    """Ensure storage exists and configure a domain you actually own."""
    # setup() is the real-install path: the domain must be one that can
    # actually be delegated, so there is no local default here. Offline or
    # local-only installs (e.g. agents.local) go through the deliberately
    # permissive write_domain_config() in configure_domain.py instead.
    if domain is None:
        raise ValueError(
            "Pass --domain with a domain you actually own "
            "(e.g. --domain your-owned-domain.org). For a local-only install "
            "with agents.local, use configure_domain.py instead.")
    domain = check_domain(domain)
    if usb_name is not None and data_path is not None:
        raise ValueError("Provide at most one of --usb or --data")
    if usb_name is not None:
        if (not usb_name or usb_name in (".", "..") or "/" in usb_name
                or "\\" in usb_name or "\x00" in usb_name):
            raise ValueError("Invalid USB drive name")
        drive = Path(removable) / usb_name
        if not drive.is_dir():
            raise ValueError(f"USB drive is not shared with Linux: {drive}")
        data = drive / "monico"
        data.mkdir(parents=True, exist_ok=True)
    else:
        default_data = Path(data_path or (Path.home() / "agent-mail-data")).expanduser()
        default_data.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = default_data.resolve(strict=True)
        if not data.is_dir():
            raise ValueError("Data path must be a directory")
    config_dir = Path(config_dir).expanduser()
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    domain_file = config_dir / "domain.env"
    storage_file = config_dir / "storage.env"
    write_domain_config(domain, domain_file, data / "agents.sqlite3")
    save_storage_config(data, storage_file)
    return {"domain": domain, "data": str(data.resolve()),
            "domain_file": str(domain_file), "storage_file": str(storage_file),
            "public_domain_verified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True,
                        help="Domain you actually own (e.g. your-owned-domain.org)")
    location = parser.add_mutually_exclusive_group(required=False)
    location.add_argument("--usb", help="Drive name shown by ls /mnt/chromeos/removable")
    location.add_argument("--data", help="Existing directory (defaults to ~/agent-mail-data)")
    args = parser.parse_args()
    try:
        result = setup(args.domain, args.usb, args.data)
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as exc:
        parser.error(str(exc))
    for key, value in result.items():
        print(f"{key}: {value}")
    print("The domain is only configured locally. It is NOT registered or proven publicly reachable.")
    print("Use: python3 mailbox_admin.py issue-invites --count 10")
    print("Then each agent chooses a name with: python3 mailbox_admin.py claim <desired-name>")


if __name__ == "__main__":
    main()
