import unittest
from selfhost.systemd_mcp import render_unit


class SystemdMCPTests(unittest.TestCase):
    def test_unprivileged_restart_and_usb_requirements(self):
        unit = render_unit("monico", "/opt/monico-mail-usb",
                           "/mnt/usb/monico", "/etc/monico/monico.env")
        self.assertIn("User=monico", unit)
        self.assertIn("EnvironmentFile=/etc/monico/monico.env", unit)
        self.assertIn("RequiresMountsFor=/mnt/usb/monico", unit)
        self.assertIn("ExecStartPre=/usr/bin/test -w /mnt/usb/monico", unit)
        self.assertIn("Restart=on-failure", unit)
        self.assertIn("NoNewPrivileges=yes", unit)
        self.assertNotIn("MONICO_ADMIN_KEY=", unit)

    def test_reject_root_or_unsafe_paths(self):
        with self.assertRaises(ValueError):
            render_unit("root", "/opt/monico", "/mnt/usb", "/etc/monico.env")
        with self.assertRaises(ValueError):
            render_unit("monico", "/opt/monico", "/mnt/USB Drive",
                        "/etc/monico.env")
        with self.assertRaises(ValueError):
            render_unit("bad user", "/opt/monico", "/mnt/usb", "/etc/monico.env")


if __name__ == "__main__":
    unittest.main()
