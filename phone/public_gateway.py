#!/usr/bin/env python3
"""Public HTTPS gateway for Monico's *internal* agent messaging protocols.

No registered domain, email provider, telecom provider or hosted relay needed.
A routable public IPv4 and router/firewall route remain necessary. With own CA,
client devices must explicitly trust its CERTIFICATE; never distribute its key.
Public internet SMS/PSTN/email is not provided by this gateway.
"""
import argparse
import ipaddress
import os
from pathlib import Path
import shutil
import subprocess

from server import create_server
from usb_storage import choose_storage


def public_ipv4(raw):
    try:
        address = ipaddress.ip_address(raw)
    except (ValueError, TypeError) as exc:
        raise ValueError("Supply a globally routable IPv4 via --public-ip") from exc
    if address.version != 4 or not address.is_global:
        raise ValueError("A globally routable IPv4 is required")
    return str(address)


def check_port(port):
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("Choose a TCP port from 1024 to 65535")
    return port


def _verify_certificate(certificate, ca, ip):
    proc = subprocess.run(
        ["openssl", "verify", "-CAfile", str(ca), "-verify_ip",
         ip, str(certificate)], capture_output=True, text=True, timeout=15)
    if proc.returncode:
        raise RuntimeError("Certificate verification failed or saved certificate is for another IP")


def ensure_tls(folder, public_ip):
    ip = public_ipv4(public_ip)
    folder = Path(folder).expanduser().resolve()
    folder.mkdir(parents=True, mode=0o700, exist_ok=True)
    folder.chmod(0o700)
    if not shutil.which("openssl"):
        raise RuntimeError("Install openssl with sudo apt-get install openssl")
    ca_key = folder / "monico-ca.key"
    ca_cert = folder / "monico-ca.crt"
    server_key = folder / "server.key"
    server_cert = folder / "server.crt"
    csr = folder / "server.csr"
    ext = folder / "server.ext"
    files = (ca_key, ca_cert, server_key, server_cert)
    if all(f.is_file() for f in files):
        _verify_certificate(server_cert, ca_cert, ip)
        return ca_cert, server_cert, server_key
    if any(f.exists() for f in (*files, csr, ext)):
        raise RuntimeError("Incomplete TLS files; refusing to silently replace secrets")
    try:
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:3072", "-sha256",
            "-nodes", "-days", "365", "-subj", "/CN=Monico Agent Root CA",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign",
            "-keyout", str(ca_key), "-out", str(ca_cert)
        ], check=True, capture_output=True, timeout=60)
        subprocess.run([
            "openssl", "req", "-newkey", "rsa:3072", "-nodes",
            "-sha256", "-subj", "/CN=Monico Agent IP Gateway",
            "-keyout", str(server_key), "-out", str(csr)
        ], check=True, capture_output=True, timeout=60)
        ext.write_text(
            "basicConstraints=critical,CA:FALSE\n"
            "keyUsage=critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth\n"
            f"subjectAltName=IP:{ip},IP:127.0.0.1\n",
            encoding="utf-8"
        )
        subprocess.run([
            "openssl", "x509", "-req", "-in", str(csr),
            "-CA", str(ca_cert), "-CAkey", str(ca_key),
            "-CAcreateserial", "-out", str(server_cert), "-days", "90",
            "-sha256", "-extfile", str(ext)
        ], check=True, capture_output=True, timeout=30)
        _verify_certificate(server_cert, ca_cert, ip)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("TLS generation failed; inspect private files before retrying") from exc
    finally:
        for f in (csr, ext):
            try:
                f.unlink()
            except FileNotFoundError:
                pass
        for f in (ca_key, server_key):
            if f.is_file():
                f.chmod(0o600)
        for f in (ca_cert, server_cert):
            if f.is_file():
                f.chmod(0o644)
    return ca_cert, server_cert, server_key


def serve(public_ip, port, state_dir, ca_directory, cert=None, key=None):
    ip = public_ipv4(public_ip)
    check_port(port)
    if bool(cert) != bool(key):
        raise ValueError("Specify both existing TLS certificate and key or neither")
    if cert:
        certificate = Path(cert).expanduser().resolve()
        private = Path(key).expanduser().resolve()
        if not certificate.is_file() or not private.is_file():
            raise ValueError("Existing TLS certificate/key not found")
        ca = None
    else:
        ca, certificate, private = ensure_tls(ca_directory, ip)
    server = create_server(state_dir, count=1000, host="0.0.0.0",
                           port=port, tls_cert=str(certificate), tls_key=str(private))
    print(f"Monico public agent HTTPS: https://{ip}:{port}", flush=True)
    print("This gateway serves INTERNAL agent phone/extensions/text/email, not PSTN/SMS/MX.", flush=True)
    print("Outside-network reachability is NOT verified by local startup.", flush=True)
    if ca is not None:
        print(f"Agents must explicitly trust this PUBLIC CA CERTIFICATE: {ca}", flush=True)
        print("Never share monico-ca.key or server.key.", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--public-ip", required=True, help="Routable IPv4 of router or Linux host")
    p.add_argument("--port", type=int, default=8766)
    p.add_argument("--state-dir", help="Existing secure USB/Linux agent state")
    p.add_argument("--cert-dir", help="Private local TLS key storage")
    p.add_argument("--tls-cert", help="Existing publicly trusted IP certificate, optional")
    p.add_argument("--tls-key", help="Matching existing private key, optional")
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true", help="Create local CA and TLS cert only")
    mode.add_argument("--serve", action="store_true", help="Run public HTTPS server")
    p.add_argument("--allow-public", action="store_true",
                   help="Confirm intentionally exposing authenticated agent services")
    args = p.parse_args()
    try:
        ip = public_ipv4(args.public_ip)
        port = check_port(args.port)
        if bool(args.tls_cert) != bool(args.tls_key):
            raise ValueError("Supply both existing TLS cert and private key")
        storage = choose_storage(state_dir=args.state_dir)
        directory = Path(args.cert_dir).expanduser().resolve() if args.cert_dir else storage.path / "public-tls"
        if args.prepare:
            if args.tls_cert:
                raise ValueError("Existing certificates do not need --prepare")
            ca, cert, key = ensure_tls(directory, ip)
            print(f"Prepared: https://{ip}:{port} (NOT ONLINE)")
            print(f"Public CA certificate for agents: {ca}")
            print("Never distribute the CA key or server private key.")
        else:
            if not args.allow_public:
                raise ValueError("Explicit --allow-public is required to start internet-facing HTTPS")
            serve(ip, port, storage.path, directory, args.tls_cert, args.tls_key)
    except (ValueError, OSError, RuntimeError) as exc:
        p.error(str(exc))


if __name__ == "__main__":
    main()
