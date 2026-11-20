#!/usr/bin/env python3
"""Probe the legacy public Node email backend referenced by this repo.

This is *not* the Monico Linux Postfix/Dovecot service, and a healthy reply
does not prove that any real public email was sent or delivered.

Probe only the exact historical endpoint found in
cloudflare/email-worker/wrangler.toml. No API keys or private credentials.
"""
import json
import ssl
import sys
import time
import urllib.error
import urllib.request

HOST = "https://agent-mail-service.onrender.com"
TIMEOUT = 18
MAX_ATTEMPTS = 3


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(path):
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        NoRedirects(),
    )
    url = HOST + path
    req = urllib.request.Request(
        url, method="GET",
        headers={"Accept": "application/json", "User-Agent": "MonicoPublicVerification/1.0"},
    )
    try:
        with opener.open(req, timeout=TIMEOUT) as response:
            return response.status, response.read(16384)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(16384)


def probe_once():
    status, body = request("/health")
    if status != 200:
        raise RuntimeError(f"Historical public /health returned HTTP {status}")
    try:
        data = json.loads(body)
    except (ValueError, UnicodeError) as exc:
        raise RuntimeError("Historical /health did not return JSON") from exc
    if not isinstance(data, dict) or data.get("ok") is not True:
        raise RuntimeError("Historical /health did not report ok:true")
    unauthorized, _ = request("/api/me")
    if unauthorized != 401:
        raise RuntimeError(f"Historical API did not reject anonymous access (HTTP {unauthorized})")
    return {
        "probe": "historical_node_public_host",
        "host": HOST,
        "public_https_reachable_from_independent_runner": True,
        "https_certificate_verified": True,
        "anonymous_api_denied": True,
        "backend_storage_reported": data.get("storage", "unspecified"),
        "backend_domain_reported": data.get("domain", "unspecified"),
        "outbound_configured_reported": data.get("outboundConfigured"),
        "monico_linux_public_mail_verified": False,
        "real_cross_domain_email_delivered": False,
        "real_external_phone_sms_verified": False,
        "note": "Node backend reachability only; not Monico Linux public mail or calling",
    }


def main():
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            print(json.dumps(probe_once(), indent=2), flush=True)
            return
        except (RuntimeError, OSError, TimeoutError, urllib.error.URLError) as exc:
            print(f"Attempt {attempt}/{MAX_ATTEMPTS}: {type(exc).__name__}: {exc}",
                  file=sys.stderr, flush=True)
            if attempt < MAX_ATTEMPTS:
                time.sleep(5)
    print(json.dumps({
        "probe": "historical_node_public_host",
        "host": HOST,
        "public_https_reachable_from_independent_runner": False,
        "monico_linux_public_mail_verified": False,
        "real_cross_domain_email_delivered": False,
        "real_external_phone_sms_verified": False,
        "note": "A failure here does not prove the user has no other public Linux host.",
    }, indent=2), flush=True)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
