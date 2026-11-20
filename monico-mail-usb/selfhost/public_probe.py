#!/usr/bin/env python3
"""External network probe for an actual self-hosted Monico email deployment.

Run this FROM A DIFFERENT NETWORK, not the mail server itself. No passwords,
no third-party mailbox account, and no test messages sent. This can establish
public-network reachability and TLS, but NEVER prove actual email delivery.
"""
import argparse
import http.client
import json
import shutil
import smtplib
import socket
import ssl
import subprocess
import sys

try:
    from .generate_config import check_domain
except ImportError:
    from generate_config import check_domain


def _dig(kind, name):
    cmd = shutil.which("dig")
    if not cmd:
        raise RuntimeError("Install dnsutils to run dig on this Linux test machine")
    output = subprocess.run([cmd, "+time=3", "+tries=1", "+short", kind, name],
                            capture_output=True, text=True, timeout=8)
    if output.returncode != 0:
        raise RuntimeError(output.stderr.strip() or "dig lookup failed")
    return [line.strip() for line in output.stdout.splitlines() if line.strip()]


def _probe(name, callback, checks, required=True):
    try:
        detail = callback()
        checks.append({"test": name, "passed": True, "detail": str(detail),
                       "required_for_network_probe": required})
    except (OSError, ValueError, RuntimeError, ssl.SSLError,
            smtplib.SMTPException, TimeoutError, subprocess.SubprocessError) as error:
        checks.append({"test": name, "passed": False,
                       "detail": f"{type(error).__name__}: {error}",
                       "required_for_network_probe": required})


def check_public_endpoint(domain, timeout=6, check_mcp=True):
    domain = check_domain(domain)
    if not 1 <= timeout <= 30:
        raise ValueError("Timeout must be between 1 and 30 seconds")
    host = "mail." + domain
    checks = []

    def ns_lookup():
        entries = _dig("NS", domain)
        if not entries:
            raise RuntimeError("No public delegated NS records resolved")
        return "NS " + ", ".join(entries)

    def mx_lookup():
        entries = _dig("MX", domain)
        # One or more MX records must point at this owned mail host.
        mx_hosts = [line.split()[-1].lower().rstrip(".") for line in entries]
        if host not in mx_hosts:
            raise RuntimeError("Public MX does not point to " + host)
        return "MX " + ", ".join(entries)

    def address_lookup():
        entries4 = _dig("A", host)
        entries6 = _dig("AAAA", host)
        import ipaddress
        routable = []
        for value in entries4 + entries6:
            try:
                ip = ipaddress.ip_address(value)
                if ip.is_global:
                    routable.append(str(ip))
            except ValueError:
                continue
        if not routable:
            raise RuntimeError("Mail host has no globally routable A or AAAA records")
        return "public addresses: " + ", ".join(routable)

    def smtp_25():
        with socket.create_connection((host, 25), timeout=timeout) as connection:
            connection.settimeout(timeout)
            line = connection.recv(512)
            if not line.startswith(b"220 "):
                raise RuntimeError("SMTP server did not present a 220 greeting")
            return "TCP/25 accessible; SMTP 220 banner observed"

    def smtp_submission_tls():
        with smtplib.SMTP(host, 587, timeout=timeout) as client:
            client.ehlo()
            if not client.has_extn("starttls"):
                raise RuntimeError("Port 587 did not advertise STARTTLS")
            client.starttls(context=ssl.create_default_context())
            client.ehlo()
            return "TCP/587 STARTTLS with trusted certificate accepted"

    def imap_tls():
        with socket.create_connection((host, 993), timeout=timeout) as conn:
            with ssl.create_default_context().wrap_socket(conn, server_hostname=host) as secured:
                banner = secured.recv(512)
                if b"OK" not in banner.upper():
                    raise RuntimeError("IMAPS did not return an OK greeting")
                return "TCP/993 IMAPS TLS certificate and greeting accepted"

    def mcp_tls():
        name = "mcp." + domain
        conn = http.client.HTTPSConnection(name, 443, timeout=timeout,
                                          context=ssl.create_default_context())
        try:
            conn.request("GET", "/mcp")
            response = conn.getresponse()
            if response.status not in (200, 400, 401, 403, 405, 406):
                raise RuntimeError(f"MCP HTTPS endpoint returned {response.status}")
            return f"Public MCP HTTPS responds (HTTP {response.status}; no agent token sent)"
        finally:
            conn.close()

    _probe("dns-ns", ns_lookup, checks)
    _probe("dns-mx", mx_lookup, checks)
    _probe("dns-mail-address", address_lookup, checks)
    _probe("inbound-smtp-tcp25", smtp_25, checks)
    _probe("submission-starttls-587", smtp_submission_tls, checks)
    _probe("imap-tls-993", imap_tls, checks)
    if check_mcp:
        _probe("mcp-https-443", mcp_tls, checks, required=False)
    passes = all(check["passed"] for check in checks if check["required_for_network_probe"])
    return {
        "domain": domain,
        "mail_host": host,
        "public_network_checks_passed": passes,
        "actual_internet_email_delivery_tested": False,
        "run_from": "A genuinely outside network is needed to validate public reachability",
        "checks": checks,
        "next": ("Perform an authenticated send and receive with an independent real mail system. "
                 "A probe alone cannot prove end-to-end internet email delivery.")
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True, help="Actually delegated domain")
    parser.add_argument("--timeout", type=int, default=6)
    parser.add_argument("--skip-mcp", action="store_true",
                        help="Check public email only; skip optional MCP HTTPS check")
    args = parser.parse_args()
    try:
        result = check_public_endpoint(args.domain, args.timeout, not args.skip_mcp)
    except (ValueError, RuntimeError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["public_network_checks_passed"] else 1)


if __name__ == "__main__":
    main()
