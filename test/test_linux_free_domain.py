"""Free-domain claim tests: only OK is accepted, tokens never leak, no network."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("monico_free_domain", ROOT / "linux" / "free_domain.py")
free_domain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(free_domain)

TOKEN = "12345678-1234-1234-1234-123456789abc"
PUBLIC_IP = "8.8.8.8"


def fake_get(answers):
    """Return a GET stub that pops scripted answers and records URLs."""
    seen = []

    def _get(url, timeout=15):
        seen.append(url)
        return answers.pop(0) if answers else "KO"

    return _get, seen


class FreeDomainTests(unittest.TestCase):
    def test_first_accepted_name_is_claimed(self):
        get, seen = fake_get(["OK"])
        with patch.object(free_domain, "candidate", return_value="monico-abc123"):
            result = free_domain.claim(TOKEN, PUBLIC_IP, get=get)
        self.assertEqual(result["domain"], "monico-abc123.duckdns.org")
        self.assertEqual(result["ip"], PUBLIC_IP)
        self.assertEqual(result["taken"], [])
        self.assertIn("domains=monico-abc123", seen[0])
        self.assertIn("ip=8.8.8.8", seen[0])

    def test_taken_names_are_skipped_not_reused(self):
        get, _ = fake_get(["KO", "OK"])
        names = iter(("monico-taken1", "monico-free22"))
        with patch.object(free_domain, "candidate", side_effect=lambda prefix="monico": next(names)):
            result = free_domain.claim(TOKEN, PUBLIC_IP, attempts=2, get=get)
        self.assertEqual(result["domain"], "monico-free22.duckdns.org")
        self.assertEqual(result["taken"], ["monico-taken1.duckdns.org"])

    def test_rejected_token_raises_without_leaking_it(self):
        get, _ = fake_get(["KO", "KO", "KO"])
        with patch.object(free_domain, "candidate", side_effect=["monico-aaaaaa", "monico-bbbbbb", "monico-cccccc"]):
            with self.assertRaises(free_domain.DomainError) as caught:
                free_domain.claim(TOKEN, PUBLIC_IP, attempts=3, get=get)
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_unexpected_answer_is_an_error(self):
        get, _ = fake_get(["badauth"])
        with patch.object(free_domain, "candidate", return_value="monico-aaaaaa"):
            with self.assertRaisesRegex(free_domain.DomainError, "unexpected DuckDNS"):
                free_domain.claim(TOKEN, PUBLIC_IP, get=get)

    def test_token_format_is_checked(self):
        for bad in ("", "short", "has spaces here", None):
            with self.assertRaises(free_domain.DomainError):
                free_domain.validate_token(bad)

    def test_private_or_ipv6_address_is_refused(self):
        for bad in ("10.0.0.5", "127.0.0.1", "2001:db8::1", "not-an-ip"):
            with self.assertRaises(free_domain.DomainError):
                free_domain.claim(TOKEN, bad, get=lambda url, timeout=15: "OK")

    def test_public_ip_detection_is_validated(self):
        with self.assertRaises(free_domain.DomainError):
            free_domain.claim(TOKEN, None, get=lambda url, timeout=15: "10.1.2.3")

    def test_generated_names_are_duckdns_safe(self):
        for prefix in ("monico", "My Agent!", "", "--"):
            name = free_domain.candidate(prefix)
            self.assertRegex(name, r"^[a-z0-9][a-z0-9-]{1,62}$")
            self.assertNotIn("--", name)

    def test_cli_requires_a_token_in_the_environment(self):
        import subprocess
        proc = subprocess.run(
            ["python3", str(ROOT / "linux" / "free_domain.py"), "--ip", PUBLIC_IP],
            capture_output=True, text=True, timeout=30,
            env={"PATH": "/usr/bin:/bin", "DUCKDNS_TOKEN": ""},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("token", proc.stderr.lower())
        self.assertNotIn(TOKEN, proc.stderr)
        json.dumps({})  # keep the import used for clarity of intent


if __name__ == "__main__":
    unittest.main()
