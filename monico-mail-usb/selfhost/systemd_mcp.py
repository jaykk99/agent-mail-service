#!/usr/bin/env python3
"""Generate an unprivileged systemd MCP service unit for native Linux.

Secrets are read from a root-owned local EnvironmentFile, NOT included in unit.
The service stays bound to 127.0.0.1. A Chromebook can still suspend Crostini.
"""
import argparse
from pathlib import Path
import re

USER_RE = re.compile(r"[a-z_][a-z0-9_-]{0,31}\Z")


def safe_path(value):
    path = Path(value).expanduser().resolve()
    if any(c in str(path) for c in ("\n", "\r", "\x00", " ")):
        raise ValueError("Systemd paths must not contain spaces or unsafe characters")
    return str(path)


def render_unit(service_user, project_dir, data_dir, env_file):
    if not USER_RE.fullmatch(service_user) or service_user == "root":
        raise ValueError("Use a dedicated unprivileged Linux user, not root")
    project = safe_path(project_dir)
    data = safe_path(data_dir)
    env = safe_path(env_file)
    return f"""# Stage only; do not enable until the secret file, mount, user and runtime exist.
[Unit]
Description=Monico Mail local MCP (per-agent identity)
Wants=network-online.target
After=network-online.target
RequiresMountsFor={data}

[Service]
Type=simple
User={service_user}
WorkingDirectory={project}
EnvironmentFile={env}
ExecStartPre=/usr/bin/test -d {data}
ExecStartPre=/usr/bin/test -w {data}
ExecStart={project}/.venv/bin/python {project}/server.py
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=60
StartLimitBurst=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths={data}
UMask=0077

[Install]
WantedBy=multi-user.target
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", required=True, help="Non-root Linux service account")
    parser.add_argument("--project", required=True, help="Path to monico-mail-usb directory")
    parser.add_argument("--data", required=True, help="USB persistent directory")
    parser.add_argument("--env-file", default="/etc/monico/monico.env",
                        help="Private root-owned environment file (not created)")
    parser.add_argument("--output", default=".generated/monico-mcp.service")
    args = parser.parse_args()
    dest = Path(args.output).expanduser().resolve()
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if dest.exists():
        parser.error("Refusing to overwrite an existing staged unit")
    dest.write_text(render_unit(args.user, args.project, args.data, args.env_file),
                    encoding="utf-8")
    dest.chmod(0o600)
    print(f"Staged systemd unit: {dest}")
    print("Not installed. Verify /etc/monico/monico.env is mode 0600 and contains")
    print("MONICO_ADMIN_KEY, MONICO_MCP_BEARER_TOKEN, MONICO_DATA and MONICO_DOMAIN.")
    print("Unit starts only after the mounted directory exists and is writable.")
    print("It cannot prevent a Chromebook/ChromeOS Linux container from suspending.")


if __name__ == "__main__":
    main()
