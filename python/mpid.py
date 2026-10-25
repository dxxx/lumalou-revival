"""MPID: the encrypted Bluetooth LE protocol of Mattel / Fisher-Price "Smart Connect" toys (e.g. the Lumalou).
Re-implemented from scratch for interoperability (see docs/PROTOCOL.md). Needs: pip install bleak cryptography

Session (all offline):
  1. read the device's factory token (characteristic "factory"): it carries the device's P-256 public key + a 4-byte salt
  2. make our own P-256 key pair, ECDH -> 32-byte shared secret
  3. "mattel" key schedule: 100 rounds of AES-128-CTR over the secret (iv = 00*4 | round BE32 | 00 'mattel' 00)
  4. send our compressed public key (33 B) + our 4-byte salt to the device
Packets: 7E | seq BE32 | len BE16 (= payload+1) | crc8(prev 7) , then payload | crc8(payload), AES-128-CTR encrypted,
  counter block = seq BE32 | sender salt | receiver salt | 00 00 00 00.
"""
import os

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

SERVICE = "4cea0001-c678-4202-b5d3-712dbb5e5b14"
TX = "4cea0002-c678-4202-b5d3-712dbb5e5b14"        # app -> device
RX = "4cea0003-c678-4202-b5d3-712dbb5e5b14"        # device -> app (notify)
FACTORY = "4cea0004-c678-4202-b5d3-712dbb5e5b14"   # factory token (read)
SESSION = "4cea0005-c678-4202-b5d3-712dbb5e5b14"   # session start (write)

# CRC-8, polynomial 0x07, start 0xFF (standard CRC-8 table)
_CRC = []
for i in range(256):
    c = i
    for _ in range(8):
        c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    _CRC.append(c)


def crc8(data, crc=0xFF):
    for b in data:
        crc = _CRC[crc ^ b]
    return crc


def aes_ctr(key16, iv16, data):
    e = Cipher(algorithms.AES(key16), modes.CTR(iv16)).encryptor()
    return e.update(data) + e.finalize()


class Token:
    """Factory token (version 10 layout, fb/f.java in the app)."""

    def __init__(self, raw: bytes):
        self.raw = raw
        self.version = raw[0]
        self.ident = raw[1:25].decode("ascii", "replace")
        self.ap_number = self.ident[6:16]
        self.item_number = self.ident[18:24]
        self.public_key = raw[25:58]                 # 33 B compressed P-256
        self.machine = int.from_bytes(raw[63:65], "big")
        self.key_id = int.from_bytes(raw[65:68], "big")
        self.signature = raw[-68:-4]
        self.salt = raw[-4:]

    def __repr__(self):
        return (f"Token(v{self.version}, AP#{self.ap_number}, item {self.item_number}, machine {self.machine}, "
                f"key-id {self.key_id}, salt {self.salt.hex()})")


class Session:
    def __init__(self, token: Token, private_key=None, salt: bytes = None):
        self.token = token
        self.priv = private_key or ec.generate_private_key(ec.SECP256R1())
        self.salt = salt or os.urandom(4)
        peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), token.public_key)
        secret = bytearray(self.priv.exchange(ec.ECDH(), peer))       # 32 B, x coordinate
        iv = bytearray(16)
        iv[9:15] = b"mattel"
        for _ in range(100):
            secret = bytearray(aes_ctr(bytes(secret[:16]), bytes(iv), bytes(secret)))
            for i in range(7, 3, -1):                                 # iv[4:8] += 1 (big-endian)
                iv[i] = (iv[i] + 1) & 0xFF
                if iv[i]:
                    break
        self.key = bytes(secret[:16])
        self.seq = 0

    def hello(self) -> bytes:
        """37 bytes for the session characteristic: our compressed public key + our salt."""
        pub = self.priv.public_key().public_bytes(serialization.Encoding.X962,
                                                  serialization.PublicFormat.CompressedPoint)
        return pub + self.salt

    def make_packet(self, payload: bytes) -> bytes:
        self.seq += 1
        n = len(payload) + 1 if payload else 0
        head = bytes([0x7E]) + self.seq.to_bytes(4, "big") + n.to_bytes(2, "big")
        head += bytes([crc8(head)])
        if not payload:
            return head
        body = payload + bytes([crc8(payload)])
        iv = self.seq.to_bytes(4, "big") + self.salt + self.token.salt + bytes(4)
        return head + aes_ctr(self.key, iv, body)

    def open_packet(self, pkt: bytes):
        """-> (seq, payload) or raises ValueError."""
        if len(pkt) < 8 or pkt[0] != 0x7E or crc8(pkt[:7]) != pkt[7]:
            raise ValueError("bad header")
        seq = int.from_bytes(pkt[1:5], "big")
        n = int.from_bytes(pkt[5:7], "big")
        if n == 0:
            return seq, b""
        body = pkt[8:8 + n]
        iv = pkt[1:5] + self.token.salt + self.salt + bytes(4)
        plain = aes_ctr(self.key, iv, body)
        if crc8(plain[:-1]) != plain[-1]:
            raise ValueError("bad body crc (wrong key?)")
        return seq, plain[:-1]
