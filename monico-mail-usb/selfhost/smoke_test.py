#!/usr/bin/env python3
"""Live test: send to your own mailbox using local SMTP/IMAP with real TLS.

Requires a running and correctly configured Postfix/Dovecot stack and trusted
certificate. It does not contact any third-party mailbox provider.
"""
import argparse
from email.message import EmailMessage
from email.utils import make_msgid
from getpass import getpass
import imaplib
import smtplib
import ssl
import sys
import time


def smoke_test(host, address, password, timeout=60):
    if not host or not address or "@" not in address:
        raise ValueError("Host and full mailbox address are required")
    context = ssl.create_default_context()
    message = EmailMessage()
    message["From"] = address
    message["To"] = address
    message["Subject"] = "Monico self-hosted SMTP/IMAP delivery test"
    message_id = make_msgid(domain=address.split("@", 1)[1])
    message["Message-ID"] = message_id
    message.set_content("This message verifies that my own Linux SMTP to IMAP pipeline works.")
    with smtplib.SMTP(host, 587, timeout=20) as smtp:
        smtp.ehlo()
        smtp.starttls(context=context)
        smtp.ehlo()
        smtp.login(address, password)
        smtp.send_message(message)
    print("SMTP accepted the message (not yet proof of delivery).", flush=True)

    deadline = time.monotonic() + timeout
    with imaplib.IMAP4_SSL(host, 993, ssl_context=context, timeout=20) as imap:
        imap.login(address, password)
        while time.monotonic() < deadline:
            status, _ = imap.select("INBOX", readonly=True)
            if status != "OK":
                raise RuntimeError("Unable to select INBOX")
            status, matches = imap.search(None, "HEADER", "Message-ID", message_id)
            if status == "OK" and matches and matches[0]:
                print("PASS: message delivered to authenticated IMAP INBOX.")
                return True
            time.sleep(3)
    raise TimeoutError("SMTP accepted message, but IMAP delivery was not observed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="TLS hostname, e.g. mail.yourdomain.tld")
    parser.add_argument("--email", required=True, help="Full self-hosted mailbox address")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()
    password = getpass("Mailbox IMAP/SMTP password (hidden): ")
    if not password:
        parser.error("Password is required")
    try:
        smoke_test(args.host, args.email, password, args.timeout)
    except (OSError, ValueError, TimeoutError, RuntimeError, smtplib.SMTPException,
            imaplib.IMAP4.error) as exc:
        print(f"FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
