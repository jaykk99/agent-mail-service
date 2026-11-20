"""Autostart installer tests: unit rendering, opt-in rules and fail-closed paths.

These need no systemd and no root. `--print` renders the unit and writes nothing,
so the installer's rules can be tested on any machine.
"""
import json
import os
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
