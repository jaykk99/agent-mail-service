#!/usr/bin/env python3
"""Install an optional user-systemd service supervising local Monico.

No root, no cloud platform, no secrets in the service unit. This requires
working systemd --user on the Linux host and dependencies already installed.
Crostini can still suspend/stop the Linux VM regardless of systemd settings.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SERVICE_NAME = "monico-agent.service"


def _quote(value):
    """systemd ExecStart double quoted argument with specifier safety."""
    value = str(value)
    if any(c in value for c in ("\x00", "\n", "\r")):
        raise ValueError("Invalid newline/null in service argument")
    return '"' + value.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_service(python_path, repo, state_dir=None, public_ip=None, allow_public=False):
    if bool(public_ip) != bool(allow_public):
        raise ValueError("Public autostart requires both public-ip and allow-public")
    python_path = Path(python_path).resolve(strict=True)
    repo = Path(repo).resolve(strict=True)
    if not (repo / "start.sh").is_file() or not (repo / "linux" / "watchdog.py").is_file():
        raise ValueError("Full Monico repository is required")
    cmd = [
        str(python_path), str(repo / "linux" / "watchdog.py"),
        "--interval", "60",
    ]
    if state_dir:
        state_dir = Path(state_dir).expanduser().resolve(strict=True)
        if not state_dir.is_dir():
            raise ValueError("Configured private state storage must be an existing directory")
        cmd.extend(["--state-dir", str(state_dir)])
    if public_ip:
        # This must be a real operator-provided routable address, never inferred.
        from ipaddress import ip_address
        ip = ip_address(public_ip)
        if ip.version != 4 or not ip.is_global:
            raise ValueError("Use an assigned, routable IPv4 for optional HTTPS")
        cmd.extend(["--public-ip", str(ip), "--allow-public"])
    return (
        "[Unit]\n"
        "Description=Monico local agent services watchdog\n"
        "After=network-online.target\n"
        "Wants=network-online.target\n"
        "StartLimitIntervalSec=300\n"
        "StartLimitBurst=5\n\n"
        "[Service]\n"
        "Type=simple\n"
        "WorkingDirectory=" + _quote(repo) + "\n"
        "ExecStart=" + " ".join(_quote(arg) for arg in cmd) + "\n"
        "Restart=on-failure\n"
        "RestartSec=15\n"
        "NoNewPrivileges=yes\n"
        "UMask=0077\n\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )


def install_service(content, home=None, enable=False):
    home = Path(home or Path.home()).expanduser().resolve()
    folder = home / ".config" / "systemd" / "user"
    path = folder / SERVICE_NAME
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        old = path.read_text(encoding="utf-8")
        if old != content:
            raise FileExistsError(
                f"{path} exists with different settings; disable/review it before replacement")
    else:
        # Exclusive creation avoids overwriting existing user-managed service.
        with path.open("x", encoding="utf-8") as stream:
            stream.write(content)
        path.chmod(0o600)
    if enable:
        if not shutil.which("systemctl"):
            raise RuntimeError("systemctl is unavailable; unit was saved but not enabled")
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, timeout=20)
        subprocess.run(["systemctl", "--user", "enable", "--now", SERVICE_NAME],
                       check=True, timeout=30)
    return str(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", help="Existing private USB storage directory")
    parser.add_argument("--public-ip", help="Your actual public IPv4 for HTTPS")
    parser.add_argument("--allow-public", action="store_true")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print unit without modifying Linux service settings")
    parser.add_argument("--enable", action="store_true",
                        help="Ask local user systemd to enable and start this service")
    args = parser.parse_args()
    try:
        unit = render_service(sys.executable, ROOT, args.state_dir,
                              args.public_ip, args.allow_public)
        if args.dry_run:
            print(unit)
        else:
            path = install_service(unit, enable=args.enable)
            print(f"User systemd unit: {path}")
            if args.enable:
                print("Enabled on this Linux user's systemd instance.")
            else:
                print("Staged only. Run again with --enable to start it.")
            print("A Chromebook can still suspend its Linux VM.")
            print("For boot without login, systemd lingering must be configured separately.")
            print("Public email and phone carrier connectivity are NOT enabled.")
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as exc:
        parser.exit(1, f"Monico autostart: {type(exc).__name__}: {exc}\n")


if __name__ == "__main__":
    main()
