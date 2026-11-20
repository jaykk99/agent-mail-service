import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from usb_storage import choose_storage, discover_usb, supports_private_storage
from start import expected_instance, running_service, verify_server

ROOT = Path(__file__).resolve().parents[1]


class USBStorageTests(unittest.TestCase):
    def test_scans_all_chromebook_like_usb_paths(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "removable"
            (root / "Drive A").mkdir(parents=True)
            (root / "Backup USB").mkdir()
            discovered = discover_usb(roots=[root])
            self.assertEqual(set(discovered), {(root / "Drive A").resolve(), (root / "Backup USB").resolve()})

    def test_no_usb_uses_internal_and_persists_choice(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            home.mkdir()
            first = choose_storage(home=home, mount_points=[])
            self.assertEqual(first.source, "internal")
            self.assertTrue(first.path.is_dir())
            self.assertTrue(supports_private_storage(first.path))
            marker = home / ".config" / "agent-comms" / "storage.json"
            self.assertEqual(json.loads(marker.read_text())["source"], "internal")
            self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)
            usb = Path(td) / "usb"
            usb.mkdir()
            second = choose_storage(home=home, mount_points=[usb])
            self.assertEqual(first.path, second.path)
            self.assertEqual(second.source, "internal")

    def test_single_secure_usb_auto_selects_and_pins(self):
        with tempfile.TemporaryDirectory() as td:
            home, usb = Path(td) / "home", Path(td) / "My USB Drive"
            home.mkdir()
            usb.mkdir()
            choice = choose_storage(home=home, mount_points=[usb])
            self.assertEqual(choice.source, "usb")
            self.assertEqual(choice.path, (usb / ".agent-comms").resolve())
            self.assertEqual(stat.S_IMODE(choice.path.stat().st_mode), 0o700)
            self.assertEqual(choose_storage(home=home, mount_points=[usb]).path, choice.path)
            with self.assertRaisesRegex(RuntimeError, "Reconnect"):
                choose_storage(home=home, mount_points=[])

    def test_multiple_secure_usb_use_safe_internal_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            home, usb1, usb2 = [Path(td) / name for name in ("home", "usb1", "usb2")]
            for directory in (home, usb1, usb2):
                directory.mkdir()
            choice = choose_storage(home=home, mount_points=[usb1, usb2])
            self.assertEqual(choice.source, "internal")
            self.assertEqual(len(choice.usbs), 2)

    def test_preexisting_private_usb_identities_recovered(self):
        with tempfile.TemporaryDirectory() as td:
            home, usb = Path(td) / "home", Path(td) / "usb"
            home.mkdir()
            (usb / ".agent-comms").mkdir(parents=True)
            (usb / ".agent-comms" / "identities.json").write_text("keep me")
            choice = choose_storage(home=home, mount_points=[usb])
            self.assertEqual(choice.source, "usb")
            self.assertEqual((choice.path / "identities.json").read_text(), "keep me")

    def test_explicit_directory_and_cli_list_usb(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "home"
            home.mkdir()
            custom = Path(td) / "custom"
            result = choose_storage(state_dir=custom, home=home, mount_points=[])
            self.assertEqual(result.path, custom.resolve())
            self.assertEqual(result.source, "explicit")
            completed = subprocess.run(
                [sys.executable, str(ROOT / "phone" / "start.py"), "--list-usb"],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_wrong_server_vault_is_rejected(self):
        from server import create_server
        import threading
        from urllib.request import urlopen
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as other:
            srv = create_server(td, count=1000, port=0)
            thread = threading.Thread(target=srv.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{srv.server_port}"
            try:
                self.assertEqual(verify_server(url, Path(td))["instanceId"], expected_instance(Path(td)))
                with self.assertRaisesRegex(RuntimeError, "different agent server"):
                    verify_server(url, Path(other))
            finally:
                srv.shutdown()
                srv.server_close()
                thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
