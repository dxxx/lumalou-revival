"""Control a Fisher-Price Lumalou from a PC over Bluetooth LE (no app, no cloud).

    pip install -r requirements.txt
    python lumalou_cli.py scan                                  # find your lamp's address
    python lumalou_cli.py AA:BB:CC:DD:EE:FF status             # read light, volume, clock, schedule
    python lumalou_cli.py AA:BB:CC:DD:EE:FF colour 5           # 0 warm … 5 blue … 9 rainbow, 10 off
    python lumalou_cli.py AA:BB:CC:DD:EE:FF brightness 7       # 0..9
    python lumalou_cli.py AA:BB:CC:DD:EE:FF volume 4           # 0..9
    python lumalou_cli.py AA:BB:CC:DD:EE:FF sound 3            # 0 sleep playlist … 7 highway; "sound off"
    python lumalou_cli.py AA:BB:CC:DD:EE:FF sync-clock         # set the lamp's clock to this PC's time
    python lumalou_cli.py AA:BB:CC:DD:EE:FF raw 3c 05          # any command: opcode + args (docs/COMMANDS.md)
Add -v to see every encrypted packet and its decrypted content.
"""
import argparse
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner

import lumalou
import mpid

COLOURS = ["warm spectrum", "red", "yellow", "orange", "green", "blue", "purple", "night light", "cool spectrum",
           "rainbow", "off"]


async def scan():
    print("Scanning 10 s for Mattel MPID devices…")
    found = await BleakScanner.discover(timeout=10, return_adv=True)
    hits = 0
    for addr, (dev, adv) in found.items():
        uuids = [u.lower() for u in adv.service_uuids]
        if mpid.SERVICE in uuids or 0x03B6 in adv.manufacturer_data:
            hits += 1
            print(f"  {addr}  name={adv.local_name or dev.name!r}  rssi={adv.rssi}")
    if not hits:
        print("  none found (is the lamp powered, and no phone app connected to it?)")


class Lamp:
    def __init__(self, client, verbose=False):
        self.c, self.v = client, verbose
        self.s = None
        self.buf = bytearray()
        self.replies = {}

    async def open(self):
        token = mpid.Token(bytes(await self.c.read_gatt_char(mpid.FACTORY)))
        if self.v:
            print("token:", token)
        self.s = mpid.Session(token)
        await self.c.start_notify(mpid.RX, self._on_rx)
        await self.c.write_gatt_char(mpid.SESSION, self.s.hello(), response=True)
        await asyncio.sleep(1.0)
        await self.send(lumalou.ENABLE_READ_TRANSMISSION)

    def _on_rx(self, _, data):
        self.buf += data
        while len(self.buf) >= 8 and self.buf[0] == 0x7E:
            n = int.from_bytes(self.buf[5:7], "big")
            if len(self.buf) < 8 + n:
                break
            pkt, self.buf = bytes(self.buf[:8 + n]), self.buf[8 + n:]
            try:
                _, payload = self.s.open_packet(pkt)
            except ValueError as e:
                print("  bad packet:", e)
                continue
            if self.v:
                print("  <-", payload.hex())
            if payload[:3] == b"\x01\x50\xfe" and len(payload) > 4:
                n = payload[3]
                self.replies[payload[4]] = payload[5:4 + n]
        if self.buf and self.buf[0] != 0x7E:
            self.buf = bytearray()

    async def send(self, spi_payload: bytes, wait=0.4):
        pkt = self.s.make_packet(spi_payload)
        if self.v:
            print("  ->", spi_payload.hex())
        for i in range(0, len(pkt), 20):
            await self.c.write_gatt_char(mpid.TX, pkt[i:i + 20], response=False)
        await asyncio.sleep(wait)

    async def cmd(self, *op_and_args: int):
        await self.send(bytes([0x01, 0x10]) + lumalou.fp_frame(bytes(op_and_args)))


def bcd(v):
    return int(f"{v:02d}", 16)


def from_bcd(b):
    return (b >> 4) * 10 + (b & 0x0F)


async def run(a):
    async with BleakClient(a.address, timeout=20) as client:
        lamp = Lamp(client, a.verbose)
        await lamp.open()
        act, args = a.action, a.args
        if act == "status":
            for op in (0x53, 0x31, 0x35, 0x47, 0x49, 0x4C, 0x7A):
                await lamp.cmd(op)
            await asyncio.sleep(1.5)
            r = lamp.replies
            g = r.get(0x02)
            if g and len(g) >= 13:
                hi, lo = (lambda b: b >> 4), (lambda b: b & 15)
                print(f"light: {'on' if lo(g[3]) else 'off'}, colour {COLOURS[lo(g[4])] if lo(g[4]) < 11 else lo(g[4])}, "
                      f"brightness {hi(g[4])}; volume {lo(g[2])}; music {'playing' if hi(g[1]) else 'off'}; "
                      f"mode {hi(g[0])}; clock display {'on' if hi(g[8]) else 'off'} ({'24' if hi(g[9]) else '12'} h)")
            if 0x13 in r:
                d = r[0x13]
                print(f"lamp clock: {from_bcd(d[0]):02d}:{from_bcd(d[1]):02d}:{from_bcd(d[2]):02d}, weekday {from_bcd(d[3])} (0 = Sun)")
            if 0x12 in r:
                print(f"toy-IC firmware: {r[0x12][0]}.{r[0x12][1]:02d}")
            for code, label in ((0x23, "bedtimes"), (0x22, "wake times")):
                if code in r and len(r[code]) >= 14:
                    t = r[code]
                    days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
                    s = [f"{days[i]} {from_bcd(t[2*i]):02d}:{from_bcd(t[2*i+1]):02d}" for i in range(7) if t[2 * i] <= 0x23]
                    print(f"{label}: {', '.join(s) or 'none'}")
        elif act == "colour":
            await lamp.cmd(0x3C, int(args[0]))
        elif act == "brightness":
            await lamp.cmd(0x3A, int(args[0]))
        elif act == "volume":
            await lamp.cmd(0x37, int(args[0]))
        elif act == "sound":
            await (lamp.cmd(0x38) if args[0] == "off" else lamp.cmd(0x3F, int(args[0])))
        elif act == "sync-clock":
            now = datetime.datetime.now()
            await lamp.cmd(0x30, bcd(now.hour), bcd(now.minute), bcd(now.second), bcd(now.isoweekday() % 7))
            print("lamp clock set to", now.strftime("%H:%M:%S %A"))
        elif act == "raw":
            await lamp.cmd(*[int(x, 16) for x in args])
            await asyncio.sleep(1.0)
            for code, data in lamp.replies.items():
                print(f"reply 0x{code:02X}: {data.hex()}")
        else:
            sys.exit(f"unknown action {act}")
        await asyncio.sleep(0.5)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "scan":
        asyncio.run(scan())
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("address", help="the lamp's Bluetooth address (see: lumalou_cli.py scan)")
    ap.add_argument("action", choices=["status", "colour", "brightness", "volume", "sound", "sync-clock", "raw"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("-v", "--verbose", action="store_true")
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
