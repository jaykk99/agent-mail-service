#!/usr/bin/env python3
"""Fail-closed deployment readiness report for self-hosted Monico.

Local readiness is verified against ACTUAL running processes, protected agent
storage, SQLite integrity, and the MCP HTTP authentication boundary.

'public-web', 'internet-mail' and 'carrier-phone' never inherit the local PASS:
an outside network, delegated domain, SMTP ports or carrier interconnect
must be tested in that actual environment before claiming public availability.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PHONE = ROOT / "phone"
MAIL = ROOT / "monico-mail-usb"
for root in (str(ROOT / "linux"), str(MAIL), str(PHONE)):
    if root not in sys.path:
        sys.path.insert(0, root)

import manage


def _row(name, passed, detail):
    return {"check": name, "pass": bool(passed), "detail": detail}


def _mode(path, expected):
    try:
        return (path.stat().st_mode & 0o777) == expected and not path.is_symlink()
    except OSError:
        return False


def _sqlite_healthy(path):
    path = Path(path)
    if not path.is_file():
        return False
    try:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=3) as db:
            row = db.execute("PRAGMA quick_check").fetchone()
        return row == ("ok",)
    except (OSError, sqlite3.Error):
        return False


def _unauthenticated_mcp_blocked():
    # Unauthenticated JSON-RPC requests MUST NOT enumerate agents or tools.
    payload = b'{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    request = Request(
        "http://127.0.0.1:8787/mcp", data=payload, method="POST",
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"},
    )
    try:
        with urlopen(request, timeout=3) as response:
            # Any 2xx response without a bearer is a security failure.
            return False
    except HTTPError as err:
        return err.code in (401, 403)
    except (URLError, OSError):
        return False


def check_local(state_dir):
    state = Path(state_dir).expanduser().resolve()
    checks = []
    checks.append(_row("storage_directory", state.is_dir() and _mode(state, 0o700),
                       "Private Linux storage exists with owner-only permissions"))
    ids_file = state / "identities.json"
    ids_count = 0
    ids_valid = False
    try:
        data = json.loads(ids_file.read_text(encoding="utf-8"))
        extensions = data.get("extensions", {})
        ids_count = len(extensions)
        ids_valid = (data.get("schema") == 1 and
                     isinstance(extensions, dict) and
                     set(extensions) == {str(i) for i in range(2000, 3000)})
    except (OSError, ValueError, TypeError):
        pass
    checks.append(_row("phone_agent_identities", ids_valid and _mode(ids_file, 0o600),
                       f"{ids_count} protected private identities found; exactly 1000 required"))
    cfg_file = state / "monico" / "linux-config.json"
    try:
        cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
        config_valid = (cfg.get("schema") == 1 and cfg.get("state_path") == str(state)
                        and len(cfg.get("admin_key", "")) >= 32
                        and len(cfg.get("bearer_token", "")) >= 32)
    except (OSError, ValueError, TypeError):
        config_valid = False
    checks.append(_row("operator_credential_storage", config_valid and _mode(cfg_file, 0o600),
                       "Operator configuration exists with owner-only permissions; secret values are never printed"))
    phone_db = state / "messages.sqlite3"
    mail_db = state / "monico" / "agents.sqlite3"
    checks.append(_row("internal_messages_sqlite", _sqlite_healthy(phone_db),
                       "Private phone/messages SQLite integrity check"))
    checks.append(_row("named_mailboxes_sqlite", _sqlite_healthy(mail_db),
                       "Private named-mailbox SQLite integrity check"))
    try:
        vfs = os.statvfs(state)
        free = vfs.f_bavail * vfs.f_frsize
    except OSError:
        free = 0
    checks.append(_row("free_storage", free >= 50 * 1024 * 1024,
                       "At least 50 MiB free storage required before deployment"))
    try:
        services = manage.do_status(state)
    except (OSError, RuntimeError, ValueError, sqlite3.Error, KeyError):
        services = {}
    checks.append(_row("phone_process", services.get("phone_online_local") is True,
                       "The correct local agent identity server responds to HTTP health check"))
    checks.append(_row("mail_mcp_process", services.get("mcp_online_local") is True,
                       "Authenticated MCP process is running on localhost"))
    checks.append(_row("mail_mcp_denies_anonymous", _unauthenticated_mcp_blocked(),
                       "Anonymous MCP tool calls must be rejected by HTTP authentication"))
    return {
        "scope": "local",
        "ready": all(x["pass"] for x in checks),
        "checks": checks,
        "mailbox_count": services.get("mailbox_count"),
        "public_internet_email_verified": False,
        "public_pstn_sms_verified": False,
        "outside_network_browser_verified": False,
        "note": "Local PASS does not prove domain delegation, public SMTP or internet browser reachability",
    }


def check_release(state_dir, scope="local"):
    if scope not in ("local", "public-web", "internet-mail", "carrier-phone", "all"):
        raise ValueError("Unsupported release scope")
    report = check_local(state_dir)
    report["scope"] = scope
    if scope != "local":
        # Intentional: never turn a local smoke test into public deployment approval.
        report["local_ready"] = report["ready"]
        report["ready"] = False
        if scope in ("public-web", "all"):
            report["checks"].append(_row(
                "external_https_reachability", False,
                "Run phone/probe_public.py from a genuinely independent network with trusted TLS"))
        if scope in ("internet-mail", "all"):
            report["checks"].append(_row(
                "external_smtp_delivery", False,
                "Requires live Postfix/Dovecot, DNS/MX/PTR, external TCP 25 and two-way mail tests"))
        if scope in ("carrier-phone", "all"):
            report["checks"].append(_row(
                "carrier_interconnect", False,
                "Requires real assigned numbers and authorized PSTN/SMS carrier connection"))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", help="Existing pinned private Monico state directory")
    parser.add_argument("--scope", default="local",
                        choices=("local", "public-web", "internet-mail", "carrier-phone", "all"))
    args = parser.parse_args()
    try:
        state = manage.choose_storage(state_dir=args.state_dir).path
        result = check_release(state, args.scope)
    except (OSError, RuntimeError, ValueError) as exc:
        parser.exit(1, f"Monico release gate: {type(exc).__name__}: {exc}\n")
    print(json.dumps(result, indent=2))
    if not result["ready"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
