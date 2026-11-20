#!/usr/bin/env python3
"""Local-only CLI to provision self-hosted mail accounts. No email providers used."""
import argparse
import json
import os
import sys
from pathlib import Path
from getpass import getpass
from monico_core import Registry
from mailbox_claims import MailboxClaims


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="Create a unique email account and two secrets")
    create.add_argument("agent_id")
    create.add_argument("name", help="Requested unique local part before the @")
    sub.add_parser("count", help="Count independent registered mailboxes")
    issue = sub.add_parser("issue-invites", help="Create one-use signup invitations for agents")
    issue.add_argument("--count", type=int, default=1, help="1-200 invites per batch")
    issue.add_argument("--valid-days", type=int, default=7, help="Expires in 1-30 days")
    claim = sub.add_parser("claim", help="Agent selects its own email name using an invite")
    claim.add_argument("name", help="Example: research (not a preassigned agent number)")
    rotate = sub.add_parser("rotate-password", help="Rotate an agent's IMAP/SMTP password")
    rotate.add_argument("agent_id")
    args = parser.parse_args()
    root = os.environ.get("MONICO_DATA")
    domain = os.environ.get("MONICO_DOMAIN")
    if not root or not domain:
        parser.error("Set MONICO_DATA to the USB directory and MONICO_DOMAIN to your delegated domain")
    if not Path(root).is_dir():
        parser.error("USB data directory not found; refusing to proceed")
    registry = Registry(root, domain)
    claims = MailboxClaims(registry, capacity=int(os.environ.get("MONICO_MAX_MAILBOXES", "1000")))
    try:
        if args.command == "create":
            result = registry.register(args.agent_id, args.name)
        elif args.command == "issue-invites":
            result = claims.issue_invites(args.count, args.valid_days)
        elif args.command == "claim":
            code = getpass("One-time invitation code (hidden): ")
            result = claims.claim(code, args.name)
        elif args.command == "rotate-password":
            token = getpass("Agent MCP token (hidden): ")
            result = registry.rotate_mail_password(args.agent_id, token)
        else:
            result = {"mailboxes": registry.mailbox_count()}
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2))
    if args.command != "count":
        print("Keep every new credential secret; creation/reset outputs are shown only once.",
              file=sys.stderr)
    if domain.endswith(".invalid"):
        print("WARNING: Placeholder domain is not publicly deliverable.", file=sys.stderr)


if __name__ == "__main__":
    main()
