#!/usr/bin/env python3
"""Claim a free DuckDNS subdomain for this Monico host, or check one.

A candidate name is used only when DuckDNS answers OK, which means the name was
not already owned by another account. That is the whole "free if not taken"
rule: names are generated randomly, tried in order, and the first accepted one
is kept.

Run with --check NAME (and optionally --expect-ip ADDRESS) to verify that a
claimed name resolves to this host's public address. The check asks public
resolvers directly, so a stale local cache cannot hide a record that still
points somewhere else.

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
import socket
import struct
import sys
import urllib.parse
import urllib.request

UPDATE_URL = "https://www.duckdns.org/update"
IP_URL = "https://api.ipify.org"
TOKEN_RE = re.compile(r"[A-Za-z0-9-]{8,64}\Z")
PREFIX_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\Z")
HOSTNAME_RE = re.compile(
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+"
)
DNS_SERVERS = ("8.8.8.8", "1.1.1.1")
DNS_PORT = 53
DNS_TIMEOUT = 5


class DomainError(Exception):
    """A claim or check that cannot be completed, with a message safe to show the user."""


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


def normalise_domain(domain):
    """Lower-case a hostname, accepting the bare DuckDNS prefix as shorthand."""
    name = str(domain or "").strip().lower().rstrip(".")
    if not name:
        raise DomainError("a domain name is required")
    if "." not in name:
        name = f"{name}.duckdns.org"
    if len(name) > 253 or not HOSTNAME_RE.fullmatch(name):
        raise DomainError(f"'{domain}' is not a valid domain name")
    return name


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


def _encode_name(name):
    """Encode a hostname as length-prefixed DNS labels."""
    labels = name.rstrip(".").split(".")
    if not labels or any(not label or len(label) > 63 for label in labels):
        raise DomainError(f"'{name}' is not a valid DNS name")
    try:
        wire = b"".join(bytes((len(label),)) + label.encode("ascii") for label in labels)
    except UnicodeEncodeError as exc:
        raise DomainError(f"'{name}' is not a valid DNS name") from exc
    return wire + b"\x00"


def _skip_name(data, offset):
    """Return the offset just past a (possibly compressed) DNS name."""
    while True:
        if offset >= len(data):
            raise DomainError("malformed DNS response")
        length = data[offset]
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(data):
                raise DomainError("malformed DNS response")
            return offset + 2
        if length & 0xC0:
            raise DomainError("malformed DNS response")
        if length == 0:
            return offset + 1
        offset += 1 + length


def _parse_a(response, query_id):
    """Return the A records in a DNS response, ignoring other record types."""
    if len(response) < 12:
        raise DomainError("malformed DNS response")
    answer_id, flags, questions, answers = struct.unpack("!HHHH", response[:8])
    if answer_id != query_id:
        raise DomainError("DNS response did not match the query")
    rcode = flags & 0x000F
    if rcode == 3:
        return []
    if rcode:
        raise DomainError(f"DNS server returned error code {rcode}")
    offset = 12
    for _ in range(questions):
        offset = _skip_name(response, offset) + 4
        if offset > len(response):
            raise DomainError("malformed DNS response")
    addresses = []
    for _ in range(answers):
        offset = _skip_name(response, offset)
        if offset + 10 > len(response):
            raise DomainError("malformed DNS response")
        rtype, rclass, _ttl, rdlength = struct.unpack("!HHIH", response[offset:offset + 10])
        offset += 10
        if offset + rdlength > len(response):
            raise DomainError("malformed DNS response")
        if rtype == 1 and rclass == 1 and rdlength == 4:
            addresses.append(socket.inet_ntoa(response[offset:offset + 4]))
        offset += rdlength
    return addresses


def _query_a(name, server, timeout=DNS_TIMEOUT):
    """Ask one resolver for the A records of name over UDP."""
    query_id = secrets.randbits(16)
    packet = (
        struct.pack("!HHHHHH", query_id, 0x0100, 1, 0, 0, 0)
        + _encode_name(name)
        + struct.pack("!HH", 1, 1)
    )
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.sendto(packet, (server, DNS_PORT))
            response, _ = sock.recvfrom(4096)
        except OSError as exc:
            raise DomainError(f"could not query {server}: {exc.__class__.__name__}") from exc
    return _parse_a(response, query_id)


def resolve_a(domain, servers=None, timeout=DNS_TIMEOUT):
    """Resolve A records via public resolvers, falling back to the system stub."""
    name = normalise_domain(domain)
    failures = []
    for server in servers or DNS_SERVERS:
        try:
            addresses = _query_a(name, server, timeout)
        except DomainError as exc:
            failures.append(str(exc))
            continue
        if addresses:
            return addresses
        failures.append(f"{server} returned no A record")
    try:
        return sorted({info[4][0] for info in socket.getaddrinfo(name, None, socket.AF_INET)})
    except socket.gaierror:
        pass
    detail = f" ({failures[-1]})" if failures else ""
    raise DomainError(
        f"no A record for {name} yet{detail}; DuckDNS publishes within 60 seconds, so retry shortly"
    )


def check(domain, expect_ip=None, resolve=None, get=None):
    """Verify that domain resolves to expect_ip (or the detected public IPv4).

    A name that has no A record yet, or one pointing at another address, is an
    error: the claim may have succeeded while DNS still sends clients elsewhere.
    """
    name = normalise_domain(domain)
    resolve = resolve or resolve_a
    expected = expect_ip if expect_ip is not None else public_ipv4(get)
    try:
        address = ipaddress.ip_address(str(expected))
    except ValueError as exc:
        raise DomainError("--expect-ip must be a plain IPv4 address") from exc
    if address.version != 4 or not address.is_global:
        raise DomainError("--expect-ip must be a globally routable IPv4 address")
    addresses = list(resolve(name))
    if not addresses:
        raise DomainError(f"no A record for {name} yet; retry in a minute")
    if str(address) not in addresses:
        raise DomainError(
            f"{name} resolves to {', '.join(addresses)}, not {address}; DNS is not pointing at this host yet"
        )
    return {"domain": name, "ip": str(address), "resolved": addresses, "match": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", default="monico", help="Name prefix (default monico)")
    parser.add_argument("--ip", help="Public IPv4; detected when omitted")
    parser.add_argument("--attempts", type=int, default=5)
    parser.add_argument(
        "--check",
        metavar="DOMAIN",
        help="Verify that DOMAIN resolves to --expect-ip or the detected public IPv4",
    )
    parser.add_argument(
        "--expect-ip",
        help="Public IPv4 the --check A record must match; detected when omitted",
    )
    args = parser.parse_args()
    try:
        if args.check:
            result = check(args.check, args.expect_ip)
        else:
            token = os.environ.get("DUCKDNS_TOKEN", "")
            result = claim(token, args.ip, args.prefix, args.attempts)
    except DomainError as exc:
        print(f"Monico free domain: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
