#!/usr/bin/env python3
"""Real service integration: three separately authenticated agent mailboxes.

Runs only on disposable Linux CI after Postfix/Dovecot are actually started.
Exercises real SMTP over STARTTLS and IMAPS over TLS, positive and negative
authentication, inter-agent delivery, inbox isolation, and password rotation.
No third-party mail APIs and no off-host email is sent.
"""
import imaplib
import json
import os
from pathlib import Path
import smtplib
import ssl
import time
import uuid
from email.message import EmailMessage

from monico_core import Registry

DATA = Path(os.environ["MONICO_CI_DATA"])
DOMAIN = os.environ["MONICO_CI_DOMAIN"]
HOST = "mail." + DOMAIN
CREDS = json.loads((DATA / "ci-credentials.json").read_text(encoding="utf-8"))
CONTEXT = ssl.create_default_context()


def record(label, value=True):
    if not value:
        raise AssertionError(f"FAIL: {label}")
    print(f"PASS: {label}", flush=True)


def email_for(label):
    return CREDS[label]["email"]


def password_for(label):
    return CREDS[label]["mail_password"]


def smtp_login(label, password=None):
    conn = smtplib.SMTP(HOST, 587, timeout=15)
    try:
        conn.ehlo()
        assert conn.has_extn("starttls"), "Server must offer STARTTLS"
        conn.starttls(context=CONTEXT)
        conn.ehlo()
        conn.login(email_for(label), password if password is not None else password_for(label))
        return conn
    except Exception:
        conn.close()
        raise


def send(sender, recipient):
    message_id = "<" + uuid.uuid4().hex + "@" + DOMAIN + ">"
    msg = EmailMessage()
    msg["From"] = email_for(sender)
    msg["To"] = email_for(recipient)
    msg["Message-ID"] = message_id
    msg["Subject"] = "Monico real agent-to-agent delivery " + uuid.uuid4().hex[:8]
    msg.set_content("Unique private message from " + sender + " to " + recipient)
    with smtp_login(sender) as connection:
        refused = connection.send_message(msg)
        assert refused == {}, f"Postfix refused a real recipient: {refused}"
    return message_id


def wait_for_message(label, message_id, should_exist=True):
    with imaplib.IMAP4_SSL(HOST, 993, ssl_context=CONTEXT, timeout=15) as imap:
        imap.login(email_for(label), password_for(label))
        deadline = time.monotonic() + (40 if should_exist else 4)
        while True:
            status, _ = imap.select("INBOX", readonly=True)
            assert status == "OK"
            status, rows = imap.search(None, "HEADER", "Message-ID", message_id)
            assert status == "OK"
            found = bool(rows and rows[0])
            if found or not should_exist or time.monotonic() >= deadline:
                if should_exist:
                    assert found, f"Mail was not delivered to correct mailbox {label}"
                else:
                    assert not found, f"Mailbox {label} can read a different agent's message"
                return
            time.sleep(1)


def rejected_bad_imap(label, password):
    try:
        with imaplib.IMAP4_SSL(HOST, 993, ssl_context=CONTEXT, timeout=15) as imap:
            imap.login(email_for(label), password)
    except imaplib.IMAP4.error:
        return True
    return False


def rejected_bad_smtp(label, password):
    try:
        with smtp_login(label, password=password):
            return False
    except smtplib.SMTPAuthenticationError:
        return True


def rejected_without_smtp_auth():
    msg = EmailMessage()
    msg["From"] = email_for("research")
    msg["To"] = email_for("support")
    msg.set_content("No permission to submit")
    try:
        with smtplib.SMTP(HOST, 587, timeout=15) as conn:
            conn.ehlo()
            conn.starttls(context=CONTEXT)
            conn.ehlo()
            conn.send_message(msg)
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused,
            smtplib.SMTPDataError, smtplib.SMTPResponseException):
        return True
    return False


def rejected_sender_spoof():
    msg = EmailMessage()
    msg["From"] = email_for("support")
    msg["To"] = email_for("notifications")
    msg.set_content("Impersonation test -- must not be delivered")
    try:
        with smtp_login("research") as conn:
            conn.send_message(msg)
    except (smtplib.SMTPSenderRefused, smtplib.SMTPRecipientsRefused,
            smtplib.SMTPDataError, smtplib.SMTPResponseException):
        return True
    return False


def main():
    assert len(CREDS) == 3
    assert len({a["email"] for a in CREDS.values()}) == 3
    record("three unique real mailbox addresses with independent credentials")
    for label in CREDS:
        with smtp_login(label):
            pass
    record("three different agents authenticate to real Postfix SMTP over STARTTLS")

    research_to_support = send("research", "support")
    support_to_research = send("support", "research")
    notifications_to_support = send("notifications", "support")
    wait_for_message("support", research_to_support)
    wait_for_message("research", support_to_research)
    wait_for_message("support", notifications_to_support)
    record("three cross-agent messages accepted and delivered to actual IMAP inboxes")

    wait_for_message("research", research_to_support, should_exist=False)
    wait_for_message("support", support_to_research, should_exist=False)
    wait_for_message("notifications", research_to_support, should_exist=False)
    record("three independent IMAP inboxes do not show other recipients' messages")

    record("SMTP submission without authentication rejected", rejected_without_smtp_auth())
    record("SMTP wrong mail password rejected",
           rejected_bad_smtp("research", "definitely-not-the-password"))
    record("IMAP wrong mail password rejected",
           rejected_bad_imap("research", "definitely-not-the-password"))
    record("SMTP sender impersonation rejected", rejected_sender_spoof())
    record("agent credentials cannot read other agent inbox",
           rejected_bad_imap("research", password_for("support")))

    # Live Dovecot/Postfix must read rotated hashes; no restart or mock client.
    reg = Registry(DATA, DOMAIN)
    old_password = password_for("support")
    updated = reg.rotate_mail_password(
        CREDS["support"]["agent_id"], CREDS["support"]["token"]
    )
    assert updated["mail_password"] and updated["mail_password"] != old_password
    CREDS["support"]["mail_password"] = updated["mail_password"]
    record("rotating a mailbox password invalidates old IMAP login",
           rejected_bad_imap("support", old_password))
    record("rotating a mailbox password invalidates old SMTP login",
           rejected_bad_smtp("support", old_password))
    with smtp_login("support"):
        pass
    with imaplib.IMAP4_SSL(HOST, 993, ssl_context=CONTEXT, timeout=15) as imap:
        imap.login(email_for("support"), password_for("support"))
        assert imap.select("INBOX", readonly=True)[0] == "OK"
    record("rotated password works immediately with real SMTP and IMAP services")
    print("PASS: REAL_LINUX_AGENT_MAIL_TESTS (not external Internet mail)", flush=True)


if __name__ == "__main__":
    main()
