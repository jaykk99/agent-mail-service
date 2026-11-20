import tempfile
import unittest
from pathlib import Path
from monico_core import Registry
from selfhost.nginx_mcp import render_nginx_mcp
from selfhost.prepare_live import prepare


class MCPHttpsTests(unittest.TestCase):
    def test_proxy_is_https_only_and_preserves_bearer(self):
        conf = render_nginx_mcp("my-real-mail.org",
                                "/etc/ssl/myhost/fullchain.pem",
                                "/etc/ssl/myhost/privkey.pem")
        self.assertIn("server_name mcp.my-real-mail.org", conf)
        self.assertIn("listen 443 ssl;", conf)
        self.assertIn("listen [::]:443 ssl;", conf)
        self.assertIn("listen [::]:80;", conf)
        self.assertIn("ssl_protocols TLSv1.2 TLSv1.3", conf)
        self.assertIn("proxy_pass http://127.0.0.1:8787;", conf)
        self.assertIn("proxy_set_header Authorization $http_authorization;", conf)
        self.assertIn("limit_req zone=monico_mcp burst=30 nodelay", conf)
        self.assertIn("return 404;", conf)

    def test_reject_bad_rate(self):
        with self.assertRaises(ValueError):
            render_nginx_mcp("my-real-mail.org", "/tmp/cert", "/tmp/key", 0)
        with self.assertRaises(ValueError):
            render_nginx_mcp("my-real-mail.org", "/tmp/cert", "/tmp/key", 200)

    def test_optional_staging_only_when_tls_files_provided(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "usb"
            data.mkdir()
            Registry(data, "my-real-mail.org").register("agent_001", "sales")
            cert, key = root / "cert.pem", root / "key.pem"
            cert.write_text("test fixture")
            key.write_text("test fixture")
            destination = root / "staged"
            kwargs = dict(domain="my-real-mail.org", data=str(data),
                          public_ip="1.1.1.1", ns1_ip="1.1.1.1",
                          ns2_ip="8.8.8.8", vmail_uid=2001, vmail_gid=2001,
                          cert=str(cert), key=str(key), output=str(destination),
                          mcp_cert=str(cert), mcp_key=str(key))
            result = prepare(**kwargs)
            self.assertTrue(result["mcp_https_staged"])
            self.assertFalse(result["mcp_https_publicly_verified"])
            self.assertTrue((destination / "nginx-monico-mcp.conf").is_file())
            self.assertIn("mcp    IN A", (destination / "db.my-real-mail.org").read_text())


if __name__ == "__main__":
    unittest.main()
