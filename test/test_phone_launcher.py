import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LauncherMcpTests(unittest.TestCase):
    def test_one_command_launches_daemon_mcp_and_local_mail_routes(self):
        with tempfile.TemporaryDirectory() as d, socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            sock.close()
            messages = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                 "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                 "params": {"name": "phone_claim", "arguments": {}}},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                 "params": {"name": "email_addresses", "arguments": {}}},
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                 "params": {"name": "email_create_alias", "arguments": {"prefix": "launch-test"}}},
                {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                 "params": {"name": "routing_status", "arguments": {}}},
            ]
            pid_file = Path(d) / "server.pid"
            try:
                result = subprocess.run([
                    sys.executable, str(ROOT / "phone" / "start.py"), "--mcp", "2000",
                    "--state-dir", d, "--port", str(port)
                ], input="\n".join(map(json.dumps, messages)) + "\n",
                   capture_output=True, text=True, timeout=35, cwd=ROOT)
                self.assertEqual(result.returncode, 0, result.stderr)
                replies = [json.loads(x) for x in result.stdout.strip().split("\n")]
                self.assertEqual(len(replies), 5, result.stdout)
                self.assertEqual(json.loads(replies[1]["result"]["content"][0]["text"])["extension"], "2000")
                addresses = json.loads(replies[2]["result"]["content"][0]["text"])["addresses"]
                self.assertIn("agent-0001@agents.invalid", addresses)
                alias = json.loads(replies[3]["result"]["content"][0]["text"])
                self.assertEqual(alias["address"], "launch-test@agents.invalid")
                routes = json.loads(replies[4]["result"]["content"][0]["text"])
                self.assertTrue(routes["internalMail"])
                self.assertFalse(routes["publicSmsRouting"])
                self.assertTrue(pid_file.exists(), "Background server must persist after MCP bridge exits")
                # A second agent can attach without restarting or changing identities.
                second = subprocess.run(
                    [sys.executable, str(ROOT / "phone" / "start.py"), "--mcp", "2001",
                     "--state-dir", d, "--port", str(port)],
                    input=json.dumps(messages[0]) + "\n",
                    capture_output=True, text=True, timeout=15, cwd=ROOT
                )
                self.assertEqual(second.returncode, 0, second.stderr)
                self.assertTrue(second.stdout.startswith('{"jsonrpc":'), second.stdout)
            finally:
                if pid_file.exists():
                    try:
                        os.kill(int(pid_file.read_text().strip()), signal.SIGTERM)
                    except (ProcessLookupError, OSError, ValueError):
                        pass
                time.sleep(0.2)


if __name__ == "__main__":
    unittest.main()
