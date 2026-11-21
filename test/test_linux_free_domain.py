"""Free-domain claim and check tests: only OK is accepted, tokens never leak, no network."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import struct
import sys
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


def dns_response(name, addresses, query_id=0x1234, rcode=0):
    """Build a DNS response with compressed A answers for parser tests."""
    header = struct.pack("!HHHHHH", query_id, 0x8180 | rcode, 1, len(addresses), 0, 0)
    question = free_domain._encode_name(name) + struct.pack("!HH", 1, 1)
    answers = b""
    for address in addresses:
        answers += (
            b"\xc0\x0c"  # pointer back to the question name
            + struct.pack("!HHIH", 1, 1, 60, 4)
            + socket.inet_aton(address)
        )
    return header + question + answers


class DnsParserTests(unittest.TestCase):
    def test_name_is_encoded_as_dns_labels(self):
        self.assertEqual(
            free_domain._encode_name("monico-abc123.duckdns.org"),
            b"\x0dmonico-abc123\x07duckdns\x03org\x00",
        )

    def test_compressed_a_answers_are_read(self):
        response = dns_response("a.test", ["8.8.8.8", "1.1.1.1"])
        self.assertEqual(free_domain._parse_a(response, 0x1234), ["8.8.8.8", "1.1.1.1"])

    def test_nxdomain_has_no_answers(self):
        self.assertEqual(free_domain._parse_a(dns_response("a.test", [], rcode=3), 0x1234), [])

    def test_response_for_another_query_is_refused(self):
        with self.assertRaises(free_domain.DomainError):
            free_domain._parse_a(dns_response("a.test", ["8.8.8.8"], query_id=0x9999), 0x1234)

    def test_truncated_response_is_refused(self):
        with self.assertRaises(free_domain.DomainError):
            free_domain._parse_a(b"\x12\x34\x81", 0x1234)


class CheckTests(unittest.TestCase):
    DOMAIN = "monico-abc123.duckdns.org"

    def test_matching_a_record_passes(self):
        result = free_domain.check(self.DOMAIN, PUBLIC_IP, resolve=lambda name: [PUBLIC_IP])
        self.assertEqual(result["domain"], self.DOMAIN)
        self.assertEqual(result["ip"], PUBLIC_IP)
        self.assertTrue(result["match"])

    def test_mismatch_fails_and_names_both_addresses(self):
        with self.assertRaises(free_domain.DomainError) as caught:
            free_domain.check(self.DOMAIN, PUBLIC_IP, resolve=lambda name: ["203.0.113.9"])
        message = str(caught.exception)
        self.assertIn("203.0.113.9", message)
        self.assertIn(PUBLIC_IP, message)

    def test_missing_a_record_fails(self):
        with self.assertRaisesRegex(free_domain.DomainError, "no A record"):
            free_domain.check(self.DOMAIN, PUBLIC_IP, resolve=lambda name: [])

    def test_bare_name_gets_the_duckdns_suffix(self):
        seen = []
        free_domain.check(
            "monico-abc123", PUBLIC_IP, resolve=lambda name: seen.append(name) or [PUBLIC_IP]
        )
        self.assertEqual(seen, [self.DOMAIN])

    def test_expected_ip_defaults_to_the_public_address(self):
        result = free_domain.check(
            self.DOMAIN,
            None,
            resolve=lambda name: [PUBLIC_IP],
            get=lambda url, timeout=15: PUBLIC_IP,
        )
        self.assertEqual(result["ip"], PUBLIC_IP)

    def test_private_or_ipv6_expectation_is_refused(self):
        for bad in ("10.0.0.5", "127.0.0.1", "2001:db8::1", "not-an-ip"):
            with self.assertRaises(free_domain.DomainError):
                free_domain.check(self.DOMAIN, bad, resolve=lambda name: [PUBLIC_IP])

    def test_invalid_hostname_is_refused(self):
        for bad in ("", "..", "monico abc", "-leading.duckdns.org", "a..b"):
            with self.assertRaises(free_domain.DomainError):
                free_domain.check(bad, PUBLIC_IP, resolve=lambda name: [PUBLIC_IP])

    def test_unreachable_resolvers_raise_a_useful_error(self):
        with patch.object(
            free_domain, "_query_a", side_effect=free_domain.DomainError("could not query 8.8.8.8")
        ):
            with patch.object(free_domain.socket, "getaddrinfo", side_effect=socket.gaierror("no")):
                with self.assertRaisesRegex(free_domain.DomainError, "no A record"):
                    free_domain.resolve_a(self.DOMAIN, servers=("8.8.8.8",))


def run_check_cli(argv, resolved):
    """Run main() in-process with DNS injected; return stdout and the exit code."""
    out = io.StringIO()
    code = 0
    with patch.object(sys, "argv", ["free_domain.py"] + argv):
        with patch.object(free_domain, "resolve_a", return_value=resolved):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                try:
                    free_domain.main()
                except SystemExit as exc:
                    code = exc.code
    return out.getvalue(), code


class CheckCliTests(unittest.TestCase):
    def test_check_exits_zero_on_a_match(self):
        out, code = run_check_cli(
            ["--check", "monico-abc123.duckdns.org", "--expect-ip", PUBLIC_IP], [PUBLIC_IP]
        )
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["match"])

    def test_check_exits_nonzero_on_a_mismatch(self):
        out, code = run_check_cli(
            ["--check", "monico-abc123.duckdns.org", "--expect-ip", PUBLIC_IP], ["203.0.113.9"]
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")

    def test_check_does_not_need_a_token(self):
        with patch.dict("os.environ", {}, clear=True):
            out, code = run_check_cli(["--check", "monico-abc123", "--expect-ip", PUBLIC_IP], [PUBLIC_IP])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["domain"], "monico-abc123.duckdns.org")

    def test_check_fails_when_the_name_has_no_record(self):
        out, code = run_check_cli(
            ["--check", "monico-abc123.duckdns.org", "--expect-ip", PUBLIC_IP], []
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")


if __name__ == "__main__":
    unittest.main()
