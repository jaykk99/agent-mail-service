#!/usr/bin/env python3
"""Provision real per-agent Dovecot mailboxes shared with Calling-linux.

Reads the provisioned Monico identities (phone-data/identities.json) and
writes, for a given domain:

  dovecot-users     Dovecot passwd file in Calling-linux export format with
                    REAL SHA512-CRYPT hashes (never placeholders)
  credentials.json  the file Calling-linux imap-sync auto-reads at
                    /etc/linux-carrier-1000/credentials.json (mode 0600)
  make-maildirs.sh  creates /var/mail/vhosts/<domain>/<local>/{cur,new,tmp}
                    on the target Linux host (review before running as root)

Mailbox passwords reuse each agent's already-provisioned high-entropy
sipPassword from identities.json; no new secrets are invented and nothing
is written into git. The Maildir layout matches Calling-linux exactly:
the Maildir IS /var/mail/vhosts/<domain>/<local-part> (no /Maildir suffix),
quota 512M per mailbox, same as Calling-linux's quotaMb.

Usage:
  python3 phone/calling_linux_mailboxes.py --state-dir ./phone-data \\
      --domain mail.example.com --out .generated/calling-linux-mail
  # then review the outputs and, on the Linux host:
  sudo cp .generated/calling-linux-mail/dovecot-users /etc/dovecot/users
  sudo cp .generated/calling-linux-mail/credentials.json /etc/linux-carrier-1000/credentials.json
  sudo bash .generated/calling-linux-mail/make-maildirs.sh

Standard library only. Requires the crypt module (Python < 3.13) or
doveadm for hashes; refuses to emit placeholder hashes.
"""
import argparse
import json
import os
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]
                       / "monico-mail-usb" / "selfhost"))

from generate_config import (  # noqa: E402
    CALLING_LINUX_MAIL_ROOT,
    CALLING_LINUX_QUOTA_MB,
    render_calling_linux_dovecot_users,
)
from provision import BASE_EXTENSION, MAX_AGENTS  # noqa: E402

CREDENTIALS_PATH = "/etc/linux-carrier-1000/credentials.json"


def sha512_crypt(password):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            import crypt
    except ImportError as exc:
        raise RuntimeError(
            "crypt module unavailable on this Python; generate hashes with "
            "'doveadm pw -s SHA512-CRYPT -p <password>' instead"
        ) from exc
    salt = crypt.mksalt(crypt.METHOD_SHA512)
    return crypt.crypt(password, salt)


def mailbox_entries(state_dir, domain, quota_mb=CALLING_LINUX_QUOTA_MB):
    """Return (dovecot entries, credential accounts) for every agent."""
    identities_path = Path(state_dir) / "identities.json"
    if not identities_path.is_file():
        raise ValueError("Run bash start.sh first to provision the 1,000 agents")
    data = json.loads(identities_path.read_text(encoding="utf-8"))
    identities = data.get("extensions")
    if not isinstance(identities, dict) or not identities:
        raise ValueError("Invalid Monico agent identity store")
    entries, accounts = [], []
    for ext in sorted(identities, key=int):
        item = identities[ext]
        if not isinstance(item, dict) or not item.get("sipPassword"):
            raise ValueError(f"Incomplete identity at extension {ext}")
        legacy = int(ext) - BASE_EXTENSION + 1
        if not 1 <= legacy <= MAX_AGENTS:
            raise ValueError(f"Extension {ext} has no Calling-linux legacy mapping")
        local_part = f"1201555{legacy:04d}"
        email = f"{local_part}@{domain}"
        password = item["sipPassword"]
        entries.append((local_part, sha512_crypt(password), quota_mb))
        accounts.append({"email": email, "password": password,
                         "extension": ext, "legacyExtension": legacy})
    return entries, accounts


def write_outputs(state_dir, domain, out_dir, quota_mb=CALLING_LINUX_QUOTA_MB):
    entries, accounts = mailbox_entries(state_dir, domain, quota_mb)
    out = Path(out_dir)
    out.mkdir(parents=True, mode=0o700, exist_ok=True)
    users_text = render_calling_linux_dovecot_users(domain, entries)
    users_path = out / "dovecot-users"
    users_path.write_text(users_text, encoding="utf-8")
    users_path.chmod(0o600)
    creds = {"schema": 1, "source": "agent-mail-service",
             "mailRoot": CALLING_LINUX_MAIL_ROOT, "domain": domain,
             "accounts": accounts}
    creds_path = out / "credentials.json"
    creds_path.write_text(json.dumps(creds, indent=2) + "\n", encoding="utf-8")
    creds_path.chmod(0o600)
    maildirs = ["#!/bin/sh",
                "# Create the shared Maildir tree. Review before running as root.",
                f"# Install target: {CREDENTIALS_PATH}",
                "set -eu"]
    for local_part, _, _ in entries:
        base = f"{CALLING_LINUX_MAIL_ROOT}/{domain}/{local_part}"
        maildirs.append(f"mkdir -p {base}/cur {base}/new {base}/tmp")
    maildirs.append("chown -R 5000:5000 "
                    f"{CALLING_LINUX_MAIL_ROOT}/{domain}")
    maildirs.append(f"chmod 700 {CALLING_LINUX_MAIL_ROOT}/{domain}")
    script_path = out / "make-maildirs.sh"
    script_path.write_text("\n".join(maildirs) + "\n", encoding="utf-8")
    script_path.chmod(0o700)
    return {"mailboxes": len(entries), "domain": domain,
            "dovecotUsers": str(users_path), "credentials": str(creds_path),
            "maildirScript": str(script_path),
            "installCredentialsTo": CREDENTIALS_PATH}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--state-dir", required=True,
                   help="Existing private Monico state path (phone-data)")
    p.add_argument("--domain", required=True,
                   help="Mail domain shared with Calling-linux")
    p.add_argument("--quota-mb", type=int, default=CALLING_LINUX_QUOTA_MB)
    p.add_argument("--out", default=".generated/calling-linux-mail")
    args = p.parse_args()
    try:
        result = write_outputs(args.state_dir, args.domain, args.out, args.quota_mb)
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        p.error(str(exc))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
