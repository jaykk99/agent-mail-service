#!/usr/bin/env python3
"""Keep the local Monico Linux services healthy under a user systemd unit.

Run this through linux/enable_autostart.sh after installing the dependencies.
No paid services and no external email/telephone claims. Public HTTPS requires
an explicit --public-ip and --allow-public opt-in at setup.
"""
import argparse
import json
import signal
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
START = ROOT / "start.sh"
STOP = threading.Event()


def _terminate(*_):
    STOP.set()


def command_args(state_dir=None, public_ip=None, allow_public=False):
    if bool(public_ip) != bool(allow_public):
        raise ValueError("Public HTTPS autostart requires BOTH --public-ip and --allow-public")
    cmd = ["bash", str(START), "--full", "up"]
    if state_dir:
        cmd.extend(["--state-dir", str(Path(state_dir).resolve())])
    if public_ip:
        cmd.extend(["--public-ip", public_ip, "--allow-public"])
    return cmd


def _status_args(state_dir=None):
    cmd = ["bash", str(START), "--full", "status"]
    if state_dir:
        cmd.extend(["--state-dir", str(Path(state_dir).resolve())])
    return cmd


def _stop_args(state_dir=None):
    cmd = ["bash", str(START), "--full", "stop"]
    if state_dir:
        cmd.extend(["--state-dir", str(Path(state_dir).resolve())])
    return cmd


def healthy(status, want_public=False):
    if not isinstance(status, dict):
        return False
    if not status.get("phone_online_local") or not status.get("mcp_online_local"):
        return False
    if want_public and not status.get("public_browser_gateway", {}).get("local_https_running"):
        return False
    return True


def inspect(state_dir=None):
    result = subprocess.run(_status_args(state_dir), cwd=ROOT,
                            capture_output=True, text=True, timeout=25)
    if result.returncode:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def run(state_dir=None, public_ip=None, allow_public=False, interval=60):
    cmd = command_args(state_dir, public_ip, allow_public)
    if not 10 <= interval <= 3600:
        raise ValueError("Monitoring interval must be 10–3600 seconds")
    print("Monico Linux watchdog: managing local services", flush=True)
    if public_ip:
        print("Public browser HTTPS explicitly enabled; outside reachability still unverified",
              flush=True)
    failures = 0
    while not STOP.is_set():
        try:
            status = inspect(state_dir)
            if not healthy(status, want_public=bool(public_ip)):
                started = subprocess.run(cmd, cwd=ROOT,
                                         capture_output=True, text=True, timeout=120)
                if started.returncode:
                    failures += 1
                    print(f"Monico startup failed (attempt {failures}): "
                          f"{started.stderr.strip()[-500:]}", file=sys.stderr, flush=True)
                else:
                    failures = 0
                    print("Local Monico services started or recovered", flush=True)
            else:
                failures = 0
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            failures += 1
            print(f"Monico monitor error: {type(exc).__name__}; failures={failures}",
                  file=sys.stderr, flush=True)
        STOP.wait(interval)
    print("Monico watchdog stopping", flush=True)
    try:
        ended = subprocess.run(_stop_args(state_dir), cwd=ROOT,
                               capture_output=True, text=True, timeout=30)
        if ended.returncode:
            print("Monico shutdown needs inspection: " + ended.stderr.strip()[-500:],
                  file=sys.stderr, flush=True)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"Monico shutdown error: {type(exc).__name__}", file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", help="Existing private USB/Linux storage; must match initial launch")
    parser.add_argument("--public-ip", help="Public IPv4 that belongs to this host/router")
    parser.add_argument("--allow-public", action="store_true",
                        help="Opt into opening the HTTPS browser gateway at boot")
    parser.add_argument("--interval", type=int, default=60)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGINT, _terminate)
    try:
        run(args.state_dir, args.public_ip, args.allow_public, args.interval)
    except ValueError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
