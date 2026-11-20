#!/usr/bin/env python3
"""Prepare Tor v3 Onion Service routing to the local authenticated agent server.

No paid domain, public IP, inbound forwarded port, telecom provider or cloud
account is needed. REQUIRES Tor's public volunteer network and Tor-capable
clients; it is not ordinary public phone/SMS/email routing.

This script only stages a local torrc snippet, never installs or starts Tor.
"""
import argparse
from pathlib import Path
import re

SAFE_PATH = re.compile(r"/[A-Za-z0-9._/-]+\Z")


def render_hidden_service(directory="/var/lib/tor/monico-agents",
                          virtual_port=80, local_port=8765):
    directory = str(Path(directory).expanduser())
    if not SAFE_PATH.fullmatch(directory) or ".." in Path(directory).parts:
        raise ValueError("HiddenServiceDir must be a safe absolute path with no spaces or traversal")
    if not 1 <= virtual_port <= 65535:
        raise ValueError("Invalid onion virtual port")
    if not 1024 <= local_port <= 65535:
        raise ValueError("Local authenticated agent port must be unprivileged")
    if virtual_port not in (80, 443):
        raise ValueError("Use virtual port 80 (onion HTTP) or 443 (onion HTTPS)")
    return (
        "# Monico agent messaging over the public Tor onion network.\n"
        "# STAGED only: no Tor daemon, onion address, or external reachability yet.\n"
        "# Keep the HTTP service bound to 127.0.0.1; Tor provides onion encryption.\n"
        f"HiddenServiceDir {directory}\n"
        "HiddenServiceVersion 3\n"
        f"HiddenServicePort {virtual_port} 127.0.0.1:{local_port}\n"
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--hidden-service-dir", default="/var/lib/tor/monico-agents",
                   help="Path that Tor daemon can securely own")
    p.add_argument("--local-port", type=int, default=8765,
                   help="Existing localhost-only Monico phone server")
    p.add_argument("--output", default=".generated/torrc.monico",
                   help="Review-only Tor configuration snippet")
    args = p.parse_args()
    try:
        snippet = render_hidden_service(args.hidden_service_dir, 80, args.local_port)
    except ValueError as exc:
        p.error(str(exc))
    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists():
        p.error("Refusing to overwrite existing staged Tor config")
    destination.write_text(snippet, encoding="utf-8")
    destination.chmod(0o600)
    print(f"Tor onion config STAGED (not installed): {destination}")
    print("Tor must be installed and the snippet reviewed/added to torrc by the host administrator.")
    print(f"After Tor starts, read {args.hidden_service_dir}/hostname for the public .onion address.")
    print("Only Tor-capable clients can access that address; there is NO normal DNS/SMS/PSTN/MX routing.")
    print("Public availability depends on Tor volunteer relays, an external network.")


if __name__ == "__main__":
    main()
