#!/usr/bin/env python3
"""Claim a free DuckDNS subdomain for this Monico host.

A candidate name is used only when DuckDNS answers OK, which means the name was
not already owned by another account. That is the whole "free if not taken"
rule: names are generated randomly, tried in order, and the first accepted one
is kept.

A free subdomain gives this host a resolvable public name. It does not provide
inbound TCP/25, reverse DNS/PTR, or a delegated mail domain, so internet email
delivery for that name still needs the separate mail work described in
monico-mail-usb/DEPLOYMENT.md. Nothing here changes a firewall or router.
"""
import argparse
import ipaddress
import json
import os
import re
import secrets
import sys
import urllib.parse
import urllib.request

UPDATE_URL = "https://www.duckdns.org/update"
IP_URL = "https://api.ipify.org"
TOKEN_RE = re.compile(r"[A-Za-z0-9-]{8,64}\Z")
PREFIX_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\Z")


class DomainError(Exception):
    """A claim that cannot be completed, with a message safe to show the user."""


def _get(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read(64).decode("utf-8", "replace").strip()


def validate_token(token):
    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token.strip()):
        raise DomainError("DuckDNS token must be the value shown on your duckdns.org account page")
    return token.strip()


def normalise_prefix(prefix):
    cleaned = re.sub(r"[^a-z0-9-]", "", (prefix or "monico").lower()).strip("-")[:28]
    return cleaned if PREFIX_RE.fullmatch(cleaned) else "monico"


def candidate(prefix="monico"):
    """A random unused-looking name; randomness avoids collisions, not check."""
    return f"{normalise_prefix(prefix)}-{secrets.token_hex(3)}"


def public_ipv4(get=None):
    get = get or _get
    try:
        address = ipaddress.ip_address(get(IP_URL).strip())
    except (OSError, ValueError) as exc:
        raise DomainError("could not detect a public IPv4 address; re-run with --public-ip") from exc
    if address.version != 4 or not address.is_global:
        raise DomainError("the detected address is not a globally routable IPv4")
    return str(address)


def claim(token, ip=None, prefix="monico", attempts=5, get=None):
    """Claim the first DuckDNS name that is not already taken.

    DuckDNS answers OK when the record now belongs to this token and KO when the
    name belongs to someone else (or the token is wrong). Only OK is accepted.
    """
    get = get or _get
    token = validate_token(token)
    if not isinstance(attempts, int) or not 1 <= attempts <= 20:
        raise DomainError("attempts must be between 1 and 20")
    if ip is None:
        ip = public_ipv4(get)
    try:
        address = ipaddress.ip_address(str(ip))
    except ValueError as exc:
        raise DomainError("--ip must be a plain IPv4 address") from exc
    if address.version != 4 or not address.is_global:
        raise DomainError("--ip must be a globally routable IPv4 address")
    tried = []
    for _ in range(attempts):
        name = candidate(prefix)
        query = urllib.parse.urlencode({"domains": name, "token": token, "ip": str(address)})
        try:
            answer = get(f"{UPDATE_URL}?{query}").strip().lower()
        except OSError as exc:
            raise DomainError(f"could not reach DuckDNS: {exc.__class__.__name__}") from exc
        if answer == "ok":
            return {"domain": f"{name}.duckdns.org", "ip": str(address), "taken": tried}
        if answer != "ko":
            raise DomainError(f"unexpected DuckDNS response: {answer[:40] or 'empty'}")
        tried.append(f"{name}.duckdns.org")
    raise DomainError("DuckDNS rejected every candidate name; check the token or try again later")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", default="monico", help="Name prefix (default monico)")
    parser.add_argument("--ip", help="Public IPv4; detected when omitted")
    parser.add_argument("--attempts", type=int, default=5)
    args = parser.parse_args()
    token = os.environ.get("DUCKDNS_TOKEN", "")
    try:
        result = claim(token, args.ip, args.prefix, args.attempts)
    except DomainError as exc:
        print(f"Monico free domain: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
