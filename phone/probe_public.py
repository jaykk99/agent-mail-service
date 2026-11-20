#!/usr/bin/env python3
"""Verify the Monico HTTPS gateway from ANOTHER network, not the host itself.

Requires an already running public_gateway.py server and a route from this
testing machine to it. Validates server TLS against normal trust or your
deliberately installed Monico public CA. No 'skip certificate verification'.
Does not test public SMS/PSTN/email or prove cross-NAT WebRTC audio.
"""
import argparse
from getpass import getpass
import ipaddress
import json
import ssl
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPHandler, HTTPSHandler, HTTPRedirectHandler, Request


class DenyRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_public_url(url, *, allow_loopback_for_tests=False):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Supply only a direct HTTPS URL: https://YOUR_PUBLIC_IPV4:8766")
    try:
        ip = ipaddress.ip_address(parsed.hostname)
    except ValueError as exc:
        raise ValueError("Use a public IP literal for direct-IP mode; domain setup is separate") from exc
    if ip.version != 4 or not (ip.is_global or (allow_loopback_for_tests and ip.is_loopback)):
        raise ValueError("A globally routable IPv4 address is required for public access")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid TCP port") from exc
    if not port or not 1024 <= port <= 65535:
        raise ValueError("Port must be within 1024-65535")
    return f"https://{ip}:{port}"


def _get_json(opener, url, headers=None):
    req = Request(url, headers=headers or {}, method="GET")
    try:
        with opener.open(req, timeout=8) as response:
            return response.status, json.loads(response.read(16384))
    except HTTPError as exc:
        return exc.code, json.loads(exc.read(16384))


def run_probe(url, *, ca_file=None, agent_token=None, allow_loopback_for_tests=False):
    url = validate_public_url(url, allow_loopback_for_tests=allow_loopback_for_tests)
    ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
    opener = build_opener(HTTPSHandler(context=ctx), DenyRedirects())
    status, health = _get_json(opener, url + "/health")
    if status != 200 or not health.get("ok") or health.get("agents") != 1000:
        raise RuntimeError("Monico health endpoint did not report 1,000 available agents")
    if health.get("publicNumbers") is not False:
        raise RuntimeError("Unexpected public telephone number claim")
    # Confirm protected endpoints deny anonymous users.
    denied, _ = _get_json(opener, url + "/api/me")
    if denied != 401:
        raise RuntimeError("Agent identity endpoint did not reject missing credentials")
    result = {
        "public_web_gateway_reachable_from_tester": True,
        "https_certificate_trusted_by_tester": True,
        "agent_count": health["agents"],
        "server_instance_id": health.get("instanceId"),
        "anonymous_agent_api_rejected": True,
        "internet_email_verified": False,
        "carrier_sms_or_phone_verified": False,
        "cross_nat_audio_verified": False,
        "note": "Only proves reachability from the machine/network running this test.",
    }
    if agent_token is not None:
        if not agent_token:
            raise ValueError("Cannot verify an empty agent token")
        code, identity = _get_json(opener, url + "/api/me",
                                   {"Authorization": "Bearer " + agent_token})
        if code != 200 or not identity.get("ok"):
            raise RuntimeError("Valid agent bearer was rejected")
        result["authenticated_agent"] = identity.get("extension")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="https://PUBLIC_IPV4:8766")
    parser.add_argument("--ca-cert", help="Public .crt CA certificate trusted only for Monico")
    parser.add_argument("--verify-agent", action="store_true",
                        help="Prompt securely for an agent token and verify isolation/auth")
    args = parser.parse_args()
    token = getpass("Agent API token (hidden): ") if args.verify_agent else None
    try:
        result = run_probe(args.url, ca_file=args.ca_cert, agent_token=token)
    except (ValueError, RuntimeError, OSError, URLError, ssl.SSLError, json.JSONDecodeError) as exc:
        print(f"PUBLIC ACCESS FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("Check IP ownership, router/NAT forwarding, ISP firewall and HTTPS CA trust.",
              file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
