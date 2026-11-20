#!/usr/bin/env python3
"""Import ONLY display labels from jaykk99/Calling-linux into Monico's agent directory.

Calling-linux's +1 201-555 numbers, SIP registrations, SMS counters, demo
verification codes and seeded delivery flags are NOT real public routes.
Those fields must never migrate into a live account's transport status.
This optional script needs no extra Python packages.
"""
import argparse
import json
import os
from pathlib import Path

from provision import BASE_EXTENSION, MAX_AGENTS, atomic_write, provision
from usb_storage import choose_storage

MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_LABEL_CHARS = 80
TARGET_FILE = "calling-linux-labels.json"


def sanitized_label(label):
    if not isinstance(label, str):
        return None
    value = label.strip()
    if not value or len(value) > MAX_LABEL_CHARS or any(ord(c) < 32 or ord(c) == 127 for c in value):
        return None
    return value


def parse_fleet(source):
    """Return safe agent display names mapped from legacy 1..1000 to 2000..2999."""
    source = Path(source).expanduser()
    if not source.is_file() or source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("Source must be a local Calling-linux state JSON file <= 8 MiB")
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid Calling-linux state JSON") from exc
    if not isinstance(data, dict) or not isinstance(data.get("numbers"), list):
        raise ValueError("Expected a Calling-linux export with a numbers array")
    if len(data["numbers"]) > MAX_AGENTS:
        raise ValueError("More than 1,000 source entries; refusing ambiguous import")
    aliases = {}
    seen = set()
    for item in data["numbers"]:
        if not isinstance(item, dict) or type(item.get("extension")) is not int:
            raise ValueError("Every entry must have an integer legacy extension")
        legacy = item["extension"]
        if legacy < 1 or legacy > MAX_AGENTS or legacy in seen:
            raise ValueError("Duplicate or out-of-range legacy extension")
        seen.add(legacy)
        label = sanitized_label(item.get("label"))
        if label:
            aliases[str(BASE_EXTENSION + legacy - 1)] = {
                "displayName": label,
                "legacyExtension": legacy,
            }
    return {"schema": 1, "source": "Calling-linux",
            "publicTelephoneNumbersProvisioned": False,
            "publicSmsRoutesProvisioned": False,
            "publicEmailRoutesProvisioned": False,
            "labels": aliases}


def write_import(source, state_dir):
    state_dir = Path(state_dir).expanduser().resolve(strict=True)
    if not state_dir.is_dir():
        raise ValueError("Existing Monico state directory is required")
    identities = state_dir / "identities.json"
    if not identities.is_file():
        raise ValueError("Run bash start.sh first to provision the 1,000 persistent agents")
    known = json.loads(identities.read_text(encoding="utf-8")).get("extensions")
    if not isinstance(known, dict):
        raise ValueError("Invalid Monico agent identity store")
    result = parse_fleet(source)
    if any(extension not in known for extension in result["labels"]):
        raise ValueError("Source entries do not fit the existing agent count")
    target = state_dir / TARGET_FILE
    if target.exists():
        raise FileExistsError("An import already exists; refusing silent overwrite")
    atomic_write(target, json.dumps(result, indent=2) + "\n", mode=0o600)
    return {"imported_labels": len(result["labels"]), "path": str(target),
            "public_phone_numbers": False,
            "public_carrier_sms": False,
            "public_internet_email": False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True, help="Your local Calling-linux/data/carrier-state.json")
    p.add_argument("--state-dir", help="Existing private Monico state path; otherwise auto-discover USB")
    p.add_argument("--apply", action="store_true", help="Actually write a safe, private label mapping")
    args = p.parse_args()
    try:
        if args.apply:
            state = choose_storage(state_dir=args.state_dir).path
            result = write_import(args.source, state)
        else:
            data = parse_fleet(args.source)
            result = {"dry_run": True, "matching_labels": len(data["labels"]),
                      "public_phone_numbers": False, "public_carrier_sms": False,
                      "to_apply": "Re-run with --apply after starting Monico"}
    except (OSError, ValueError, RuntimeError, KeyError, FileExistsError) as exc:
        p.error(str(exc))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
