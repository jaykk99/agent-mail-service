"""Opt-in Linux autostart tests. Never change real systemd settings."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("monico_autostart", ROOT / "linux" / "autostart.py")
autostart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(autostart)


class LinuxAutostartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        self.storage = Path(self.temp.name) / "USB Drive"
        self.storage.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_private_default_user_systemd_service(self):
        unit = autostart.render_service(Path(sys.executable), ROOT,
                                        state_dir=str(self.storage))
        self.assertIn("ExecStart=", unit)
        self.assertIn("watchdog.py", unit)
        self.assertIn('"--state-dir" "' + str(self.storage) + '"', unit)
        self.assertIn("NoNewPrivileges=yes", unit)
        self.assertIn("Restart=on-failure", unit)
        self.assertNotIn("MONICO_ADMIN_KEY", unit)
        self.assertNotIn("--allow-public", unit)
        name = autostart.install_service(unit, home=self.home, enable=False)
        self.assertTrue(Path(name).exists())
        self.assertEqual(Path(name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(name).read_text(), unit)
        self.assertEqual(autostart.install_service(unit, home=self.home), name)

    def test_public_start_requires_explicit_opt_in_and_routable_ip(self):
        with self.assertRaises(ValueError):
            autostart.render_service(sys.executable, ROOT, public_ip="8.8.8.8")
        with self.assertRaises(ValueError):
            autostart.render_service(sys.executable, ROOT, allow_public=True)
        with self.assertRaises(ValueError):
            autostart.render_service(sys.executable, ROOT,
                                     public_ip="192.168.0.1", allow_public=True)
        unit = autostart.render_service(sys.executable, ROOT,
                                        public_ip="8.8.8.8", allow_public=True)
        self.assertIn('"--allow-public"', unit)
        self.assertIn('"8.8.8.8"', unit)

    def test_existing_user_unit_is_not_overwritten(self):
        unit = autostart.render_service(sys.executable, ROOT)
        path = Path(autostart.install_service(unit, home=self.home))
        with self.assertRaises(FileExistsError):
            autostart.install_service(unit + "\n# different", home=self.home)
        self.assertEqual(path.read_text(), unit)

    def test_bad_storage_directory_rejected(self):
        with self.assertRaises((ValueError, OSError)):
            autostart.render_service(sys.executable, ROOT,
                                     state_dir=str(self.home / "missing"))

    def test_service_escapes_percent_and_rejects_newline(self):
        self.assertEqual(autostart._quote("/home/a b/100%"), '"/home/a b/100%%"')
        with self.assertRaises(ValueError):
            autostart._quote("a\nExecStop=evil")


if __name__ == "__main__":
    unittest.main()
