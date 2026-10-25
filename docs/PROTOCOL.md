# The Lumalou Bluetooth protocol ("MPID")

How a Fisher-Price **Lumalou** (Mattel GWM53) talks over Bluetooth LE, layer by layer. Everything here was verified against a
real lamp (firmware 1.99). The reference implementation is [`python/mpid.py`](../python/mpid.py) (transport + crypto) and
[`python/lumalou.py`](../python/lumalou.py) (commands); the ESP32 version is [`esphome/components/lumalou`](../esphome/components/lumalou).
The full command list is in [COMMANDS.md](COMMANDS.md).

```
 ┌──────────────────────────── application: Lumalou command  [opcode] [args…]            (COMMANDS.md)
 │ ┌────────────────────────── "FP" frame:   FE | len | payload | xor
 │ │ ┌──────────────────────── SPI message:  01 10 | FP frame        (to the lamp's sound/light chip)
 │ │ │ ┌────────────────────── MPID packet:  7E | seq | len | crc8 | AES-128-CTR( message | crc8 )
 │ │ │ │ ┌──────────────────── GATT:         write "tx" characteristic / notify on "rx"
 ▼ ▼ ▼ ▼ ▼
```

## 1. Discovery and GATT

| | |
|---|---|
| Advertised name | a 10-digit number (the product's "AP number"; the same on every Lumalou) |
| Manufacturer data id | `0x03B6` |
| Address | the BLE module is a TI CC2640R2, so addresses start with a TI prefix (e.g. `F0:F8:F2:…`) |
| One connection at a time | while the phone app (or the bridge) is connected, nobody else can connect |

Service `4cea0001-c678-4202-b5d3-712dbb5e5b14`:

| Characteristic | Name in the app | Properties | Use |
|---|---|---|---|
| `4cea0002-…` | tx | write, write without response | encrypted packets to the lamp |
| `4cea0003-…` | rx | notify | encrypted packets from the lamp |
| `4cea0004-…` | factory | read | the **factory token** (below) |
| `4cea0005-…` | session | write | session start ("hello") |

There is also a firmware-update service (`00001530-1212-efde-1523-785feabcd123`). **Never write to it**: you can brick the lamp.

No Bluetooth pairing/bonding and no press of the lamp's pairing button is needed for any of this.

## 2. The factory token (characteristic "factory")

192 bytes on our lamp (format version 10; anything ≥ 182 bytes with version 10 follows this layout):

| Offset | Size | Content |
|---|---|---|
| 0 | 1 | format version (`0x0A`) |
| 1 | 24 | ASCII id: 3 + 1 + 2 chars, then the **AP number** (10 digits, the same as the advertised name), 2 chars, the **item number** (6) |
| 25 | 33 | **the lamp's public key**: compressed point on NIST P-256 (secp256r1), first byte `02`/`03` |
| 58 | 5 | (unused here) |
| 63 | 2 | machine number |
| 65 | 3 | key id (which manufacturer key signed this token; the app uses it to check the signature) |
| 68 | 2 | config table id |
| 70 | n − 138 | config table |
| n − 68 | 64 | manufacturer signature over the token |
| n − 4 | 4 | **device salt**: changes on every connection |

The signature only lets the app check that the lamp is genuine. A controller does not need to verify it.

## 3. Opening a session

1. Subscribe to notifications on **rx**.
2. Read **factory** and parse the lamp's public key and the 4-byte device salt (last 4 bytes).
3. Make your own random P-256 key pair and a random 4-byte **app salt**.
4. **ECDH** (your private key × the lamp's public key) gives a 32-byte shared secret (the x coordinate).
5. **Key schedule:** repeat 100 times, for round = 0 … 99:
   `secret = AES-128-CTR(key = secret[0:16], counter = 00 00 00 00 | round (big-endian 32) | 00 'm' 'a' 't' 't' 'e' 'l' 00)` applied to the 32-byte secret.
   The session key is `secret[0:16]` after the last round.
6. Write the **hello** to **session**: your compressed public key (33 bytes) + your app salt (4 bytes) = 37 bytes.
7. Send the transport message `01 50 01` (inside a packet, below). It switches on replies ("enable read transmission").

From then on, every command gets an answer. The lamp also pushes its state by itself when something changes.

## 4. Packets (on tx and rx)

```
header (8 bytes):  7E | seq (4, big-endian) | len (2, big-endian) | crc8(header bytes 0..6)
body (len bytes):  message | crc8(message)          ← encrypted with AES-128-CTR, session key
len = message length + 1  (0 = no body)
```

* `seq` starts at 1 and goes up by one for each packet you send (the lamp keeps its own counter).
* Counter block for the body: `seq (4) | sender salt (4) | receiver salt (4) | 00 00 00 00`.
  For packets you send, that is `seq | app salt | device salt | 0`; for the lamp's packets `seq | device salt | app salt | 0`.
* **CRC-8**: polynomial `0x07`, start value `0xFF`, no final XOR, not reflected.
* Long packets: split into ≤ 20-byte writes (write without response). Replies may span several notifications; reassemble by the header.
* Max message length: 511 bytes.

## 5. Messages inside a packet

| Message | Meaning |
|---|---|
| `01 50 01` | enable replies (send once after the hello) |
| `01 10` + FP frame | a Lumalou command (to the lamp's sound/light chip) |
| `00 7F 01 …` (from the lamp) | transport acknowledgement |
| `01 10 04 00` (from the lamp) | command delivered |
| `01 50` + FP frame (from the lamp) | a reply or a state update |

**FP frame:** `FE | n | payload (n bytes) | x`, where `x` = `n` XOR every payload byte.
The payload of a command is `[opcode] [args…]`; the payload of a reply is `[reply code] [data…]`.

Example, "set light colour to blue": opcode `3C`, argument `05` → FP frame `FE 02 3C 05 3B` → message `01 10 FE 02 3C 05 3B`.

## 6. Commands

All opcodes, arguments, reply codes and the 13-byte state block: **[COMMANDS.md](COMMANDS.md)**. The most useful:

| Want | Send (payload) | Lamp answers |
|---|---|---|
| everything at once | `53` | `02` + 13-byte state |
| light colour | `3C cc` (0 warm spectrum … 9 rainbow, 10 off) | `18 cc` |
| brightness | `3A bb` (0–9) | `17 bb` |
| volume | `37 vv` (0–9) | `15 vv` |
| play a sound | `3F ss` (0 sleep playlist, 1 custom playlist, 2 pink noise, 3 ocean, 4 rain, 5 brown noise, 6 nature, 7 highway) | state update |
| stop sound | `38` | state update |
| set the lamp's clock | `30 HH MM SS WD` (BCD; WD 0 = Sunday) | — (read with `31` → `13 HH MM SS WD`) |
| bedtimes / wake times | `48` / `46` + 7 × `HH MM` BCD (Sun … Sat, `FF FF` = none) | read with `49` / `47` |
| day routine | `5A + 2 × day` + `HH MM` + 12 task slots | read with the next opcode |

## 7. What the official app did on connect

`34` (pairing complete) → `53` → `31` → `35` → `41` → `47` → `49` → `4C` → `51` → `68` → the 7 day routines → `76`;
then it set the lamp's clock (`30`) from the phone and re-sent its saved clock, routine and sleep-trainer settings.
Our bridge does the same (minus `51`/`76`, which it does not need) and keeps the clock synced from internet time.
