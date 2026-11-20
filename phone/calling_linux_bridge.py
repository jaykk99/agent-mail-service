#!/usr/bin/env python3
"""Live bridge from Monico agent phone/mail to a jaykk99/Calling-linux server.

Standard library only. Talking to Calling-linux is optional: when its
server is down, slow, or returns junk, every call reports ``live: False``
instead of inventing fleet state. Nothing here sends mail, places calls,
or touches a public phone number.

Environment:
  CALLING_LINUX_URL  base URL of the Calling-linux server
                     (default http://127.0.0.1:3001)
"""
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_URL = "http://127.0.0.1:3001"
DEFAULT_TIMEOUT = 3.0
MAX_BODY_BYTES = 8 * 1024 * 1024

_LABEL_BAD = re.compile(r"[\x00-\x1f\x7f]")


def calling_linux_url():
    value = (os.environ.get("CALLING_LINUX_URL") or DEFAULT_URL).strip()
    if not value.startswith(("http://", "https://")):
        raise ValueError("CALLING_LINUX_URL must be an http(s) URL")
    return value.rstrip("/")


def sanitized_label(label):
    """Same display-label rule as calling_linux_import.parse_fleet."""
    if not isinstance(label, str):
        return None
    value = label.strip()
    if not value or len(value) > 80 or _LABEL_BAD.search(value):
        return None
    return value


class CallingLinuxBridge:
    """Tiny read-only HTTP client for a Calling-linux server."""

    def __init__(self, base_url=None, timeout=DEFAULT_TIMEOUT):
        if base_url is None:
            base_url = calling_linux_url()
        if not str(base_url).startswith(("http://", "https://")):
            raise ValueError("CALLING_LINUX_URL must be an http(s) URL")
        self.base_url = str(base_url).rstrip("/")
        self.timeout = timeout

    def _get(self, path):
        req = Request(self.base_url + path, headers={"Accept": "application/json"})
        try:
            with urlopen(req, timeout=self.timeout) as res:
                raw = res.read(MAX_BODY_BYTES + 1)
                if len(raw) > MAX_BODY_BYTES:
                    return None, "response too large"
                return json.loads(raw.decode("utf-8")), None
        except HTTPError as exc:
            return None, f"HTTP {exc.code}"
        except (URLError, OSError, ValueError, UnicodeDecodeError) as exc:
            return None, type(exc).__name__

    def _post(self, path):
        req = Request(self.base_url + path, data=b"{}",
                      headers={"Accept": "application/json",
                               "Content-Type": "application/json"},
                      method="POST")
        try:
            with urlopen(req, timeout=max(self.timeout, 10.0)) as res:
                raw = res.read(MAX_BODY_BYTES + 1)
                if len(raw) > MAX_BODY_BYTES:
                    return None, "response too large"
                return json.loads(raw.decode("utf-8")), None
        except HTTPError as exc:
            return None, f"HTTP {exc.code}"
        except (URLError, OSError, ValueError, UnicodeDecodeError) as exc:
            return None, type(exc).__name__

    def status(self):
        """Live capabilities of the Calling-linux server, or live: False."""
        payload, error = self._get("/api/system/capabilities")
        if payload is None or not isinstance(payload, dict):
            return {"live": False, "url": self.base_url,
                    "error": error or "unreachable"}
        readiness = payload.get("readiness1000") or {}
        embedded = payload.get("embeddedServices") or {}
        return {
            "live": True,
            "url": self.base_url,
            "sip": bool(embedded.get("sipActive")),
            "smtp": bool(embedded.get("smtpActive")),
            "turn": bool(embedded.get("turnConfigured")),
            "imap": bool(embedded.get("imapListening")),
            "sipPort": embedded.get("sipUdpPort"),
            "smtpPort": embedded.get("smtpListenPort"),
            "sipRegisteredLines": len(embedded.get("sipRegisteredLines") or []),
            "webrtcOnlineLines": len(embedded.get("webrtcOnlineLines") or []),
            "canRunSelfHosted1000": bool(readiness.get("canRunSelfHosted1000")),
            "canSendLiveSmtp": bool(readiness.get("canSendLiveSmtp")),
            "canTerminateCalls": bool(readiness.get("canTerminateCalls")),
            "warnings": readiness.get("warnings") or [],
        }

    def fleet_labels(self):
        """Display labels keyed by legacy extension 1..1000, or live: False.

        Only labels cross the bridge. Numbers, OTPs, counters, routes and
        credentials are dropped here, same as calling_linux_import.
        """
        payload, error = self._get("/api/numbers?limit=1000&page=1")
        if payload is None or not isinstance(payload.get("numbers"), list):
            return {"live": False, "url": self.base_url,
                    "error": error or "unreachable", "labels": {}}
        labels = {}
        for item in payload["numbers"]:
            if not isinstance(item, dict) or type(item.get("extension")) is not int:
                continue
            label = sanitized_label(item.get("label"))
            if label:
                labels[item["extension"]] = label
        return {"live": True, "url": self.base_url, "labels": labels}

    def verify_e2e(self):
        """Run Calling-linux's own live self-test suite, or live: False."""
        payload, error = self._post("/api/system/verify-e2e")
        if payload is None or not isinstance(payload, dict):
            return {"live": False, "url": self.base_url,
                    "error": error or "unreachable"}
        checks = payload.get("checks")
        if not isinstance(checks, list):
            return {"live": False, "url": self.base_url,
                    "error": "unexpected verify-e2e response"}
        by_id = {c.get("id"): c.get("status") for c in checks
                 if isinstance(c, dict)}
        return {
            "live": True,
            "url": self.base_url,
            "timestamp": payload.get("timestamp"),
            "passed": payload.get("passedCount"),
            "warnings": payload.get("warningCount"),
            "failed": payload.get("failedCount"),
            "checks": {
                "identity": by_id.get("unified-identity"),
                "smtp": by_id.get("smtp-live"),
                "sip": by_id.get("sip-udp"),
                "turn": by_id.get("coturn-relay"),
                "imap": by_id.get("dovecot-imap"),
                "tls": by_id.get("tls-cert"),
            },
        }
