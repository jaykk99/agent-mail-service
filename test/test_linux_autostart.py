"""Autostart installer tests: unit rendering, opt-in rules and fail-closed paths.

These need no systemd and no root. `--print` renders the unit and writes nothing,
so the installer's rules can be tested on any machine.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "linux" / "enable_autostart.sh"
SECRET = "operator-secret-that-must-never-appear-in-a-unit-file"


def run(*args, env=None):
    return subprocess.run(
        ["bash", str(SCRIPT), *map(str, args)],
        capture_output=True, text=True, timeout=30,
        cwd=str(ROOT), env=env,
    )


class AutostartInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "monico-state"
        (self.state / "monico").mkdir(parents=True, mode=0o700)
        self.config = self.state / "monico" / "linux-config.json"
        self.config.write_text(json.dumps({
            "schema": 1,
            "state_path": str(self.state),
            "domain": "mail.example.invalid",
            "admin_key": SECRET,
            "bearer_token": SECRET,
        }))
        self.config.chmod(0o600)
        self.env = dict(os.environ, XDG_CONFIG_HOME=str(self.root / "xdg"))

    def tearDown(self):
        self.temp.cleanup()

    def print_unit(self, *extra):
        proc = run("--print", "--state-dir", self.state, *extra, env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def test_print_renders_watchdog_unit_for_pinned_storage(self):
        unit = self.print_unit()
        self.assertIn("# Managed by linux/enable_autostart.sh", unit)
        self.assertIn("ExecStart=", unit)
        self.assertIn(str(ROOT / "linux" / "watchdog.py"), unit)
        self.assertIn(f'--state-dir "{self.state}"', unit)
        self.assertIn("--interval 60", unit)
        self.assertIn("Restart=always", unit)
        self.assertIn("WantedBy=default.target", unit)
        self.assertIn(f'WorkingDirectory="{ROOT}"', unit)

    def test_print_writes_no_unit_file(self):
        self.print_unit()
        self.assertFalse((self.root / "xdg").exists())

    def test_print_never_embeds_operator_credentials(self):
        unit = self.print_unit()
        self.assertNotIn(SECRET, unit)
        self.assertNotIn("bearer", unit.lower())

    def test_public_gateway_requires_both_opt_in_flags(self):
        for args in (("--public-ip", "203.0.113.9"), ("--allow-public",)):
            proc = run("--print", "--state-dir", self.state, *args, env=self.env)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("--public-ip and --allow-public", proc.stderr)
        unit = self.print_unit("--public-ip", "203.0.113.9", "--allow-public")
        self.assertIn("--public-ip 203.0.113.9 --allow-public", unit)

    def test_free_domain_and_explicit_domain_are_exclusive(self):
        proc = run("--domain", "example.org", "--free-domain", "--state-dir", self.state,
                   env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not both", proc.stderr)

    def test_free_domain_without_token_fails_before_starting_anything(self):
        env = dict(self.env, HOME=str(self.root), DUCKDNS_TOKEN="")
        proc = subprocess.run(
            ["bash", str(SCRIPT), "--free-domain"], capture_output=True, text=True,
            timeout=30, cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("token", proc.stderr.lower())

    def test_malformed_public_ip_is_rejected(self):
        proc = run("--print", "--state-dir", self.state,
                   "--public-ip", "not-an-ip", "--allow-public", env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("plain IP address", proc.stderr)

    def test_interval_is_bounded(self):
        for value in ("5", "3601", "abc"):
            proc = run("--print", "--state-dir", self.state, "--interval", value, env=self.env)
            self.assertNotEqual(proc.returncode, 0, value)
            self.assertIn("--interval", proc.stderr)
        self.assertIn("--interval 300", self.print_unit("--interval", "300"))

    def test_missing_state_dir_is_rejected(self):
        proc = run("--print", env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--state-dir", proc.stderr)

    def test_relative_state_dir_is_rejected(self):
        proc = run("--print", "--state-dir", "monico-state", env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("absolute path", proc.stderr)

    def test_uninitialized_storage_is_rejected(self):
        empty = self.root / "empty"
        empty.mkdir(mode=0o700)
        proc = run("--print", "--state-dir", empty, env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--full up --install", proc.stderr)

    def test_world_readable_credentials_are_rejected(self):
        self.config.chmod(0o644)
        proc = run("--print", "--state-dir", self.state, env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("0600", proc.stderr)

    def test_status_and_uninstall_do_not_require_storage(self):
        for action in ("--status", "--uninstall"):
            proc = run(action, env=self.env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("not installed", run("--status", env=self.env).stdout)

    def test_script_syntax_is_valid(self):
        proc = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True,
                              text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stderr)


STUB_FREE_DOMAIN = '''\
import json, os, sys
if "--check" in sys.argv:
    if os.environ.get("STUB_DNS") == "match":
        print(json.dumps({"domain": "monico-abc123.duckdns.org", "match": True}))
        raise SystemExit(0)
    print("Monico free domain: monico-abc123.duckdns.org resolves to 1.1.1.1, not 8.8.8.8", file=sys.stderr)
    raise SystemExit(1)
print(json.dumps({"domain": "monico-abc123.duckdns.org", "ip": "8.8.8.8", "taken": []}))
'''


def shell_functions(*names):
    """Extract named shell functions so the claim path can run without an install."""
    text = SCRIPT.read_text(encoding="utf-8")
    blocks = []
    for name in names:
        match = re.search(rf"^{name}\(\) \{{.*?^\}}$", text, re.S | re.M)
        if match is None:
            raise AssertionError(f"function {name} not found in {SCRIPT}")
        blocks.append(match.group(0))
    return "\n\n".join(blocks)


class FreeDomainVerificationTests(unittest.TestCase):
    """A claim verifies its own DNS record and warns instead of failing."""

    def claim(self, dns):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "linux").mkdir()
        (root / "linux" / "free_domain.py").write_text(STUB_FREE_DOMAIN, encoding="utf-8")
        (root / "functions.sh").write_text(
            shell_functions("verify_domain", "claim_free_domain"), encoding="utf-8"
        )
        harness = root / "harness.sh"
        harness.write_text(
            "set -euo pipefail\n"
            'ROOT="$1"\n'
            'PYTHON=python3\n'
            'TOKEN_FILE="$ROOT/token"\n'
            'PUBLIC_IP=""\n'
            'DUCKDNS_TOKEN="12345678-1234-1234-1234-123456789abc"\n'
            'die() { printf "%s\\n" "$1" >&2; exit 9; }\n'
            'source "$ROOT/functions.sh"\n'
            'claim_free_domain\n',
            encoding="utf-8",
        )
        return subprocess.run(
            ["bash", str(harness), str(root)], capture_output=True, text=True,
            timeout=30, env=dict(os.environ, STUB_DNS=dns),
        )

    def test_matching_dns_is_reported_after_the_claim(self):
        proc = self.claim("match")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "monico-abc123.duckdns.org")
        self.assertIn("Free domain claimed", proc.stderr)
        self.assertIn("DNS verified", proc.stderr)
        self.assertNotIn("WARNING", proc.stderr)

    def test_mismatched_dns_warns_without_failing_the_install(self):
        proc = self.claim("mismatch")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "monico-abc123.duckdns.org")
        self.assertIn("WARNING", proc.stderr)
        self.assertIn("does not point at this host yet", proc.stderr)
        self.assertIn("resolves to 1.1.1.1, not 8.8.8.8", proc.stderr)
        self.assertIn("free_domain.py --check monico-abc123.duckdns.org --expect-ip 8.8.8.8", proc.stderr)
        self.assertNotIn("12345678-1234", proc.stderr + proc.stdout)


STATUS_HARNESS = '''\
set -euo pipefail
ROOT="$1"
STATE_DIR="$2"
UNIT_DIR="$ROOT/xdg/systemd/user"
UNIT_NAME=monico-agent.service
PYTHON=python3
have_user_systemd() { return 1; }
linger_state() { echo unknown; }
source "$ROOT/functions.sh"
show_status
'''


class StatusDomainCheckTests(unittest.TestCase):
    """--status re-checks the pinned domain without claiming anything."""

    def status(self, domain, dns="match"):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "linux").mkdir()
        (root / "linux" / "free_domain.py").write_text(STUB_FREE_DOMAIN, encoding="utf-8")
        state = root / "state"
        (state / "monico").mkdir(parents=True)
        (state / "monico" / "linux-config.json").write_text(json.dumps({"domain": domain}))
        (root / "functions.sh").write_text(
            shell_functions("verify_domain", "saved_domain", "show_status"), encoding="utf-8"
        )
        (root / "status.sh").write_text(STATUS_HARNESS, encoding="utf-8")
        return subprocess.run(
            ["bash", str(root / "status.sh"), str(root), str(state)],
            capture_output=True, text=True, timeout=30, env=dict(os.environ, STUB_DNS=dns),
        )

    def test_status_verifies_the_pinned_domain(self):
        proc = self.status("monico-abc123.duckdns.org")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("domain: monico-abc123.duckdns.org", proc.stdout)
        self.assertIn("DNS verified", proc.stderr)

    def test_status_warns_when_the_pinned_domain_moved(self):
        proc = self.status("monico-abc123.duckdns.org", dns="mismatch")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("WARNING", proc.stderr)
        self.assertIn("does not point at this host yet", proc.stderr)

    def test_status_skips_the_local_placeholder_domain(self):
        proc = self.status("mail.example.invalid")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("domain check: skipped (local placeholder domain)", proc.stdout)
        self.assertNotIn("DNS verified", proc.stderr)


if __name__ == "__main__":
    unittest.main()
