#!/usr/bin/env python3
"""One Linux launcher for Monico agent phone + named local mailbox MCP.

Usage from repository root:
  bash start.sh --full up --install
  bash start.sh --full status
  bash start.sh --full doctor
  bash start.sh --full invites --count 5
  bash start.sh --full claim --name research
  bash start.sh --full stop

Public SMTP/DNS/PSTN are NOT enabled by this local supervisor.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
PHONE = ROOT / "phone"
MAIL = ROOT / "monico-mail-usb"
# phone/ must take precedence for plain `import server` in phone/start.py.
# monico-mail-usb/server.py has a different runtime and requires FastMCP.
for item in (str(MAIL), str(PHONE), str(ROOT / "linux")):
    if item not in sys.path:
        sys.path.insert(0, item)

from usb_storage import choose_storage
from monico_core import Registry
from mailbox_claims import MailboxClaims

LOCAL_PHONE = "http://127.0.0.1:8765"
MCP_PORT = 8787
SCHEMA = 1
DOMAIN_PATTERN = re.compile(r"[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?\Z")


def _private_json(path, document):
    """Create private JSON atomically; never silently overwrite credentials."""
    import tempfile
    path = Path(path)
    if path.exists():
        raise FileExistsError("Refusing to replace existing credentials")
    fd, temp = tempfile.mkstemp(prefix=".monico-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(document, file, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temp, 0o600)
        os.link(temp, path)  # no replace; concurrent setup fails closed
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass


def load_config(state, domain=None, create=False):
    """One persistent configuration on the phone's actual private storage."""
    state = Path(state).resolve()
    mail = state / "monico"
    if create:
        mail.mkdir(mode=0o700, parents=True, exist_ok=True)
    file = mail / "linux-config.json"
    if file.exists():
        if file.stat().st_mode & 0o077:
            raise RuntimeError("Refusing insecure operator credential permissions")
        config = json.loads(file.read_text(encoding="utf-8"))
        if config.get("schema") != SCHEMA:
            raise RuntimeError("Unknown Monico settings schema")
        if (not isinstance(config.get("admin_key"), str)
                or len(config["admin_key"]) < 32
                or not isinstance(config.get("bearer_token"), str)
                or len(config["bearer_token"]) < 32):
            raise RuntimeError("Monico operator secrets are incomplete")
        if config.get("state_path") != str(state):
            raise RuntimeError("Saved Monico configuration points to a different agent storage path")
        if domain and domain.lower() != config["domain"]:
            raise RuntimeError("Domain already configured; refusing silent mailbox address changes")
        return config, mail
    if not create:
        return None, mail
    domain = (domain or "agents.local").lower().strip()
    if not DOMAIN_PATTERN.fullmatch(domain) or ".." in domain:
        raise ValueError("Invalid email domain")
    config = {
        "schema": SCHEMA, "state_path": str(state), "domain": domain,
        "admin_key": secrets.token_urlsafe(48),
        "bearer_token": secrets.token_urlsafe(48),
    }
    _private_json(file, config)
    return config, mail


def registry(state, domain=None, create=False):
    config, folder = load_config(state, domain=domain, create=create)
    if config is None:
        raise RuntimeError("Run bash start.sh --full up --install first")
    return config, folder, Registry(folder, config["domain"])


def _pid_active(pid, script_path):
    try:
        if type(pid) is not int or pid <= 1:
            return False
        os.kill(pid, 0)
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\x00")
        return str(Path(script_path).resolve()).encode("utf-8") in cmdline
    except (OSError, ValueError, PermissionError):
        return False


def _mcp_pid_path(folder):
    return folder / "mcp.pid"


def _port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def mcp_status(folder):
    return inspect_mcp(folder)


def _mcp_python():
    return MAIL / ".venv" / "bin" / "python"


def dependency_ready():
    py = _mcp_python()
    if not py.is_file():
        return False
    p = subprocess.run([str(py), "-c", "import fastmcp; import pydantic"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    return p.returncode == 0


def install():
    """Install Python runtime dependencies only. Never touch system mail config."""
    py = _mcp_python()
    if not py.exists():
        try:
            subprocess.run([sys.executable, "-m", "venv", str(MAIL / ".venv")],
                           check=True, timeout=90)
        except (subprocess.CalledProcessError, OSError) as exc:
            raise RuntimeError("Python venv unavailable; on Debian install python3-venv") from exc
    subprocess.run([str(py), "-m", "pip", "install", "-r", str(MAIL / "requirements.txt")],
                   check=True, timeout=180)
    if not dependency_ready():
        raise RuntimeError("FastMCP did not install correctly")


def start_mcp(config, folder):
    if mcp_status(folder):
        return "already running"
    # Clear only stale PID metadata, never an actively running server.
    pid_file = _mcp_pid_path(folder)
    old_pid = _read_saved_mcp_pid(folder)
    if old_pid and _pid_active(old_pid, MAIL / "server.py"):
        raise RuntimeError("Saved MCP process is running but not healthy yet; inspect its log")
    if pid_file.exists():
        pid_file.unlink()
    if _port_open(MCP_PORT):
        raise RuntimeError("127.0.0.1:8787 is occupied by another process; refusing to attach")
    if not dependency_ready():
        raise RuntimeError("FastMCP is missing: run bash start.sh --full up --install")
    env = os.environ.copy()
    env.update({
        "MONICO_DATA": str(folder),
        "MONICO_DOMAIN": config["domain"],
        "MONICO_ADMIN_KEY": config["admin_key"],
        "MONICO_MCP_BEARER_TOKEN": config["bearer_token"],
        "MONICO_MAX_MAILBOXES": "1000",
    })
    log = folder / "mcp.log"
    with log.open("ab") as stream:
        os.chmod(log, 0o600)
        p = subprocess.Popen([str(_mcp_python()), str(MAIL / "server.py")],
                             cwd=str(MAIL), env=env, stdin=subprocess.DEVNULL,
                             stdout=stream, stderr=stream, start_new_session=True)
    for _ in range(50):
        if p.poll() is not None:
            raise RuntimeError(f"MCP exited early; inspect {log}")
        if _port_open(MCP_PORT):
            _private_json(_mcp_pid_path(folder), {"pid": p.pid})
            return "started"
        time.sleep(0.1)
    p.terminate()
    raise RuntimeError(f"MCP failed to open localhost:{MCP_PORT}; inspect {log}")


def _read_saved_mcp_pid(folder):
    """Read PID from new JSON format (never PID-guess an unrelated process)."""
    try:
        record = json.loads(_mcp_pid_path(folder).read_text(encoding="utf-8"))
        return record["pid"] if isinstance(record, dict) else None
    except (ValueError, OSError, KeyError):
        return None


def stop_mcp(folder):
    pid = _read_saved_mcp_pid(folder)
    if pid and _pid_active(pid, MAIL / "server.py"):
        os.kill(pid, signal.SIGTERM)
        # Don't report 'stopped' until this endpoint stops accepting requests.
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if not _pid_active(pid, MAIL / "server.py") and not _port_open(MCP_PORT):
                break
            time.sleep(0.1)
        if _pid_active(pid, MAIL / "server.py") or _port_open(MCP_PORT):
            raise RuntimeError("MCP shutdown incomplete; inspect its process before restarting")
        _mcp_pid_path(folder).unlink(missing_ok=True)
        return "stopped"
    _mcp_pid_path(folder).unlink(missing_ok=True)
    return "not running"


def inspect_mcp(folder):
    pid = _read_saved_mcp_pid(folder)
    return bool(pid and _pid_active(pid, MAIL / "server.py") and _port_open(MCP_PORT))


def run_phone(state):
    from start import verify_server, spawn_daemon
    live = verify_server(LOCAL_PHONE, state)
    if live is not None:
        return "already running"
    spawn_daemon(state, 8765, LOCAL_PHONE)
    return "started"


def inspect_phone(state):
    from start import verify_server
    return verify_server(LOCAL_PHONE, state) is not None


def stop_phone(state):
    result = subprocess.run([sys.executable, str(PHONE / "start.py"), "--stop",
                             "--state-dir", str(state)], cwd=str(ROOT),
                            capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Phone service stop failed")
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        if not inspect_phone(state):
            break
        time.sleep(0.1)
    if inspect_phone(state):
        raise RuntimeError("Phone service shutdown incomplete; inspect before restarting")
    return result.stdout.strip()


def do_status(state):
    cfg, folder = load_config(state)
    phone = inspect_phone(state)
    mcp = inspect_mcp(folder)
    accounts = None
    if cfg is not None:
        accounts = Registry(folder, cfg["domain"]).mailbox_count()
    import public_manage
    try:
        public = public_manage.status(state)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        public = {"prepared": False, "local_https_running": False,
                  "outside_network_verified": False,
                  "error": f"Public gateway metadata error: {type(exc).__name__}"}
    return {
        "public_browser_gateway": public,
        "phone_online_local": phone,
        "mcp_online_local": mcp,
        "mcp_url": "http://127.0.0.1:8787/mcp" if mcp else None,
        "dashboard": LOCAL_PHONE if phone else None,
        "storage": str(state),
        "mailbox_domain": cfg["domain"] if cfg else None,
        "mailbox_count": accounts,
        "internal_network_usable": phone and mcp,
        "public_internet_mail_verified": False,
        "public_pstn_sms_verified": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="up",
                        choices=("up", "status", "doctor", "release", "stop", "install", "invites", "claim"))
    parser.add_argument("--install", action="store_true",
                        help="On 'up', create venv and install FastMCP from PyPI")
    parser.add_argument("--domain", help="Initial domain (default agents.local for local agent networking)")
    parser.add_argument("--state-dir", help="Explicit private phone/MCP data directory")
    parser.add_argument("--scope", default="local",
                        choices=("local", "public-web", "internet-mail", "carrier-phone", "all"),
                        help="Release gate scope for 'release' action")
    parser.add_argument("--count", type=int, default=1, help="Invite count (1-200)")
    parser.add_argument("--name", help="Chosen email local part for 'claim'")
    parser.add_argument("--public-ip", help="Your own reachable IPv4 for optional HTTPS gateway")
    parser.add_argument("--public-port", type=int, default=8766)
    parser.add_argument("--allow-public", action="store_true",
                        help="Explicitly allow an HTTPS listener on all interfaces")
    args = parser.parse_args()
    try:
        state = choose_storage(state_dir=args.state_dir).path
        if args.action == "install":
            install()
            print("FastMCP dependencies installed in monico-mail-usb/.venv")
            return
        if args.action == "up":
            config, folder, reg = registry(state, args.domain, create=True)
            if args.install:
                install()
            if not dependency_ready():
                raise RuntimeError("FastMCP not installed. Run: bash start.sh --full up --install")
            phone_result = run_phone(state)
            mcp_result = start_mcp(config, folder)
            public_result = None
            if args.public_ip is not None or args.allow_public:
                if not args.public_ip or not args.allow_public:
                    raise ValueError("Public gateway requires BOTH --public-ip and --allow-public")
                import public_manage
                public_manage.prepare(state, args.public_ip, args.public_port)
                public_result = public_manage.start(state, allow_public=True)
            print(json.dumps({
                "public_browser_gateway": public_result or do_status(state)["public_browser_gateway"],
                "phone": phone_result, "mail_mcp": mcp_result,
                "dashboard": LOCAL_PHONE, "mcp": "http://127.0.0.1:8787/mcp",
                "storage": str(state), "mail_domain": config["domain"],
                "mail_accounts": reg.mailbox_count(),
                "public_internet_delivery_verified": False,
                "next": "bash start.sh --full invites --count 5"
            }, indent=2))
            return
        if args.action == "status":
            print(json.dumps(do_status(state), indent=2))
            return
        if args.action == "doctor":
            result = do_status(state)
            result["python"] = sys.version.split()[0]
            result["fastmcp_installed"] = dependency_ready()
            result["storage_private"] = (state.stat().st_mode & 0o077) == 0
            result["public_domain_verified"] = False
            result["dns_mx_verified"] = False
            result["postfix_dovecot_verified"] = False
            result["external_browser_reachability_verified"] = False
            print(json.dumps(result, indent=2))
            return
        if args.action == "release":
            script = ROOT / "linux" / "release_gate.py"
            result = subprocess.run(
                [sys.executable, str(script), "--state-dir", str(state), "--scope", args.scope],
                capture_output=True, text=True, cwd=str(ROOT), timeout=35)
            print(result.stdout, end="")
            if result.returncode:
                parser.exit(result.returncode, result.stderr or
                            "Release gate BLOCKED: see failed checks above.\n")
            return
        if args.action == "stop":
            import public_manage
            print("Public browser gateway:", public_manage.stop(state))
            cfg, folder = load_config(state)
            if cfg:
                print("Mail MCP:", stop_mcp(folder))
            print("Agent phone:", stop_phone(state))
            return
        if args.action == "invites":
            _, _, reg = registry(state)
            issued = MailboxClaims(reg).issue_invites(args.count)
            print(json.dumps(issued, indent=2))
            print("Keep invitation codes secret; shown only once.", file=sys.stderr)
            return
        if args.action == "claim":
            if not args.name:
                raise ValueError("Provide --name, e.g. claim --name research")
            _, _, reg = registry(state)
            code = getpass.getpass("Private one-time invitation: ")
            result = MailboxClaims(reg).claim(code, args.name)
            print(json.dumps(result, indent=2))
            print("Save agent token and mailbox password; shown only once.",
                  file=sys.stderr)
            return
    except (RuntimeError, OSError, ValueError, json.JSONDecodeError,
            subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, "Monico Linux: " + str(exc) + "\n")


if __name__ == "__main__":
    main()
