#!/usr/bin/env python3
"""One-command private communications on Linux for up to 1,000 AI agents.

  bash start.sh                      # dashboard + local routes (foreground)
  bash start.sh --list-usb           # find every likely removable volume
  bash start.sh --mcp 2000           # auto-start daemon + scoped MCP stdio
  bash start.sh --mcp agent-0002     # use a different persistent identity

No cloud services, pip, node, internet, carrier, or purchased domain required.
The resulting numbers/email addresses are INTERNAL only.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import URLError, HTTPError
from urllib.request import urlopen

from server import create_server
from usb_storage import choose_storage, discover_usb, supports_private_storage

LOCAL_DOMAIN = "agents.localhost"


def read_token(state_dir, agent):
    identities = json.loads((state_dir / "identities.json").read_text(encoding="utf-8"))["extensions"]
    number = agent
    if agent.startswith("agent-"):
        number = next((ext for ext, item in identities.items() if item["agentId"] == agent), "")
    if number not in identities:
        raise ValueError("Unknown agent; use 2000–2999 or agent-0001–agent-1000")
    return identities[number]["apiToken"], number


def expected_instance(state_dir):
    try:
        token, _ = read_token(state_dir, "2000")
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        return None
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def running_service(url):
    try:
        with urlopen(url + "/health", timeout=1.25) as res:
            payload = json.load(res)
            if payload.get("ok") and payload.get("internalOnly") and payload.get("agents") == 1000:
                return payload
    except (OSError, URLError, HTTPError, ValueError):
        pass
    return None


def verify_server(url, state_dir):
    live = running_service(url)
    if live:
        expected = expected_instance(state_dir)
        if expected is None or live.get("instanceId") != expected:
            raise RuntimeError(
                f"Port is already used by a different agent server at {url}. "
                "Refusing to connect an agent to the wrong identity store."
            )
    return live


def print_usb():
    drives = discover_usb()
    if not drives:
        print("No USB drive currently shared/mounted into Linux.")
        print("Chromebook: Settings > Developers > Linux > USB preferences or share removable files with Linux.")
        return
    print(f"Detected {len(drives)} candidate USB storage paths:")
    for idx, drive in enumerate(drives, start=1):
        safe = supports_private_storage(drive)
        print(f"  {idx}. {drive} — {'private storage supported' if safe else 'cannot safely protect agent credentials'}")
    print("Exactly one secure available USB is selected automatically on first run.")
    print("If several are suitable, existing Linux storage is used to avoid picking the wrong drive.")


def serve_foreground(state, url, port, background=False):
    try:
        server = create_server(state, count=1000, host="127.0.0.1", port=port)
    except OSError as exc:
        raise RuntimeError(f"Could not start on {url}: {exc}") from exc
    pid_path = state / "server.pid"
    pid_path.write_text(str(os.getpid()) + "\n")
    os.chmod(pid_path, 0o600)
    if not background:
        print(f"Agent Communications running: {url}", flush=True)
        try:
            socket.getaddrinfo(LOCAL_DOMAIN, port)
            print(f"Private local domain: http://{LOCAL_DOMAIN}:{port}", flush=True)
        except OSError:
            print(f"Private domain {LOCAL_DOMAIN} not resolved on this Linux host; use {url}", flush=True)
        print("Internal-only email addresses: agent-0001@agents.invalid ... agent-1000@agents.invalid", flush=True)
        print("Internal-only phone extensions: 2000 ... 2999", flush=True)
        print("Local MCP for first agent: bash start.sh --mcp 2000", flush=True)
        print("No public internet email, carrier SMS, or real telephone numbers.", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            if pid_path.read_text().strip() == str(os.getpid()):
                pid_path.unlink()
        except OSError:
            pass


def spawn_daemon(state, port, url):
    log_path = state / "server.log"
    with log_path.open("ab") as log:
        os.chmod(log_path, 0o600)
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--serve",
             "--state-dir", str(state), "--port", str(port)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True, cwd=Path(__file__).resolve().parents[1],
        )
    for _ in range(80):
        if proc.poll() is not None:
            raise RuntimeError(f"Linux server exited early; inspect {log_path}")
        if verify_server(url, state):
            return
        time.sleep(0.1)
    proc.terminate()
    raise RuntimeError(f"Linux server did not become healthy; inspect {log_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", help="Optional manually chosen Linux storage; default detects USB")
    parser.add_argument("--list-usb", action="store_true", help="List available USB mounts and whether private credentials are safe")
    parser.add_argument("--mcp", metavar="AGENT", help="Connect this agent to MCP, starting the background server if necessary")
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.list_usb:
        print_usb()
        return
    if not (1 <= args.port <= 65535):
        parser.error("Port must be between 1 and 65535")
    try:
        storage = choose_storage(state_dir=args.state_dir)
    except (RuntimeError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    state = storage.path
    url = f"http://127.0.0.1:{args.port}"
    if not args.mcp and not args.serve:
        print(f"Storage: {state} ({storage.source}) — {storage.info}", flush=True)
        if storage.usbs:
            print("Available USB paths: " + ", ".join(map(str, storage.usbs)), flush=True)
    try:
        live = verify_server(url, state)
        if args.mcp:
            if not live:
                spawn_daemon(state, args.port, url)
            token, _ = read_token(state, args.mcp)
            import mcp
            mcp.API = url
            mcp.TOKEN = token
            mcp.main()  # stdout remains JSON-RPC only
        elif live:
            if not args.serve:
                print(f"Agent Communications already running at {url}")
            else:
                raise RuntimeError(f"Another agent server already listens at {url}")
        else:
            serve_foreground(state, url, args.port, background=args.serve)
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        print("Agent Communications: " + str(exc), file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
