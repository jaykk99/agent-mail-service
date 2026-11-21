"""Contract tests for the one-command co-host installer.

The live-process integration check runs separately in GitHub Actions.
These tests require no root, apt, network, or physical Android/USB.
"""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PlugAndPlayInstallerTests(unittest.TestCase):
    def test_shell_installers_are_valid(self):
        for name in ("install.sh", "linux/cohost.sh", "linux/install.sh"):
            with self.subTest(name=name):
                proc = subprocess.run(["bash", "-n", str(ROOT / name)],
                                      capture_output=True, text=True, timeout=10)
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_safe_port_split_and_no_public_publish_by_default(self):
        script = (ROOT / "linux/cohost.sh").read_text()
        self.assertIn("BRIDGE_PORT=8767", script)
        self.assertIn('"$ROOT/start.sh" --full up', script)
        self.assertIn('"$BRIDGE_DIR/install-linux.sh"', script)
        self.assertIn('monico-usb', script)
        self.assertIn('monico-pair', script)
        self.assertIn('adb reverse "tcp:$BRIDGE_PORT" "tcp:$BRIDGE_PORT"', script)
        self.assertIn("ensure_adb", script)
        self.assertIn("enable_usb_reverse", script)
        self.assertIn("install-termux.sh", script)
        self.assertIn("monico-net on", script)
        self.assertIn('timeout 18 git -C "$BRIDGE_DIR" pull --ff-only', script)
        self.assertNotIn("start --public", script)
        self.assertNotIn("--allow-public", script)
        self.assertNotIn("rm -rf", script)

    def test_one_paste_script_has_safe_existing_checkout_handling(self):
        script = (ROOT / "install.sh").read_text()
        self.assertIn("git clone https://github.com/jaykk99/agent-mail-service.git", script)
        self.assertIn("git -C \"$TARGET\" pull --ff-only", script)
        self.assertIn('exec bash "$TARGET/install.sh"', script)


if __name__ == "__main__":
    unittest.main()
