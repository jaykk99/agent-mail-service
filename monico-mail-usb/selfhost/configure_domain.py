#!/usr/bin/env python3
"""Configure the locally used email domain WITHOUT pretending to register it.

A public domain must already be delegated to you in global DNS. This tool only
stores the configuration for Monico on your own Linux host.
"""
import argparse
import os
from pathlib import Path
import shlex
import sqlite3
import tempfile
try:
    from .generate_config import check_domain
except ImportError:
    from generate_config import check_domain


def read_existing_domain(db_path):
    """Read an existing registry only; never create a missing SQLite database."""
    path = Path(db_path)
    if not path.is_file():
        return None
    with sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True) as db:
        config = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='config'"
        ).fetchone()
        if config:
            domain_row = db.execute(
                "SELECT value FROM config WHERE name='domain'"
            ).fetchone()
            if domain_row:
                return domain_row[0]
        agents = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
        ).fetchone()
        if not agents:
            return None
        existing = db.execute("SELECT DISTINCT email FROM agents LIMIT 2").fetchall()
    domains = {email.rsplit("@", 1)[-1] for (email,) in existing}
    if len(domains) > 1:
        raise RuntimeError("The database already contains conflicting account domains")
    return next(iter(domains), None)


def write_domain_config(domain, output_file, db_path=None):
    domain = check_domain(domain)
    if db_path:
        previous = read_existing_domain(db_path)
        if previous is not None and previous != domain:
            raise ValueError(
                f"Existing accounts use {previous}; cannot silently switch to {domain}. "
                "Use a fresh database for a new domain or plan an explicit migration."
            )
    destination = Path(output_file).expanduser()
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = f"export MONICO_DOMAIN={shlex.quote(domain)}\n"
    fd, tmp_path = tempfile.mkstemp(prefix=".domain-", dir=destination.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(data)
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, destination)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True, help="Public domain/subdomain you control")
    parser.add_argument("--data", help="Existing Monico USB directory, to prevent domain changes")
    parser.add_argument("--output", default="~/.config/monico-mail/domain.env",
                        help="Private shell config location")
    args = parser.parse_args()
    db = Path(args.data) / "agents.sqlite3" if args.data else None
    destination = write_domain_config(args.domain, args.output, db)
    print(f"Monico domain configured locally: {args.domain.lower()}")
    print(f"Private config saved: {destination}")
    print(f"Run: source {shlex.quote(str(destination))}")
    print("This DOES NOT register or delegate the domain in public DNS.")
    print("Public delivery still requires global NS/MX/A and SPF/DKIM/DMARC/PTR records.")


if __name__ == "__main__":
    main()
