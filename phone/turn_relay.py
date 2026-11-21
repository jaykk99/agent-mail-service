#!/usr/bin/env python3
"""Own-Linux Coturn relay configuration and temporary WebRTC credentials.

No external STUN/TURN API. Coturn itself must be installed on your Linux
machine and UDP/TCP ports reachable. TURN relay CANNOT create PSTN numbers.
"""
import argparse
import base64
import hashlib
import hmac
import ipaddress
import os
from pathlib import Path
import re
import time


def public_ip(value):
    try:
        addr = ipaddress.ip_address(value)
    except (ValueError, TypeError) as exc:
        raise ValueError("Set PHONE_TURN_IP to a routable public IPv4") from exc
    if addr.version != 4 or not addr.is_global:
        raise ValueError("PHONE_TURN_IP must be a publicly routable IPv4")
    return str(addr)


def make_ice_credentials(identity, secret, ip, port=3478, ttl=3600, now=None):
    if not isinstance(identity, str) or not re.fullmatch(r"[a-zA-Z0-9:_-]{1,100}", identity):
        raise ValueError("Invalid authenticated TURN principal")
    if not isinstance(secret, str) or len(secret) < 32 or "\n" in secret or "\r" in secret:
        raise ValueError("TURN shared secret must be high entropy and at least 32 characters")
    ip = public_ip(ip)
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("Invalid TURN listening port")
    if not isinstance(ttl, int) or not 300 <= ttl <= 7200:
        raise ValueError("TURN TTL must be 300-7200 seconds")
    expiry = int(time.time() if now is None else now) + ttl
    username = f"{expiry}:{identity}"
    credential = base64.b64encode(
        hmac.new(secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1).digest()
    ).decode("ascii")
    return {"iceServers": [{
        "urls": [f"turn:{ip}:{port}?transport=udp",
                 f"turn:{ip}:{port}?transport=tcp"],
        "username": username,
        "credential": credential,
    }], "turnConfigured": True, "expiresAt": expiry}


def client_ice_config(identity):
    secret = os.environ.get("PHONE_TURN_SECRET", "")
    ip = os.environ.get("PHONE_TURN_IP", "")
    if not secret and not ip:
        return {"iceServers": [], "turnConfigured": False}
    if not secret or not ip:
        raise ValueError("Both PHONE_TURN_SECRET and PHONE_TURN_IP are required")
    port = int(os.environ.get("PHONE_TURN_PORT", "3478"))
    return make_ice_credentials(identity, secret, ip, port=port)


def render_coturn(public_ip_address, secret, local_ip=None, port=3478):
    ip = public_ip(public_ip_address)
    if not isinstance(secret, str) or len(secret) < 32 or not re.fullmatch(r"[A-Za-z0-9_-]+", secret):
        raise ValueError("Use a random alphanumeric or URL-safe TURN secret of >=32 characters")
    if not 1024 <= port <= 65535:
        raise ValueError("Invalid TURN server port")
    external = ip
    if local_ip:
        local = ipaddress.ip_address(local_ip)
        if local.version != 4 or not local.is_private:
            raise ValueError("Use LAN IPv4 for behind-NAT local TURN interface")
        external += "/" + str(local)
    return (
        "# MONICO SELF-HOSTED TURN - STAGED ONLY. Contains secret: chmod 0600.\n"
        "fingerprint\n"
        "use-auth-secret\n"
        f"static-auth-secret={secret}\n"
        "realm=monico.internal\n"
        f"listening-port={port}\n"
        f"external-ip={external}\n"
        "no-loopback-peers\n"
        "no-multicast-peers\n"
        "no-cli\n"
        "no-tls\n"
        "no-dtls\n"
        "user-quota=4\n"
        "total-quota=1200\n"
        "min-port=49160\n"
        "max-port=65535\n"
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--public-ip", required=True, help="Your reachable public IPv4 for TURN")
    p.add_argument("--local-ip", help="Private LAN IPv4 of TURN host if behind NAT")
    p.add_argument("--port", type=int, default=3478)
    p.add_argument("--output", default=".generated/turnserver.conf")
    args = p.parse_args()
    import secrets
    secret = os.environ.get("PHONE_TURN_SECRET", "") or secrets.token_urlsafe(36)
    try:
        contents = render_coturn(args.public_ip, secret, args.local_ip, args.port)
    except (ValueError, TypeError) as exc:
        p.error(str(exc))
    file = Path(args.output).expanduser().resolve()
    file.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if file.exists():
        p.error("Existing TURN config found; refusing to overwrite its secret")
    file.write_text(contents, encoding="utf-8")
    file.chmod(0o600)
    print(f"Staged private Coturn config: {file}. Does not install or start TURN.")
    print("Export PHONE_TURN_IP and PHONE_TURN_SECRET in the Monico server environment.")
    print("Forward TURN UDP/TCP port and UDP relay ports 49160–65535 to THIS Linux host.")
    print("TURN relays WebRTC audio ONLY. Not phone carrier traffic.")


if __name__ == "__main__":
    main()
