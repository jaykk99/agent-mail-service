#!/usr/bin/env python3
"""Monico Private Mail: works on Linux with Python + writable storage, offline.

All addresses end in monico.test, a special-use testing domain. Messages travel
locally through the USB SQLite database, NOT via public internet SMTP.

For agents on different Linux machines, share access through a secured private
network and the existing authenticated MCP server. This CLI itself has no
network listener and is best for agents executing on ONE Linux host.
"""
import argparse
from getpass import getpass
import json
import os
from pathlib import Path
import shlex
import sqlite3
import sys
import tempfile

from mailbox_claims import MailboxClaims
from monico_core import Registry

PRIVATE_DOMAIN = "monico.test"
CONFIG_PATH = Path.home() / ".config" / "monico-mail-private" / "config.json"


def _config_path():
    """Resolve HOME at call time so tests and distinct Linux users work."""
    return Path.home() / ".config" / "monico-mail-private" / "config.json"


def create_private_storage(usb=None, data=None, removable="/mnt/chromeos/removable",
                           configuration=None):
    """Create a private-only mail database location, leaving public Monico untouched."""
    if (usb is None) == (data is None):
        raise ValueError("Choose exactly one of --usb DRIVE or --data EXISTING_PATH")
    if usb is not None:
        if (not usb or usb in (".", "..") or "/" in usb or "\\" in usb
                or "\x00" in usb):
            raise ValueError("Invalid USB drive name")
        drive = Path(removable) / usb
        if not drive.is_dir():
            raise ValueError("Shared USB drive not found: " + str(drive))
        storage = drive / "monico-private"
        storage.mkdir(mode=0o700, exist_ok=True)
    else:
        storage = Path(data).expanduser().resolve(strict=True)
        if not storage.is_dir():
            raise ValueError("Data path must already be an existing directory")
    storage = storage.resolve(strict=True)

    # Test SQLite on the actual chosen filesystem; never silently fall back.
    fd, probe = tempfile.mkstemp(prefix=".monico-private-probe-", dir=storage)
    os.close(fd)
    try:
        with sqlite3.connect(probe) as db:
            db.execute("CREATE TABLE probe (value TEXT)")
            db.execute("INSERT INTO probe VALUES ('ok')")
            assert db.execute("SELECT value FROM probe").fetchone()[0] == "ok"
    finally:
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                Path(probe + suffix).unlink()
            except FileNotFoundError:
                pass

    # Reject existing databases configured under a different domain.
    Registry(storage, PRIVATE_DOMAIN)
    dest = Path(configuration) if configuration else _config_path()
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = {"mode": "PRIVATE_LINUX_ONLY", "domain": PRIVATE_DOMAIN,
               "data": str(storage)}
    fd, temp_path = tempfile.mkstemp(dir=dest.parent, prefix=".config-", text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(payload, output, indent=2)
            output.write("\n")
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, dest)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    return payload


def open_private(config_path=None):
    config_path = Path(config_path) if config_path else _config_path()
    if not config_path.is_file():
        raise ValueError("Run: python3 private_mail.py setup --usb YOUR_DRIVE first")
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    if cfg.get("mode") != "PRIVATE_LINUX_ONLY" or cfg.get("domain") != PRIVATE_DOMAIN:
        raise ValueError("Not a private Monico configuration")
    data = Path(cfg["data"])
    if not data.is_dir():
        raise ValueError("Configured USB path is missing; refusing internal-disk fallback")
    return Registry(data, PRIVATE_DOMAIN)


def agent_token():
    """Read tokens privately from an environment variable or hidden prompt."""
    supplied = os.environ.get("MONICO_AGENT_TOKEN", "")
    return supplied or getpass("Agent token (hidden): ")


def demo():
    """No login, network, DNS or permanent data; show a genuine local round-trip."""
    with tempfile.TemporaryDirectory() as folder:
        registry = Registry(folder, PRIVATE_DOMAIN)
        alice = registry.register("demo_alice", "research")
        bob = registry.register("demo_bob", "support")
        delivered = registry.send_internal(
            alice["agent_id"], alice["token"], bob["email"],
            "Linux-only Monico demo", "Hello from research! This is private mail."
        )
        fresh = Registry(folder, PRIVATE_DOMAIN)
        inbox = fresh.inbox(bob["agent_id"], bob["token"])
        message = fresh.read_message(bob["agent_id"], bob["token"],
                                     delivered["message_id"])
        assert len(inbox) == 1 and message["body"].startswith("Hello from")
        return {"delivery": "LOCAL_SQLITE_ONLY", "sender": alice["email"],
                "recipient": bob["email"], "subject": message["subject"],
                "body": message["body"], "survived_database_reopen": True,
                "public_internet_delivery": False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("setup", help="Set up Linux-only mail; no public DNS or port 25")
    location = setup.add_mutually_exclusive_group(required=True)
    location.add_argument("--usb", help="Drive name displayed in /mnt/chromeos/removable/")
    location.add_argument("--data", help="An existing writable directory (use USB for persistence)")
    invite = commands.add_parser("invite", help="Issue private one-time mailbox invitation codes")
    invite.add_argument("--count", type=int, default=1)
    invite.add_argument("--days", type=int, default=7)
    claim = commands.add_parser("claim", help="Choose your private email address name")
    claim.add_argument("name")
    commands.add_parser("status", help="Show private domain and mailbox count")
    send = commands.add_parser("send", help="Send to another registered private Monico inbox")
    send.add_argument("--agent-id", required=True)
    send.add_argument("--to", required=True)
    send.add_argument("--subject", required=True)
    send.add_argument("--body", help="Body text; if omitted, read until EOF from stdin")
    inbox = commands.add_parser("inbox", help="List this agent's private messages")
    inbox.add_argument("--agent-id", required=True)
    inbox.add_argument("--limit", type=int, default=20)
    read = commands.add_parser("read", help="Read only this agent's addressed message")
    read.add_argument("--agent-id", required=True)
    read.add_argument("id", type=int)
    commands.add_parser("demo", help="Run a real local round-trip in temporary Linux storage")
    args = parser.parse_args()
    try:
        if args.command == "demo":
            result = demo()
        elif args.command == "setup":
            result = create_private_storage(usb=args.usb, data=args.data)
        else:
            registry = open_private()
            claims = MailboxClaims(registry)
            if args.command == "invite":
                result = claims.issue_invites(args.count, args.days)
            elif args.command == "claim":
                code = getpass("One-time invitation code (hidden): ")
                result = claims.claim(code, args.name)
            elif args.command == "status":
                result = {**claims.slots(), "mode": "PRIVATE_LINUX_ONLY",
                          "public_internet_delivery": False}
            elif args.command == "send":
                token = agent_token()
                body = args.body if args.body is not None else sys.stdin.read(100_001)
                result = registry.send_internal(args.agent_id, token,
                                                args.to, args.subject, body)
                result["transport"] = "LOCAL_SQLITE_ONLY"
            elif args.command == "inbox":
                result = registry.inbox(args.agent_id, agent_token(), args.limit)
            else:
                result = registry.read_message(args.agent_id, agent_token(), args.id)
        print(json.dumps(result, indent=2))
        if args.command in ("setup", "demo", "status"):
            print("NOTICE: monico.test addresses work inside Monico only, not as public email.",
                  file=sys.stderr)
    except (ValueError, RuntimeError, OSError, sqlite3.Error, json.JSONDecodeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
