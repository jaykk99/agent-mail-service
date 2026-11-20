"""Choose safe, persistent Linux storage without asking for USB volume names.

Detection is advisory. Credentials are stored on a USB only when its
filesystem honors Unix private permissions, otherwise in Linux home.
"""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import stat
import tempfile

USB_SUBDIR = ".agent-comms"
_CHROMEOS = Path("/mnt/chromeos/removable")
_OCTAL = re.compile(r"\\([0-7]{3})")


def _decode_mount(text):
    return _OCTAL.sub(lambda m: chr(int(m.group(1), 8)), text)


def _mounted_removables():
    """Return likely removable paths mounted directly into Linux."""
    results = set()
    try:
        mounts = Path("/proc/self/mountinfo").read_text().splitlines()
    except OSError:
        return results
    for line in mounts:
        left, separator, right = line.partition(" - ")
        if not separator:
            continue
        parts = left.split()
        if len(parts) < 5:
            continue
        mount = Path(_decode_mount(parts[4]))
        device = right.split()[-1] if right.split() else ""
        if mount.parts[:2] in (("/", "media"), ("/", "mnt")) or str(mount).startswith("/run/media/"):
            if (device.startswith("/dev/") or str(mount).startswith("/run/media/")) and mount.is_dir():
                results.add(mount)
    return results


def discover_usb(roots=None):
    """Find shared Chromebook USB folders and Linux-mounted removable media.

    The optional roots allow deterministic testing without attached hardware.
    """
    results = set()
    if roots is None:
        roots = [_CHROMEOS, Path("/media"), Path("/run/media")]
    for root in roots:
        if not root.is_dir():
            continue
        try:
            children = [p for p in root.iterdir() if p.is_dir() and not p.is_symlink()]
        except OSError:
            continue
        # /mnt/chromeos/removable/<USB> are actual user volumes.
        # /run/media/<user>/<USB> may need another level.
        for child in children:
            if str(root) == "/run/media" or str(root) == "/media":
                try:
                    descendants = [p for p in child.iterdir() if p.is_dir() and not p.is_symlink()]
                except OSError:
                    descendants = []
                results.update(descendants if descendants else [child])
            else:
                results.add(child)
    if roots == [_CHROMEOS, Path("/media"), Path("/run/media")]:
        results.update(_mounted_removables())
    # Avoid symlinks to locations outside the mounted drive.
    return sorted((p.resolve() for p in results if p.exists() and not p.is_symlink()), key=str)


def supports_private_storage(root):
    """Probe permissions without writing user data or leaving secret files."""
    if not root.is_dir() or not os.access(root, os.W_OK | os.X_OK):
        return False
    try:
        with tempfile.TemporaryDirectory(prefix=".agent-permission-test-", dir=root) as tmp:
            path = Path(tmp)
            os.chmod(path, 0o700)
            if stat.S_IMODE(path.stat().st_mode) != 0o700:
                return False
            test = path / "private"
            with test.open("x") as f:
                f.write("test")
            os.chmod(test, 0o600)
            return stat.S_IMODE(test.stat().st_mode) == 0o600
    except (OSError, PermissionError):
        return False


@dataclass(frozen=True)
class Choice:
    path: Path
    source: str
    usbs: tuple
    info: str


def choose_storage(*, state_dir=None, home=None, mount_points=None):
    """Select one stable data directory, pin selection across restarts.

    A missing previously selected USB causes an error, NOT silent key rotation.
    """
    home = Path(home or Path.home()).expanduser().resolve()
    usbs = tuple(discover_usb() if mount_points is None else (Path(p).resolve() for p in mount_points))
    if state_dir:
        requested = Path(state_dir).expanduser().resolve()
        requested.mkdir(parents=True, exist_ok=True, mode=0o700)
        return Choice(requested, "explicit", usbs, "Using explicitly configured state directory")

    config = home / ".config" / "agent-comms"
    marker = config / "storage.json"
    if marker.exists():
        data = json.loads(marker.read_text(encoding="utf-8"))
        selected = Path(data["path"]).expanduser().resolve()
        source = data["source"]
        if source == "usb" and not any(selected == usb / USB_SUBDIR for usb in usbs):
            raise RuntimeError("Previously selected USB is missing. Reconnect that drive; existing agent identities are protected.")
        if not selected.is_dir():
            raise RuntimeError(f"Saved agent data directory is missing: {selected}. Refusing to create new identities.")
        if not supports_private_storage(selected):
            raise RuntimeError(f"Saved storage no longer supports private files: {selected}. Refusing unsafe startup.")
        return Choice(selected, source, usbs, "Reusing saved agent identities")

    internal = home / ".local" / "share" / "agent-comms"
    # Preserve old installations before considering fresh USBs.
    if (internal / "identities.json").exists():
        choice = internal
        source = "internal"
        info = "Reusing existing Linux identities"
    else:
        found = [usb for usb in usbs if supports_private_storage(usb)]
        installed = [usb for usb in found if (usb / USB_SUBDIR / "identities.json").exists()]
        if len(installed) == 1:
            choice = installed[0] / USB_SUBDIR
            source = "usb"
            info = "Recovered existing agent identities from USB"
        elif len(installed) > 1:
            raise RuntimeError("Several USB drives contain agent identities. Disconnect extras before starting to avoid mixing identities.")
        elif len(found) == 1:
            choice = found[0] / USB_SUBDIR
            source = "usb"
            info = "Automatically selected the only USB supporting private Linux permissions"
        else:
            choice = internal
            source = "internal"
            info = ("Multiple secure USBs found; using Linux storage to avoid choosing the wrong drive"
                    if len(found) > 1 else "No USB suitable for private credentials; using Linux storage")

    choice.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(choice, 0o700)
    if not supports_private_storage(choice):
        raise RuntimeError(f"Chosen storage cannot securely save credentials: {choice}")
    config.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(config, 0o700)
    fd, temp = tempfile.mkstemp(prefix=".storage-", dir=config)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({"source": source, "path": str(choice)}, f)
            f.write("\n")
        os.chmod(temp, 0o600)
        os.replace(temp, marker)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return Choice(choice, source, usbs, info)
