#!/usr/bin/env python3
"""Create local OpenDKIM keys and STAGED Postfix milter configuration.

No API/mail hosting account. A DKIM TXT record must be published in delegated
DNS and Postfix must actually use the signer for outbound mail.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess

try:
    from .generate_config import check_domain
except ImportError:
    from generate_config import check_domain

_SELECTOR = re.compile(r"[a-z][a-z0-9-]{0,32}\Z")


def generate_key(domain, folder, selector="mail", command="opendkim-genkey"):
    domain = check_domain(domain)
    if not _SELECTOR.fullmatch(selector):
        raise ValueError("Invalid DKIM selector")
    folder = Path(folder).expanduser().resolve()
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    private = folder / (selector + ".private")
    public = folder / (selector + ".txt")
    if private.exists() or public.exists():
        raise FileExistsError("DKIM key exists; refusing overwrite or accidental key rotation")
    if not shutil.which(command):
        raise RuntimeError("Install the OpenDKIM tools package, then rerun this generator")
    # OpenDKIM's bundled key generator makes a new RSA-2048 signing pair.
    subprocess.run([command, "-b", "2048", "-s", selector, "-d", domain, "-D", str(folder)],
                   check=True, timeout=45)
    if not private.is_file() or not public.is_file():
        raise RuntimeError("OpenDKIM did not create both expected key files")
    private.chmod(0o600)
    public.chmod(0o600)
    return private, public


def signing_templates(domain, private_key_path, selector="mail"):
    domain = check_domain(domain)
    if not _SELECTOR.fullmatch(selector):
        raise ValueError("Invalid DKIM selector")
    key = Path(private_key_path).resolve()
    if any(c in str(key) for c in ("\n", "\r", "\x00")):
        raise ValueError("Invalid DKIM key path")
    table_entry = f"{selector}._domainkey.{domain} {domain}:{selector}:{key}\n"
    sender_entry = f"*@{domain} {selector}._domainkey.{domain}\n"
    trusted = "127.0.0.1\n::1\nlocalhost\n"
    # A localhost TCP milter avoids chroot socket path confusion.
    daemon = (
        "Syslog yes\nMode sv\nCanonicalization relaxed/simple\n"
        "Socket inet:8891@127.0.0.1\n"
        "KeyTable refile:/etc/opendkim/KeyTable\n"
        "SigningTable refile:/etc/opendkim/SigningTable\n"
        "InternalHosts /etc/opendkim/TrustedHosts\n"
    )
    postfix = (
        "# Review alongside any existing milters and server policy.\n"
        "smtpd_milters = inet:127.0.0.1:8891\n"
        "non_smtpd_milters = $smtpd_milters\n"
        "milter_default_action = tempfail\n"
        "milter_protocol = 6\n"
    )
    return {"KeyTable": table_entry, "SigningTable": sender_entry,
            "TrustedHosts": trusted, "opendkim.conf.fragment": daemon,
            "postfix-milter.cf.fragment": postfix}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True, help="Your actually delegated domain")
    parser.add_argument("--output", default=".generated/dkim")
    parser.add_argument("--selector", default="mail")
    args = parser.parse_args()
    folder = Path(args.output).expanduser().resolve()
    private, txt = generate_key(args.domain, folder, args.selector)
    templates = signing_templates(args.domain, private, args.selector)
    for name, content in templates.items():
        p = folder / name
        p.write_text(content, encoding="utf-8")
        p.chmod(0o600)
    print(f"PRIVATE KEY: {private} — keep secret and install with opendkim-only permissions")
    print(f"PUBLIC DNS TXT: {txt} — publish this record at the delegated domain")
    print(f"STAGED TEMPLATES: {folder} — review and configure OpenDKIM/Postfix manually")
    print("The generated private key is NOT automatically installed or used.")
    print("Public delivery requires active DKIM signing, DNS MX/NS/SPF/DMARC/PTR, port 25 and TLS.")


if __name__ == "__main__":
    main()
