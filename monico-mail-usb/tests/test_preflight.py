import tempfile
import unittest
from selfhost.preflight import check_environment


class PreflightTests(unittest.TestCase):
    def test_valid_local_inputs_report_missing_external_requirements(self):
        with tempfile.TemporaryDirectory() as data:
            result = check_environment(data, "myrealmail.net", "mail.myrealmail.net",
                                       "1.1.1.1", live=False)
            required = {r["check"]: r for r in result["checks"] if r["level"] == "required"}
            self.assertTrue(required["data-directory"]["passed"])
            self.assertTrue(required["sqlite-write"]["passed"])
            self.assertTrue(required["public-ip"]["passed"])
            self.assertEqual(result["ready_for_next_setup_step"], True)

    def test_invalid_domain_and_ip_fail_closed(self):
        with tempfile.TemporaryDirectory() as data:
            result = check_environment(data, "mail.example.invalid", "mail.mail.example.invalid",
                                       "192.168.0.5", live=False)
            self.assertFalse(result["ready_for_next_setup_step"])
            failed = {r["check"] for r in result["checks"] if not r["passed"]}
            self.assertIn("public-ip", failed)
            self.assertIn("delegated-format", failed)

    def test_missing_drive_fails(self):
        with tempfile.TemporaryDirectory() as data:
            result = check_environment(data + "/missing", "myrealmail.net",
                                       "mail.myrealmail.net", "1.1.1.1", live=False)
            self.assertFalse(result["ready_for_next_setup_step"])
            self.assertFalse(next(r for r in result["checks"]
                                  if r["check"] == "data-directory")["passed"])


if __name__ == "__main__":
    unittest.main()
