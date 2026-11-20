"""Real local HTTPS lifecycle tests for the opt-in Monico public gateway.

The IPv4 address in these tests is an illustrative certificate identity.
They DO NOT assert external internet reachability or ownership of that IP.
"""
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "phone"))
from provision import provision

PUBLIC_IP = "8.8.8.8"


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(shutil.which("openssl"), "OpenSSL is required for Linux public HTTPS smoke test")
class LinuxPublicGatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "usb"
        self.state.mkdir(mode=0o700)
        provision(self.state, count=1000)
        self.port = free_port()

    def tearDown(self):
        self.exec("stop")
        self.temp.cleanup()

    def exec(self, action, *args):
        return subprocess.run(["bash", str(ROOT / "start.sh"), "--public", action,
                               "--state-dir", str(self.state), *args],
                              text=True, capture_output=True, timeout=45, cwd=ROOT)

    def test_01_prepare_launch_live_https_check_restart_and_stop(self):
        pre = self.exec("status")
        self.assertEqual(pre.returncode, 0, pre.stderr)
        self.assertFalse(json.loads(pre.stdout)["prepared"])
        prepared = self.exec("prepare", "--public-ip", PUBLIC_IP, "--port", str(self.port))
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        data = json.loads(prepared.stdout)
        self.assertFalse(data["serving"])
        self.assertFalse(data["internet_reachable_verified"])
        self.assertTrue(Path(data["public_ca_certificate"]).is_file())

        refused = self.exec("up")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("--allow-public", refused.stderr)

        running = self.exec("up", "--allow-public")
        self.assertEqual(running.returncode, 0, running.stderr)
        info = json.loads(running.stdout)
        self.assertTrue(info["local_https_running"])
        self.assertFalse(info["outside_network_verified"])
        self.assertFalse(info["external_smtp_verified"])

        same = self.exec("up", "--allow-public")
        self.assertEqual(same.returncode, 0, same.stderr)
        self.assertTrue(json.loads(same.stdout)["already_running"])

        doctor = self.exec("doctor")
        self.assertEqual(doctor.returncode, 0, doctor.stderr)
        self.assertTrue(json.loads(doctor.stdout)["local_https_running"])
        self.assertIn("DIFFERENT internet connection",
                      json.loads(doctor.stdout)["external_test_command"])

        stopped = self.exec("stop")
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertEqual(json.loads(stopped.stdout)["result"], "stopped")
        check = self.exec("status")
        self.assertFalse(json.loads(check.stdout)["local_https_running"])

        restart = self.exec("up", "--allow-public")
        self.assertEqual(restart.returncode, 0, restart.stderr)
        self.assertTrue(json.loads(restart.stdout)["local_https_running"])
        self.assertTrue(self.exec("stop").returncode == 0)

    def test_02_cannot_prepare_private_ip(self):
        bad = self.exec("prepare", "--public-ip", "192.168.1.10")
        self.assertNotEqual(bad.returncode, 0)
        self.assertFalse((self.state / "public-gateway.json").exists())

    def test_03_different_saved_ip_rejected(self):
        one = self.exec("prepare", "--public-ip", PUBLIC_IP, "--port", str(self.port))
        self.assertEqual(one.returncode, 0, one.stderr)
        other = self.exec("prepare", "--public-ip", "1.1.1.1", "--port", str(self.port))
        self.assertNotEqual(other.returncode, 0)
        self.assertIn("different IP/port", other.stderr)

    def test_04_untrusted_ca_key_never_shared_in_status(self):
        one = self.exec("prepare", "--public-ip", PUBLIC_IP, "--port", str(self.port))
        self.assertEqual(one.returncode, 0, one.stderr)
        status = self.exec("status")
        self.assertEqual(status.returncode, 0)
        self.assertNotIn("monico-ca.key", status.stdout)
        self.assertNotIn("server.key", status.stdout)
        self.assertIn("monico-ca.crt", status.stdout)
        self.assertEqual((self.state / "public-gateway.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
