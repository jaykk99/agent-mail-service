#!/usr/bin/env python3
"""Opt-in public HTTPS launcher for Monico browser communications on Linux.

Requires an existing, pinned private agent state and a public routable IPv4
address controlled by the operator. Does not obtain a public IP, change NAT,
open firewalls, verify public reachability, or enable external SMTP/PSTN/SMS.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
PHONE = ROOT / "phone"
sys.path.insert(0, str(PHONE))

from public_gateway import ensure_tls, public_ipv4, check_port
from probe_public import run_probe
from start import expected_instance
from usb_storage import choose_storage

SCHEMA = 1
TIMEOUT = 15


def _paths(state):
    return (state / "public-gateway.json", state / "public-gateway.pid",
            state / "public-gateway.log", state / "public-tls")


def _read_config(state):
    cfg, _, _, tls = _paths(state)
    if not cfg.exists():
        return None
    if cfg.stat().st_mode & 0o077:
        raise RuntimeError("Public gateway config must have private file permissions (0600)")
    data = json.loads(cfg.read_text(encoding="utf-8"))
    if data.get("schema") != SCHEMA or data.get("state") != str(state):
        raise RuntimeError("Public gateway config belongs to another storage directory")
    if data.get("public_ip") != public_ipv4(data.get("public_ip")):
        raise RuntimeError("Invalid stored public IP address")
    check_port(data.get("port"))
    if data.get("cert_dir") != str(tls):
        raise RuntimeError("Unexpected public TLS directory")
    return data


def prepare(state, ip, port):
    state = Path(state).resolve()
    if not (state / "identities.json").is_file() or expected_instance(state) is None:
        raise RuntimeError("Start your local Monico agent server before preparing the public gateway")
    ip, port = public_ipv4(ip), check_port(port)
    saved = _read_config(state)
    if saved is not None:
        if saved["public_ip"] != ip or saved["port"] != port:
            raise RuntimeError("Existing gateway uses a different IP/port; refusing silent TLS identity change")
    cfg, _, _, tls = _paths(state)
    ca, certificate, key = ensure_tls(tls, ip)
    if saved is None:
        data = {"schema": SCHEMA, "state": str(state), "public_ip": ip,
                "port": port, "cert_dir": str(tls)}
        fd, tmp = tempfile.mkstemp(prefix=".gateway-", dir=state)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump(data, out, indent=2)
                out.write("\n")
            os.chmod(tmp, 0o600)
            os.link(tmp, cfg)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return {"https_url": f"https://{ip}:{port}", "public_ca_certificate": str(ca),
            "configured": True, "serving": False, "internet_reachable_verified": False,
            "cert_expires": "Verify TLS certificate validity and renew before expiration"}


def _read_pid(path):
    try:
        pid = int(path.read_text(encoding="utf-8").strip())
        return pid if pid > 1 else None
    except (OSError, ValueError):
        return None


def _pid_matches(pid):
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        return str((PHONE / "public_gateway.py").resolve()).encode("utf-8") in cmdline
    except (OSError, ValueError, PermissionError):
        return False


def _port_occupied(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _verified_local(state, config):
    pid_file = _paths(state)[1]
    pid = _read_pid(pid_file)
    if not _pid_matches(pid):
        return False
    if not _port_occupied(config["port"]):
        return False
    try:
        result = run_probe(f"https://127.0.0.1:{config['port']}",
                           ca_file=str(_paths(state)[3] / "monico-ca.crt"),
                           allow_loopback_for_tests=True)
        return result.get("server_instance_id") == expected_instance(state)
    except (OSError, ValueError, RuntimeError, ssl.SSLError):
        return False


def status(state):
    config = _read_config(state)
    if config is None:
        return {"prepared": False, "local_https_running": False,
                "outside_network_verified": False,
                "external_smtp_verified": False, "carrier_phone_sms_verified": False}
    return {"prepared": True, "https_url": f"https://{config['public_ip']}:{config['port']}",
            "local_https_running": _verified_local(state, config),
            "outside_network_verified": False, "external_smtp_verified": False,
            "carrier_phone_sms_verified": False,
            "public_ca_certificate": str(_paths(state)[3] / "monico-ca.crt")}


def start(state, allow_public):
    if not allow_public:
        raise ValueError("--allow-public is required; this deliberately binds HTTPS to every interface")
    config = _read_config(state)
    if config is None:
        raise RuntimeError("Prepare the public gateway first with --public-ip on the host you control")
    _, pid_file, log_file, tls = _paths(state)
    if _verified_local(state, config):
        return {"already_running": True, **status(state)}
    old_pid = _read_pid(pid_file)
    if _pid_matches(old_pid):
        raise RuntimeError("Saved public server process exists but failed health check; refusing duplicate")
    if _port_occupied(config["port"]):
        raise RuntimeError("Public HTTPS port occupied by another process")
    ensure_tls(tls, config["public_ip"])
    args = [sys.executable, str(PHONE / "public_gateway.py"), "--public-ip",
            config["public_ip"], "--port", str(config["port"]), "--state-dir",
            str(state), "--cert-dir", str(tls), "--serve", "--allow-public"]
    with log_file.open("ab") as stream:
        os.chmod(log_file, 0o600)
        process = subprocess.Popen(args, cwd=str(ROOT), stdin=subprocess.DEVNULL,
                                   stdout=stream, stderr=stream, start_new_session=True)
    try:
        fd, temp_path = tempfile.mkstemp(prefix=".public-pid-", dir=state)
        try:
            with os.fdopen(fd, "w") as out:
                out.write(str(process.pid) + "\n")
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, pid_file)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Public gateway exited early; inspect {log_file}")
            if _verified_local(state, config):
                return {"already_running": False, **status(state)}
            time.sleep(0.2)
        raise RuntimeError(f"Public gateway not healthy after startup; inspect {log_file}")
    except Exception:
        if process.poll() is None:
            process.terminate()
        pid_file.unlink(missing_ok=True)
        raise


def stop(state):
    _, pid_file, _, _ = _paths(state)
    pid = _read_pid(pid_file)
    if not _pid_matches(pid):
        pid_file.unlink(missing_ok=True)
        return "not running"
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if not _pid_matches(pid):
            pid_file.unlink(missing_ok=True)
            return "stopped"
        time.sleep(0.15)
    raise RuntimeError("Public gateway process did not exit; inspect it manually")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "up", "status", "doctor", "stop"))
    parser.add_argument("--state-dir", help="Existing pinned private Monico storage")
    parser.add_argument("--public-ip", help="Globally routable IPv4 controlled by you")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--allow-public", action="store_true",
                        help="Explicitly allow HTTPS binding to 0.0.0.0 on the Linux host")
    args = parser.parse_args()
    try:
        state = choose_storage(state_dir=args.state_dir).path
        if args.command == "prepare":
            if not args.public_ip:
                raise ValueError("--public-ip is required for HTTPS identity preparation")
            result = prepare(state, args.public_ip, args.port)
        elif args.command == "up":
            result = start(state, args.allow_public)
        elif args.command == "stop":
            result = {"result": stop(state)}
        else:
            result = status(state)
            if args.command == "doctor":
                result["external_test_command"] = (
                    "Run on a DIFFERENT internet connection: python3 phone/probe_public.py "
                    f"--url {result['https_url']} --ca-cert /path/to/monico-ca.crt"
                    if result.get("prepared") else "Prepare with --public-ip first")
                result["network_note"] = (
                    "Local HTTPS health is NOT proof that the router/ISP permits incoming connections"
                )
        print(json.dumps(result, indent=2))
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError,
            json.JSONDecodeError, ssl.SSLError) as exc:
        parser.exit(1, f"Monico public gateway: {type(exc).__name__}: {exc}\n")


if __name__ == "__main__":
    main()
