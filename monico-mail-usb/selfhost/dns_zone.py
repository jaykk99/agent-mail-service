#!/usr/bin/env python3
"""Generate authoritative BIND9 DNS zone files for SELF-HOSTED Monico mail.

You must still have a real delegated domain and routable public IP. This tool
does not register names, set parent-zone glue, configure reverse DNS, open ports,
or perform an unsafe automatic system-wide DNS change.
"""
import argparse
import datetime
import ipaddress
import os
from pathlib import Path
import re

try:
    from .generate_config import check_domain
except ImportError:
    from generate_config import check_domain

_DKIM_KEY = re.compile(r"[A-Za-z0-9+/=]{100,800}\Z")


def public_ipv4(value):
    addr = ipaddress.ip_address(value)
    if addr.version != 4 or not addr.is_global:
        raise ValueError("Use a globally routable public IPv4 address, not an RFC1918/LAN IP")
    return str(addr)


def read_opendkim_public_txt(path):
    """Extract only the base64 DKIM public p= key from opendkim-genkey TXT output."""
    content = Path(path).read_text(encoding="utf-8")
    if "PRIVATE KEY" in content or len(content) > 20000:
        raise ValueError("Use the OpenDKIM PUBLIC mail.txt file; never a private key")
    quoted = re.findall(r'"([^"]*)"', content)
    merged = "".join(quoted)
    if not merged.startswith("v=DKIM1;"):
        raise ValueError("Invalid OpenDKIM public TXT file")
    match = re.search(r"(?:^|;)\s*p=([A-Za-z0-9+/=]+)", merged)
    if not match or not _DKIM_KEY.fullmatch(match.group(1)):
        raise ValueError("Invalid OpenDKIM public DKIM key")
    return match.group(1)


def public_ipv6(value):
    addr = ipaddress.ip_address(value)
    if addr.version != 6 or not addr.is_global:
        raise ValueError("Use a globally routable public IPv6 address, not a link-local or ULA address")
    return str(addr)


def zone_text(domain, mail_ip, ns1_ip, ns2_ip, dkim_key=None, serial=None,
              mail_ipv6=None, ns1_ipv6=None, ns2_ipv6=None):
    domain = check_domain(domain)
    mail_ip = public_ipv4(mail_ip) if mail_ip else None
    ns1_ip = public_ipv4(ns1_ip) if ns1_ip else None
    ns2_ip = public_ipv4(ns2_ip) if ns2_ip else None
    mail_ipv6 = public_ipv6(mail_ipv6) if mail_ipv6 else None
    ns1_ipv6 = public_ipv6(ns1_ipv6) if ns1_ipv6 else None
    ns2_ipv6 = public_ipv6(ns2_ipv6) if ns2_ipv6 else None
    if not mail_ip and not mail_ipv6:
        raise ValueError("Mail host requires a public IPv4 or IPv6 address")
    if not (ns1_ip or ns1_ipv6) or not (ns2_ip or ns2_ipv6):
        raise ValueError("Each authoritative nameserver needs a public IPv4 or IPv6 address")
    if dkim_key is not None and not _DKIM_KEY.fullmatch(dkim_key):
        raise ValueError("DKIM key must contain only base64 public-key characters")
    serial = serial if serial is not None else int(
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d01")
    )
    if not isinstance(serial, int) or not 2020010100 <= serial <= 9999123199:
        raise ValueError("SOA serial must be a ten-digit increasing YYYYMMDDNN number")

    host_addresses = []
    for name, address4, address6 in (
        ("ns1", ns1_ip, ns1_ipv6),
        ("ns2", ns2_ip, ns2_ipv6),
        ("mail", mail_ip, mail_ipv6),
        ("mcp", mail_ip, mail_ipv6),
    ):
        if address4:
            host_addresses.append(f"{name:<8}IN A  {address4}")
        if address6:
            host_addresses.append(f"{name:<8}IN AAAA  {address6}")

    lines = [
        "$TTL 3600",
        f"$ORIGIN {domain}.",
        f"@  IN SOA ns1.{domain}. hostmaster.{domain}. (",
        f"      {serial} ; serial (increment for every zone update)",
        "      3600 ; refresh",
        "      900  ; retry",
        "      1209600 ; expire",
        "      300  ; negative cache",
        ")",
        f"@      IN NS ns1.{domain}.",
        f"@      IN NS ns2.{domain}.",
        *host_addresses,
        f"@      IN MX 10 mail.{domain}.",
        '@      IN TXT "v=spf1 mx -all"',
        '_dmarc IN TXT "v=DMARC1; p=none; adkim=s; aspf=s"',
    ]
    if dkim_key:
        # DNS character-string segments must not exceed 255 octets.
        value = "v=DKIM1; k=rsa; p=" + dkim_key
        segments = [value[i:i+200] for i in range(0, len(value), 200)]
        lines.append("mail._domainkey IN TXT (" + " ".join(f'"{seg}"' for seg in segments) + ")")
    else:
        lines.append("; TODO: Add mail._domainkey IN TXT after generating the OpenDKIM RSA key")
    lines.extend([
        "; IMPORTANT: The parent zone must delegate this domain to ns1/ns2.",
        "; Nameserver GLUE is needed at the parent for in-zone nameservers.",
        "; Reverse DNS (PTR) for the sending public IP must be set by the address owner.",
        "; The DKIM record alone DOES NOT enable DKIM signing on Postfix.",
    ])
    return "\n".join(lines) + "\n"


def named_config(domain, zone_file):
    domain = check_domain(domain)
    path = Path(zone_file).resolve()
    if any(x in str(path) for x in ('"', "\n", "\r", "\x00")):
        raise ValueError("Invalid BIND zone file path")
    return f'zone "{domain}" {{\n  type primary;\n  file "{path}";\n  allow-update {{ none; }};\n}};\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--public-ip", help="Mail A record public IPv4 (optional with IPv6)")
    parser.add_argument("--public-ipv6", help="Mail AAAA record public IPv6")
    parser.add_argument("--ns1-ip", help="A record for authoritative ns1")
    parser.add_argument("--ns2-ip", help="A record for authoritative ns2")
    parser.add_argument("--ns1-ipv6", help="AAAA record for authoritative ns1")
    parser.add_argument("--ns2-ipv6", help="AAAA record for authoritative ns2")
    dkim = parser.add_mutually_exclusive_group()
    dkim.add_argument("--dkim-public-key", help="Public base64 DKIM p= key (never private key)")
    dkim.add_argument("--dkim-txt-file", help="Read the public OpenDKIM mail.txt record safely")
    parser.add_argument("--output", default=".generated/dns")
    args = parser.parse_args()

    domain = check_domain(args.domain)
    destination = Path(args.output).resolve()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    zone_path = destination / ("db." + domain)
    conf_path = destination / "named.conf.monico"
    dkim_key = (read_opendkim_public_txt(args.dkim_txt_file)
                if args.dkim_txt_file else args.dkim_public_key)
    zone = zone_text(domain, args.public_ip, args.ns1_ip, args.ns2_ip,
                     dkim_key, mail_ipv6=args.public_ipv6,
                     ns1_ipv6=args.ns1_ipv6, ns2_ipv6=args.ns2_ipv6)
    zone_path.write_text(zone, encoding="utf-8")
    conf_path.write_text(named_config(domain, zone_path), encoding="utf-8")
    os.chmod(zone_path, 0o600)
    os.chmod(conf_path, 0o600)
    print(f"BIND zone (not installed): {zone_path}")
    print(f"BIND config (not installed): {conf_path}")
    if ((args.ns1_ip and args.ns1_ip == args.ns2_ip)
            or (args.ns1_ipv6 and args.ns1_ipv6 == args.ns2_ipv6)):
        print("WARNING: Both nameservers share one IP. That is a single point of failure.")
    print("Check: named-checkzone " + domain + " " + str(zone_path))
    print("Public email still requires parent NS delegation/glue, PTR, and a reachable public TCP/25 server.")


if __name__ == "__main__":
    main()
