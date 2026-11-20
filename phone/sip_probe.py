#!/usr/bin/env python3
"""Live RFC3261 UDP OPTIONS probe for a self-hosted Linux SIP server.

Adapted from the OPTIONS/registrar idea in jaykk99/Calling-linux. Unlike that
demo's implicit status flags, this requires an actual SIP response. A 200 or
401 proves a SIP endpoint responded, NOT that telephone calls, RTP media,
authentication, public DIDs, or carrier SMS actually work.

For safe deployment use a properly authenticated Asterisk/PJSIP registrar.
Calling-linux's demo REGISTER handler is unauthenticated and must not be
exposed as a public production SIP registrar.
"""
import argparse
import json
import re
import secrets
import socket
import sys
import time


HOST_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,251}\Z")
STATUS_RE = re.compile(r"^SIP/2\.0 ([1-6][0-9]{2}) ([^\r\n]{1,120})$")
CALLID_RE = re.compile(r"^Call-ID\s*:\s*(\S+)\s*$", re.IGNORECASE | re.MULTILINE)


def validate_host(host):
    if not isinstance(host, str) or not HOST_RE.fullmatch(host):
        raise ValueError("Use a numeric IPv4/hostname without a scheme or URL path")
    return host


def render_options(host, call_id, branch, contact="monico-probe"):
    host = validate_host(host)
    if not re.fullmatch(r"[a-f0-9]{24,64}", call_id):
        raise ValueError("Invalid SIP Call-ID")
    if not re.fullmatch(r"[a-f0-9]{24,64}", branch):
        raise ValueError("Invalid SIP branch")
    return (
        f"OPTIONS sip:{contact}@{host} SIP/2.0\r\n"
        f"Via: SIP/2.0/UDP 127.0.0.1:0;branch=z9hG4bK{branch}\r\n"
        f"Max-Forwards: 1\r\n"
        f"From: <sip:monico-probe@{host}>;tag={branch[:12]}\r\n"
        f"To: <sip:{contact}@{host}>\r\n"
        f"Call-ID: {call_id}\r\n"
        f"CSeq: 1 OPTIONS\r\n"
        "User-Agent: Monico-Linux-SIP-Probe/1.0\r\n"
        "Content-Length: 0\r\n\r\n"
    ).encode("ascii")


def check_sip(host, port=5060, timeout=3.0):
    host = validate_host(host)
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("Port must be between 1024 and 65535")
    if not isinstance(timeout, (int, float)) or not 0.1 <= timeout <= 10:
        raise ValueError("Timeout must be 0.1 to 10 seconds")
    call_id, branch = secrets.token_hex(20), secrets.token_hex(16)
    payload = render_options(host, call_id, branch)
    started = time.monotonic()
    report = {
        "host": host, "port": port, "sip_udp_responded": False,
        "status_code": None, "latency_ms": None,
        "authenticated_sip_registration_verified": False,
        "sip_audio_rtp_verified": False, "public_pstn_number_verified": False,
        "carrier_sms_verified": False, "note": "SIP OPTIONS reply is not proof of public telephony",
    }
    try:
        addresses = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_DGRAM)
        if not addresses:
            return report
        destination = addresses[0][4]
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(timeout)
            sock.sendto(payload, destination)
            deadline = started + timeout
            while time.monotonic() < deadline:
                try:
                    body, addr = sock.recvfrom(4096)
                except socket.timeout:
                    break
                if addr[0] != destination[0]:
                    continue
                raw = body.decode("ascii", errors="replace")
                first = raw.split("\r\n", 1)[0].strip()
                status = STATUS_RE.fullmatch(first)
                reply_call = CALLID_RE.search(raw)
                if not status or not reply_call or reply_call.group(1) != call_id:
                    continue
                report["sip_udp_responded"] = True
                report["status_code"] = int(status.group(1))
                report["latency_ms"] = round((time.monotonic() - started) * 1000, 1)
                break
    except OSError as exc:
        report["network_error"] = type(exc).__name__
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="Own Linux Asterisk/SIP host")
    parser.add_argument("--port", type=int, default=5060)
    parser.add_argument("--timeout", type=float, default=3)
    args = parser.parse_args()
    try:
        result = check_sip(args.host, args.port, args.timeout)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2))
    if not result["sip_udp_responded"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
