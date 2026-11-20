#!/usr/bin/env python3
"""Actual Linux HTTP load smoke: 1,000 unique agents and 1,000 messages.

Uses the real ThreadingHTTPServer, unique real bearer credentials, and SQLite.
No mocks, third-party cloud service, or external carrier. It is bounded and
run against an isolated in-process loopback service; NOT proof of Internet
reachability or 1,000 always-connected sessions.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import create_server

AGENTS = 1000
WORKERS = 16


def call(base, path, token=None, data=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data, separators=(",", ":")).encode("utf-8")
    req = Request(base + path, headers=headers, data=body)
    try:
        with urlopen(req, timeout=15) as response:
            return response.status, json.loads(response.read(32768))
    except HTTPError as exc:
        return exc.code, json.loads(exc.read(32768))


def all_parallel(label, func, items):
    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = [executor.submit(func, item) for item in items]
        for future in as_completed(futures):
            future.result()
    seconds = time.monotonic() - start
    print(f"PASS: {label}: {len(items)} completed in {seconds:.2f}s with {WORKERS} workers",
          flush=True)
    return seconds


def run():
    with tempfile.TemporaryDirectory(prefix="monico-1000-http-") as directory:
        root = Path(directory)
        service = create_server(root, count=AGENTS, host="127.0.0.1", port=0)
        server_thread = threading.Thread(target=service.serve_forever, daemon=True)
        server_thread.start()
        base = f"http://127.0.0.1:{service.server_port}"
        all_ids = json.loads((root / "identities.json").read_text())["extensions"]
        assert len(all_ids) == AGENTS
        assert len({a["apiToken"] for a in all_ids.values()}) == AGENTS
        ids = list(sorted(all_ids, key=int))

        def token(ext):
            return all_ids[ext]["apiToken"]

        try:
            code, payload = call(base, "/health")
            assert code == 200 and payload["agents"] == AGENTS
            assert payload["publicNumbers"] is False
            assert payload["internalOnly"] is True

            code, _ = call(base, "/api/me")
            assert code == 401, "Unauthenticated agent endpoint must not respond"
            print("PASS: real HTTP listener and anonymous authentication denial", flush=True)

            def verify_login(ext):
                code, data = call(base, "/api/me", token(ext))
                assert code == 200 and data["extension"] == ext
                assert data["webPhoneNumber"] == "web:" + ext

            auth_seconds = all_parallel(
                "1,000 distinct HTTP agent-authenticated sessions", verify_login, ids
            )

            def send_one(ext):
                next_ext = str(2000 + (int(ext) - 2000 + 1) % AGENTS)
                content = f"Monico-load-{ext}-to-{next_ext}"
                status, result = call(
                    base, "/api/messages", token(ext),
                    {"to": next_ext, "text": content}
                )
                assert status == 201, (ext, status, result)
                assert result["from"] == ext and result["to"] == next_ext
                assert result["carrierSms"] is False

            send_seconds = all_parallel(
                "1,000 actual SQLite-backed HTTP messages", send_one, ids
            )

            def receive_one(ext):
                prev_ext = str(2000 + (int(ext) - 2000 - 1) % AGENTS)
                code, inbox = call(base, "/api/messages?limit=10", token(ext))
                assert code == 200, (ext, code, inbox)
                relevant = [
                    event for event in inbox["events"]
                    if event["from"] == prev_ext
                    and event["data"]["text"] == f"Monico-load-{prev_ext}-to-{ext}"
                ]
                assert len(relevant) == 1, (ext, inbox["events"])

            recv_seconds = all_parallel(
                "1,000 correctly routed per-agent HTTP inbox reads", receive_one, ids
            )

            with sqlite3.connect(root / "messages.sqlite3") as conn:
                count = conn.execute(
                    "SELECT count(*) FROM events WHERE kind='text'"
                ).fetchone()[0]
                unique_senders = conn.execute(
                    "SELECT count(distinct sender) FROM events WHERE kind='text'"
                ).fetchone()[0]
                unique_recipients = conn.execute(
                    "SELECT count(distinct recipient) FROM events WHERE kind='text'"
                ).fetchone()[0]
            assert (count, unique_senders, unique_recipients) == (AGENTS, AGENTS, AGENTS)
            print("PASS: SQLite durable 1000 messages / 1000 senders / 1000 recipients",
                  flush=True)
        finally:
            service.shutdown()
            service.server_close()
            server_thread.join(timeout=10)

        # Actually reopen on a new server instance and verify durability,
        # credentials, and routing after a restart.
        restarted = create_server(root, count=AGENTS, host="127.0.0.1", port=0)
        thread = threading.Thread(target=restarted.serve_forever, daemon=True)
        thread.start()
        new_base = f"http://127.0.0.1:{restarted.server_port}"
        try:
            result_code, health = call(new_base, "/health")
            assert result_code == 200 and health["instanceId"] == payload["instanceId"]
            for ext in ("2000", "2200", "2500", "2999"):
                previous = str(2000 + (int(ext) - 2000 - 1) % AGENTS)
                code, inbox = call(new_base, "/api/messages?limit=2", token(ext))
                assert code == 200
                assert any(entry["from"] == previous for entry in inbox["events"])
            print("PASS: process restart preserved vault identity, credentials and messages",
                  flush=True)
        finally:
            restarted.shutdown()
            restarted.server_close()
            thread.join(timeout=10)

        print(json.dumps({
            "scope": "linux_loopback_http_smoke",
            "passed": True,
            "identities_tested": AGENTS,
            "real_http_sessions_authenticated": AGENTS,
            "messages_sent": AGENTS,
            "mailboxes_read": AGENTS,
            "messages_persisted_after_restart": True,
            "auth_elapsed_seconds": round(auth_seconds, 2),
            "send_elapsed_seconds": round(send_seconds, 2),
            "read_elapsed_seconds": round(recv_seconds, 2),
            "public_internet_access_verified": False,
            "real_smtp_imap_verified_here": False,
            "concurrent_always_online_sessions_verified": False
        }, indent=2))


if __name__ == "__main__":
    run()
