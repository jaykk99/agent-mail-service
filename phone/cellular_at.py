#!/usr/bin/env python3
"""Optional *hardware* SMS driver using Linux serial AT commands.

No cloud API, pip package or ModemManager. A compatible USB cellular modem,
valid SIM and carrier service are STILL required for actual SMS delivery.
Never called automatically by the 1,000-agent MCP bridge.
"""
import argparse
import fcntl
import os
from pathlib import Path
import re
import select
import termios
import time
import tty

NUMBER_RE = re.compile(r"^\+[1-9][0-9]{7,14}$")


def list_serial_modems(dev="/dev"):
    directory = Path(dev)
    candidates = []
    for pattern in ("ttyUSB*", "ttyACM*"):
        candidates.extend(str(p) for p in directory.glob(pattern) if p.exists())
    return sorted(set(candidates))


class ATError(RuntimeError):
    pass


class ATModem:
    def __init__(self, device, baud=115200):
        self.device = device
        self.baud = baud
        self.fd = None
        self.original = None

    def __enter__(self):
        self.fd = os.open(self.device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.original = termios.tcgetattr(self.fd)
            tty.setraw(self.fd)
            params = termios.tcgetattr(self.fd)
            speed = getattr(termios, "B" + str(self.baud), None)
            if speed is None:
                raise ValueError("Unsupported baud rate")
            params[4] = speed
            params[5] = speed
            termios.tcsetattr(self.fd, termios.TCSANOW, params)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.fd is not None:
            try:
                if self.original is not None:
                    termios.tcsetattr(self.fd, termios.TCSANOW, self.original)
            finally:
                os.close(self.fd)
                self.fd = None
                self.original = None

    def _until(self, expected, timeout=8):
        deadline = time.monotonic() + timeout
        received = bytearray()
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.fd], [], [], max(0, min(0.2, deadline - time.monotonic())))
            if not ready:
                continue
            try:
                data = os.read(self.fd, 4096)
            except BlockingIOError:
                continue
            if not data:
                continue
            received.extend(data)
            if len(received) > 16384:
                raise ATError("Cellular modem response too large")
            if b"\r\nERROR\r\n" in received or b"+CMS ERROR:" in received or b"+CME ERROR:" in received:
                raise ATError("Cellular modem rejected command: " + received.decode("ascii", "replace")[-300:])
            if expected in received:
                return bytes(received)
        raise ATError("Cellular modem did not respond before timeout")

    def _write(self, data):
        remaining = memoryview(data)
        while remaining:
            _, writable, _ = select.select([], [self.fd], [], 5)
            if not writable:
                raise ATError("Cellular modem serial write timed out")
            try:
                count = os.write(self.fd, remaining)
            except BlockingIOError:
                continue
            remaining = remaining[count:]

    def command(self, command, timeout=8):
        if not command.isascii() or any(x in command for x in ("\n", "\r", "\x1a")):
            raise ValueError("Invalid AT command")
        self._write(command.encode() + b"\r")
        return self._until(b"\r\nOK\r\n", timeout=timeout)

    def check(self):
        return bool(self.command("AT"))

    def send_sms(self, number, text):
        if not NUMBER_RE.fullmatch(number):
            raise ValueError("A real E.164 destination number, e.g. +12045551234, is required")
        if not isinstance(text, str) or not (1 <= len(text) <= 160) or not text.isascii():
            raise ValueError("Use 1–160 ASCII characters; modem encoding varies for Unicode")
        if any(ch in text for ch in ("\x1a", "\x1b", "\x00", "\r")):
            raise ValueError("Unsupported control character in SMS text")
        self.command("AT+CMGF=1")
        self._write(('AT+CMGS="' + number + '"\r').encode())
        self._until(b">", timeout=10)
        self._write(text.encode("ascii") + b"\x1a")
        response = self._until(b"\r\nOK\r\n", timeout=35)
        if b"+CMGS:" not in response:
            raise ATError("Modem did not confirm message reference")
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="List serial modem device candidates")
    parser.add_argument("--device", help="Linux AT modem command port, e.g. /dev/ttyUSB2")
    parser.add_argument("--send-to", help="Real SMS number in E.164 format")
    parser.add_argument("--text", help="One SMS text, up to 160 ASCII characters")
    parser.add_argument("--confirm-charge", action="store_true",
                        help="Explicitly approve sending one chargeable carrier SMS")
    args = parser.parse_args()
    candidates = list_serial_modems()
    if args.list or not (args.device or args.send_to):
        if candidates:
            print("Candidate USB cellular serial ports:")
            print("\n".join("  " + x for x in candidates))
            print("Only ports exposed to Linux are visible; a storage USB alone cannot send SMS.")
        else:
            print("No ttyUSB/ttyACM modem port exposed to Linux.")
        return
    if not args.send_to or not args.text or not args.confirm_charge:
        parser.error("Real SMS requires --send-to, --text and --confirm-charge")
    if args.device not in candidates:
        parser.error("Specified modem device is not an accessible USB serial port")
    with ATModem(args.device) as modem:
        modem.check()
        modem.send_sms(args.send_to, args.text)
    print("Modem accepted one SMS submission. Delivery to recipient is not guaranteed.")


if __name__ == "__main__":
    main()
