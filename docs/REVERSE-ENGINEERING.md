# How we reverse-engineered it (and how you can do the same for another device)

This is the method, step by step, with the tools, the commands and the traps we hit. It took one evening (about 6 hours)
from "the app is gone" to "the lamp runs on its own ESP32 with a web page". The same path works for most Bluetooth LE
gadgets whose app was discontinued, as long as you can still get an old copy of the app.

**Ground rules we kept:** read-only first (never write to a characteristic you don't understand, never touch a firmware-update
service), work on your own device and your own copy of the app, and publish your *own* code and *descriptions*, not the
vendor's binaries, keys or code.

## Tools

| Tool | Used for | Where |
|---|---|---|
| Python **bleak** | scan, read GATT, listen to notifications, talk to the device | any PC with Bluetooth |
| Python **cryptography** | ECDH + AES to re-implement the crypto | any PC |
| **jadx** | decompile the app's Java/Kotlin (dex) code | Kali (preinstalled), or download |
| **Ghidra** (headless) | decompile native `.so` libraries | Kali (preinstalled), or download |
| a Flutter/Dart decompiler | decompile a **Flutter** app's Dart code | build it yourself (Linux works best) |
| **radare2** | pull a table out of a binary | Kali (preinstalled) |
| **ESPHome** | the final firmware on an ESP32 | any PC |

## Step 1: identify the hardware

* Read the label. An **FCC ID** leads to the radio module and its chip (ours: HY-40R201PC → TI CC2640R2, a Bluetooth LE chip).
* That tells you the radio (BLE vs WiFi vs something else) before you spend any time on the wrong protocol.

## Step 2: find it and map its Bluetooth services (read-only)

```python
from bleak import BleakScanner, BleakClient
devs = await BleakScanner.discover(timeout=20, return_adv=True)          # strongest signal = the one next to you
async with BleakClient(addr) as c:
    for s in c.services:
        for ch in s.characteristics:
            print(s.uuid, ch.uuid, ch.properties)                       # read only the 'read' ones
```

What told us most: a vendor service with **write + notify + read + write** characteristics, a long **read-only blob** that
looked partly random (→ a certificate / public key), and **silence** on the notify characteristic (→ there is a session to open first).

## Step 3: get the app and look inside (without running it)

* Old versions are on APKMirror. Get one from **before** the version that dropped your device (read the changelogs).
* An `.apk` / `.apkm` is a ZIP. Unzip it and look at the file list first:
  * `lib/<arch>/` containing the Flutter engine and an app library → a **Flutter** app (the logic is Dart, compiled ahead of time).
  * `assets/…`: look for JSON. Our app had a **product spec per model** (`gld09.json` = Lumalou) naming every characteristic,
    and its `apn` field matched the lamp's Bluetooth name. That's how we knew exactly which product we had.
  * `classes*.dex` → Java/Kotlin; `lib/*.so` → native code.
* `strings`-style search of the binaries (Python `re.findall(rb'[ -~]{5,}', data)`) for words like
  `session`, `encrypt`, `key`, `aes`, `ecdh`, `crc`, the product name, command names. It gave us the architecture in minutes:
  Flutter → a "bridge" → native crypto library.

## Step 4: follow the data, not the UI

1. **jadx** the APK (`jadx --no-res -d out app.apk`; give absolute paths). Find the bridge class by a string you saw
   (a start-session call). Read what each bridge call does with its arguments.
   * We found the session needs the device's token plus a key picked by a **key id inside the token**: everything is local.
   * We also found a crypto library **disguised as an audio codec** (with scrambled method names), used for
     *older* products, a reminder to check which path *your* device actually takes.
2. **Ghidra headless** for the native library (it still had symbol names: lucky):
   ```
   analyzeHeadless <projdir> proj -import <native-lib>.so -postScript DumpFuncs.java "(?i).*(mpid|aes|ecc|crc|sha|Java_).*" out.c
   ```
   (`DumpFuncs.java` = a 20-line script that decompiles matching functions to a file.) Recognise open-source building blocks
   by their function names: here **micro-ecc**, **tiny-AES**, SHA-256, a CRC-8 table. Then you only need to understand the glue:
   the key derivation and the packet format.
3. Pull constant tables out with radare2 or a few lines of Python (we read the 256-byte CRC table straight from the file offset).

## Step 5: re-implement, then test step by step

* Write the transport in Python first (`mpid.py`): token parser → ECDH → key schedule → packet build/parse.
* Open a session with the real device. **Expect silence**: our lamp accepted the session and said nothing until it got a real
  command. We wasted time on pairing mode and OS-level bonding before reading the app-level code (none of that was needed).

## Step 6: the commands (Flutter apps)

* A Flutter/Dart decompiler rebuilds the Dart VM version the app used and dumps readable assembly with the
  **function names, string constants and enum objects**. Building one needs cmake, ninja, pkg-config, capstone and ICU
  (`apt install libicu-dev libcapstone-dev`; the rest can come from a Python venv with pip).
* Reading it:
  * Small integers are **tagged** in Dart AOT: a constant `r17 = 32` in the listing is the value **16**.
  * The decompiler's constant-object dump gives you an enum's index → name table.
  * A map initializer listing command/number pairs gave us all 68 opcodes in one go.
  * Follow a setter (`setLedColor`) → the command writer → the encoders to get the framing.
* Then send **read-only requests first**, check every checksum, and only then change something you can see (we changed the
  colour and watched the lamp turn orange).
* For the long tail (dozens of setters and reply parsers) we let a separate AI agent read the decompiled output function by function
  and write a spec, marking each item *certain* (read from code) or *inferred*. We then verified the important ones with round-trip
  writes on the real lamp (write a routine → read it back → clear it).

## Step 7: give it a permanent home

An ESP32 running **ESPHome** with a small external component holds the Bluetooth connection and exposes a web page and
Home-Assistant entities. Notes:
* mbedtls (inside ESP-IDF) can't import compressed EC points. Decompress by hand: `y = (x³ − 3x + b)^((p+1)/4) mod p`, pick the root
  with the right parity.
* Queue outgoing packets (≈150 ms apart) and split them into 20-byte writes.
* On an ESP32-S3 DevKit, `esphome logs` over the UART port can leave the chip in download mode (it toggles DTR/RTS); use a serial
  monitor that keeps both lines low.
* Custom components that open sockets must declare them (`socket.consume_sockets`) or OTA updates start failing.

## Traps, in order of time wasted

1. Assuming pairing/bonding was needed (it wasn't). Read the app-level code before blind experiments.
2. Following the first crypto library we found (it belonged to older products).
3. The device staying silent after a correct handshake (it only answers real commands).
4. Network, not protocol: a WiFi extender gave the ESP32 a new IP and broke `.local` name lookups.
