#!/usr/bin/env python3
"""projector.py — RS-232 (and PJLink-over-LAN) control of the projector hanging off THIS Pi. Stdlib only.

Used by fractal-media-sync (every renderer's :8082 status service: GET/POST /projector) and by master.py for the
master's own projector. Config: /var/lib/fractal-rig/projector.json
    {"protocol": "viewsonic", "port": "auto", "baud": 19200, "host": "", "input": "hdmi1"}
  protocol  viewsonic — ViewSonic hex protocol (V52HD, PX7xx, PA5xx, LS… — 19200 8N1). Ack 03 14 00 00 00 14.
            pjlink    — PJLink class 1 over TCP 4352 (most Epson/NEC/Panasonic/Optoma; ViewSonic LAN models too),
                        no password. host = projector IP.
  port      "auto" = first USB→RS-232 lead (/dev/serial/by-id/*, ttyUSB*), else the 40-pin header UART (/dev/serial0 —
            GPIO14 TXD pin 8, GPIO15 RXD pin 10, GND pin 6, through a MAX3232 level shifter; install.sh --gpio-serial enables it).
CLI:  python3 projector.py on|off|status|hdmi1|hdmi2|blank|unblank
"""
import glob
import json
import os
import select
import socket
import sys
import termios
import time

CFG_FILE = os.environ.get("FRACTAL_PROJECTOR", "/var/lib/fractal-rig/projector.json")
DEFAULT = dict(protocol="viewsonic", port="auto", baud=19200, host="", input="hdmi1")

# ViewSonic: 06 14 00 04 00 34 <fn> <par> <val> <checksum = low byte of sum of bytes 1..>  (write)  /  07 14 00 05 00 34 00 00 <fn> <par> <ck> (read)
VS_WRITE = {
    "on":      bytes.fromhex("06 14 00 04 00 34 11 00 00 5D"),
    "off":     bytes.fromhex("06 14 00 04 00 34 11 01 00 5E"),
    "hdmi1":   bytes.fromhex("06 14 00 04 00 34 13 01 03 63"),
    "hdmi2":   bytes.fromhex("06 14 00 04 00 34 13 01 07 67"),
    "blank":   bytes.fromhex("06 14 00 04 00 34 11 09 01 67"),   # blank / freeze family — check on the unit
    "unblank": bytes.fromhex("06 14 00 04 00 34 11 09 00 66"),
}
VS_STATUS = bytes.fromhex("07 14 00 05 00 34 00 00 11 00 5E")
VS_SOURCE = bytes.fromhex("07 14 00 05 00 34 00 00 13 01 61")   # read current source — reply value 03 = HDMI 1, 07 = HDMI 2 (same codes as the set commands)
VS_SRC_NAMES = {0x00: "VGA", 0x03: "HDMI 1", 0x07: "HDMI 2", 0x08: "HDMI 3", 0x05: "Composite", 0x06: "S-Video", 0x0f: "USB-C"}
VS_ACK = bytes.fromhex("03 14 00 00 00 14")
PJ = {"on": "%1POWR 1\r", "off": "%1POWR 0\r", "status": "%1POWR ?\r", "hdmi1": "%1INPT 31\r", "hdmi2": "%1INPT 32\r", "blank": "%1AVMT 31\r", "unblank": "%1AVMT 30\r"}
CMDS = ("on", "off", "status", "hdmi1", "hdmi2", "blank", "unblank", "raw")


def load_cfg():
    cfg = dict(DEFAULT)
    try:
        cfg.update(json.load(open(CFG_FILE)))
    except Exception:
        pass
    return cfg


def save_cfg(cfg):
    os.makedirs(os.path.dirname(CFG_FILE), exist_ok=True)
    json.dump(cfg, open(CFG_FILE, "w"), indent=1)


def find_port(cfg):
    p = cfg.get("port") or "auto"
    if p != "auto":
        return p if os.path.exists(p) else None
    for pat in ("/dev/serial/by-id/*", "/dev/ttyUSB*", "/dev/ttyACM*", "/dev/serial0", "/dev/ttyAMA0"):   # USB lead first, then the GPIO header UART
        m = sorted(glob.glob(pat))
        if m:
            return m[0]
    return None


def _serial_xfer(port, baud, payload, wait=1.0):
    """Open 8N1 raw, write payload, collect whatever comes back within `wait` s."""
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        attr = termios.tcgetattr(fd)
        speed = {4800: termios.B4800, 9600: termios.B9600, 19200: termios.B19200, 38400: termios.B38400, 115200: termios.B115200}.get(int(baud), termios.B19200)
        attr[0] = 0; attr[1] = 0; attr[3] = 0                                  # iflag, oflag, lflag: raw
        attr[2] = (attr[2] & ~(termios.CSIZE | termios.PARENB | termios.CSTOPB)) | termios.CS8 | termios.CLOCAL | termios.CREAD
        attr[4] = speed; attr[5] = speed
        attr[6][termios.VMIN] = 0; attr[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attr)
        termios.tcflush(fd, termios.TCIOFLUSH)
        os.write(fd, payload)
        out = b""; end = time.time() + wait
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    chunk = os.read(fd, 64)
                except BlockingIOError:
                    chunk = b""
                if chunk:
                    out += chunk
                    if len(out) >= 6 and time.time() + 0.15 < end:
                        end = time.time() + 0.15                                # short tail after the first bytes
        return out
    finally:
        os.close(fd)


def _pjlink(host, msg, wait=2.0):
    with socket.create_connection((host, 4352), timeout=wait) as s:
        s.settimeout(wait)
        s.recv(64)                                                             # "PJLINK 0"
        s.sendall(msg.encode())
        return s.recv(64).decode(errors="ignore").strip()


def command(cmd, cfg=None, extra=None):
    """Run one command. Returns dict(ok, power=on|off|unknown, source?, msg, port/host, raw)."""
    cfg = cfg or load_cfg(); extra = extra or {}
    if cmd not in CMDS:
        return dict(ok=False, msg=f"unknown command {cmd}")
    proto = cfg.get("protocol", "viewsonic")
    try:
        if proto == "pjlink":
            host = cfg.get("host")
            if not host:
                return dict(ok=False, msg="pjlink: no host set", power="unknown")
            r = _pjlink(host, PJ[cmd])
            power = "unknown"
            if cmd == "status":
                power = "on" if r.endswith("=1") else "off" if r.endswith("=0") else "warming" if r.endswith("=3") else "cooling" if r.endswith("=2") else "unknown"
            return dict(ok="ERR" not in r, msg=r, power=power, host=host, raw=r)
        port = find_port(cfg)
        if not port:
            return dict(ok=False, msg="no USB→RS-232 adapter found (/dev/ttyUSB0)", power="unknown", port=None)
        if cmd == "raw":                                                          # {"cmd":"raw","hex":"06 14 …"} — try codes from the projector's own RS-232 sheet
            payload = bytes.fromhex(str(extra.get("hex", "")).replace(" ", ""))
            raw = _serial_xfer(port, cfg.get("baud", 19200), payload)
            return dict(ok=bool(raw), msg="reply " + (raw.hex(" ") or "(none)"), power="unknown", port=port, raw=raw.hex(" "))
        payload = VS_STATUS if cmd == "status" else VS_WRITE[cmd]
        raw = _serial_xfer(port, cfg.get("baud", 19200), payload)
        hx = raw.hex(" ")
        if cmd == "status":
            # read reply: 05 14 00 03 00 00 00 <value> <ck> — value 00 off / 01 on; the second read asks for the source
            val = raw[7] if len(raw) >= 9 and raw[0] == 0x05 else None
            power = "on" if val == 1 else "off" if val == 0 else "unknown"
            source = None
            if power == "on":
                try:
                    sr = _serial_xfer(port, cfg.get("baud", 19200), VS_SOURCE, 0.6)
                    if len(sr) >= 9 and sr[0] == 0x05: source = VS_SRC_NAMES.get(sr[7], f"src {sr[7]:02x}")
                except Exception:
                    pass
            return dict(ok=bool(raw), msg=(("power " + power) + (f" · {source}" if source else "")) if raw else "no reply — cable, baud (19200) or RS-232 disabled in the projector menu?", power=power, source=source, port=port, raw=hx)
        ok = raw.startswith(VS_ACK) or raw == VS_ACK
        return dict(ok=ok or bool(raw), msg=("ack" if ok else ("reply " + hx) if raw else "no reply — sent anyway"), power="unknown", port=port, raw=hx)
    except Exception as ex:
        return dict(ok=False, msg=str(ex), power="unknown")


if __name__ == "__main__":
    c = sys.argv[1] if len(sys.argv) > 1 else "status"
    r = command(c)
    print(json.dumps(r))
    sys.exit(0 if r.get("ok") else 1)
