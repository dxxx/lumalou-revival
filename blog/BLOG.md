# The app died, the lamp didn't: reviving a Fisher-Price Lumalou in one evening

*How we reverse-engineered an encrypted Bluetooth toy, rebuilt every feature of its discontinued app on a €5 ESP32, and what
you can learn from it to rescue your own "smart" gadgets.*

![The new control page, made for the lamp](images/page-v2-lamp.jpg)

---

## The problem

The **Fisher-Price Lumalou** is a cloud-shaped night light with a star on top. It plays lullabies and white noise, shows a
clock, and has a **sleep trainer** ("stay in bed until the cloud turns green") and **morning routines** (get dressed, brush
teeth, eat…). It's a genuinely nice device for a small child.

It's also a "smart" device, which means most of that is only reachable through an app: **Fisher-Price Smart Connect**. It
launched in late 2020 at around $100. The manual already warned: *"We reserve the right to terminate digital applications
after April 30, 2022."* In February 2024, version 10.0 of the app shipped with one line in its changelog:

> *Removed app control capabilities for older generation products.*

Then the app itself went away: gone from Google Play in March 2025, with the backend reportedly switched off in August 2025.
We found no official announcement. The lamp still works as a plain night light, but the sleep trainer, routines and alarms were
locked behind an app you can't install any more. One more perfectly good device turns into e-waste because a server or an app
store listing went away.

We wanted it back. All of it. Without the app, without the cloud, ideally on a cheap board that just sits next to the lamp.

**Spoiler:** it took one evening. By midnight, the lamp ran from its own ESP32 board with a better web page than the original
app, and everything below is open source so you can do the same.

---

## Part 1: What is this thing?

### Start with the label

The underside says Mattel **GWM53** (the European retail number; the product is **GLD09** in the manual and the app), 5 V DC
1 A, and **FCC ID 2ADXEHY-40R201PC**. FCC IDs are gold: they lead to the radio
module. HY-40R201PC turns out to be a Bluetooth LE 5.0 module from Shenzhen Sheng Run Technology, built on a **Texas Instruments
CC2640R2**. So we're dealing with **Bluetooth Low Energy**, not WiFi.

### Find it in the air

A 10-line Python script with [bleak](https://github.com/hbldh/bleak) lists every BLE device nearby. The strongest one, right next
to the lamp, had a Texas Instruments address prefix, manufacturer id `0x03B6`, and a strange name: **a 10-digit number**.

Connecting and listing its services (read-only!) showed:

* a custom service `4cea0001-…` with four characteristics: one to **write**, one that **notifies**, one long **read-only blob**,
  and another **write**;
* a **firmware-update service**. Rule number one: never touch it.

The read-only blob was 192 bytes: some readable digits (`198101` followed by the 10-digit name…) followed by ~150 bytes that looked random. Random
bytes inside an identity blob usually mean **keys or a signature**. We subscribed to the notify characteristic and waited 40
seconds. Silence. So there's a handshake first, and it's probably cryptographic.

Time to look at the app.

---

## Part 2: Opening up the app (without running it)

We grabbed two old versions from APKMirror: **9.1.0** (late 2023) and **10.0.0** (the one that "removed" older products). An
APK is just a ZIP file, so we unzipped it and looked around, without installing or running anything.

### Clue 1: it's Flutter

The file list showed the app is written in Flutter. The interesting logic is compiled Dart code, which is harder to read
than Java. Hold that thought.

### Clue 2: a spec file per product

Inside `assets/` sat a folder of JSON files, one per product. One of them, `gld09.json`, was called **"Lumalou"** and had
`"apn": "XXXXXXXXXX"`: **exactly the lamp's Bluetooth name**. It even named the characteristics: `tx`, `rx`, `factory` and
`session`, and the protocol: `"ble_protocol": "mpid"`. And Lumalou was still in the **supported** list, even in version 10.0.

### Clue 3: where's the crypto?

Searching the binaries for readable strings (`session`, `encrypt`, `key`…) gave us the architecture in a few minutes:

* the Flutter code calls into a small Java "bridge" with start-session, encrypt and decrypt operations;
* that bridge calls a native library with functions for the public key and salt, token authentication and AES-CTR…

The big question for any "rescue" project: **does the handshake need the vendor's server?** If the key came from Mattel's
cloud, we'd be stuck. So we followed the data.

---

## Part 3: Cracking the session

### The Java layer (jadx)

We decompiled the Java side with **jadx** on a Kali Linux laptop. The bridge class showed the whole flow:

1. read the lamp's 192-byte **factory token** (the "random" blob);
2. look up a **public key by an ID stored inside that token** (keys are built into the app);
3. call the native library to start the session;
4. send the app's public key + a random "salt" back to the lamp.

**No server anywhere.** Everything needed is in the app and in the lamp itself. That was the moment we knew this would work.

(We also found a second crypto library disguised as an audio codec, with scrambled function names. It belongs to
older Fisher-Price products, not the Lumalou. Lesson: check which code path *your* device actually takes before going deep.)

### The native layer (Ghidra)

The native library still had its function names, which saved hours. **Ghidra** in headless mode decompiled 200 functions to a
text file, and the building blocks were all well-known open source:

* **micro-ecc** on the NIST **P-256** curve, for an ECDH key exchange,
* **tiny-AES** in **CTR** mode,
* SHA-256 and a **CRC-8** lookup table.

The interesting part is the glue. Here's the whole session key derivation, in plain words:

1. The lamp's token contains its **public key** (33 bytes, compressed P-256).
2. The app makes a fresh key pair and does **ECDH** → a 32-byte shared secret.
3. Then it runs **100 rounds of AES-128-CTR over that secret**, with a counter block containing the word… **`mattel`**.
   Literally `00 'm' 'a' 't' 't' 'e' 'l' 00`.
4. The first 16 bytes are the session key.

Each packet is `7E | sequence | length | CRC-8` followed by the AES-CTR-encrypted message and its CRC-8. The counter block mixes
the sequence number with both sides' random salts.

We re-implemented all of it in about 150 lines of Python (`mpid.py`), connected to the real lamp, sent our handshake, and…

### Silence

The lamp accepted the handshake and said nothing. We tried pairing mode (the lamp has a button for that, and it times out after
~90 seconds). We tried proper Bluetooth bonding from Windows. Nothing. Lesson learned the hard way: **a device that accepts your
handshake but stays quiet is usually waiting for a real command**, not for more authentication. The command format was in the
Flutter code, so we stopped guessing and went to get it.

---

## Part 4: The commands (Flutter decompilation)

Compiled Dart is not fun to read raw, but a Flutter/Dart decompiler makes it bearable: it rebuilds the exact Dart VM version
the app used and dumps the code with **function names, strings and constants**. Building one needed a few packages on the
Kali laptop and about 20 minutes.

The output had a section that read like a table of contents for the lamp's commands, with functions like `setLedColor`,
`setVolume`, `playAudio`, `setDayRoutine`, `setR2RTimes`, `sendPairingComplete`…

Following one of them, `setLedColor`, showed the framing:

```
command  = [opcode] [arguments…]
FP frame = FE | length | command | XOR checksum
message  = 01 10 | FP frame                 (to the lamp's sound-and-light chip)
           01 50 01                         (turn on replies, sent once)
```

and a `map()` function listing **all 68 commands with their opcode bytes**: set colour `3C`, brightness `3A`, volume `37`, play
sound `3F`, request status `53`…

> **Tip for reading decompiled Dart:** small numbers are "tagged" in compiled Dart, so a constant shown as `r17 = 32` is really
> **16**. And the decompiler's constant-object dump lets you print any enum as an index → name table, which is how we got the
> colour list, the song list and the routine tasks.

### It talks!

Same Python script, now with `01 50 01` and a status request after the handshake:

```
→ requestLightColor         ← 18 00        colour 0 (warm spectrum)
→ requestLedBrightness      ← 17 05        brightness 5
→ requestVolume             ← 15 05        volume 5
→ requestToyIcFwVersion     ← 12 01 63     firmware 1.99
```

Every reply decrypted with valid checksums. Then the first real command: **set colour 3**. The lamp turned **orange**. 🎉

---

## Part 5: The whole app, decoded

68 commands is a lot of reading. We used an AI agent (this whole project was done with Claude Code) to go through the decompiled
output for every setter and reply parser and write a spec, marking each item **certain** (read from code) or **inferred**.
The result is [COMMANDS.md](../docs/COMMANDS.md): 31 setters fully decoded, all 38 reply codes, and the 13-byte status block.
The highlights:

* **Times are BCD**: 07:30 is sent as the bytes `07 30`; "no time" is `FF FF`.
* The **lamp's clock** is just `HH MM SS weekday`. No date, which is why the app had to set it on every connect.
* **Sleep trainer:** 7 bedtimes and 7 wake-up times (Sunday … Saturday), plus an alarm per morning packed two days per byte.
  Sneaky detail: the app thinks in *nights* ("Monday night: bed 19:30, wake 07:00"), but the lamp stores wake times by
  *morning*, so the app shifts them by one day when saving.
* **Routines:** per weekday a start time and 12 task slots (`1T 2T … CT`: slot number in the high nibble, task in the low).
  Fun quirk: Sunday to Thursday answer with reply codes `2B`–`2F`, but Friday and Saturday answer with **`90` and `91`**.

Then we checked the important parts **on the real lamp with round-trips**: write a Sunday routine (07:30, get dressed → brush
teeth → eat), read it back, identical. Bedtime Monday 19:30 + wake Tuesday 07:00 + alarm, read back, identical. Set the lamp's
clock, read it back: 18:13 Monday, matching the PC to the second. Then we cleared everything again.

---

## Part 6: A permanent home on a €5 board

A PC script is nice for testing, but the lamp needs something that's always on. We had a spare **ESP32-S3** board, and
[ESPHome](https://esphome.io) makes it easy to add a custom component:

* the board connects to the lamp over Bluetooth, reads the token, does the ECDH with **mbedtls** (built into the ESP32's SDK);
  one gotcha: mbedtls can't load compressed public keys, so we decompress the lamp's key by hand
  (`y = (x³ − 3x + b)^((p+1)/4) mod p`, then pick the root with the right parity);
* then the "mattel" key schedule, the packet queue, and parsing every reply into a JSON status;
* it sets the lamp's clock from internet time when it connects and every night at 03:00;
* and it serves a web page, built into the firmware, so it works without internet.

It **compiled on the first try**, connected to the lamp ~10 seconds after power-on, and from a phone we turned the lamp blue.

### The page

We wanted it nicer than the original app: a night sky, a cloud that glows in the lamp's current colour (brighter with the
brightness setting), and four tabs.

| ![Sleep trainer](images/page-v2-sleep.jpg) | ![Routines](images/page-v2-routines.jpg) |
|---|---|
| **Sleep:** bedtime, wake-up time and alarm for each night, "copy Monday to weekdays", nap timer | **Routines:** start time + tasks per weekday, live start / back / done / stop |

![Clock](images/page-v2-clock.jpg)

When the wake-up alarm rings, an orange banner with a big **Stop** button appears at the top.

### Better than the original: a sunrise wake light

Once you control a device yourself, you can add what the vendor never did. The first new feature: a **sunrise**. Before each
wake-up time from the sleep trainer, the board fades the lamp in like the sun coming up: red at brightness 1, then orange, then
yellow at full brightness, over 20 minutes (adjustable from 10 to 60). It runs on the ESP32 itself, so no phone is needed. A "Try
it now" button plays a 2-minute demo; on our lamp it went red 1 → red 3 → orange 4 … 6 → yellow 8 → 9 right on schedule.

![Sunrise wake light](images/page-v3-sunrise.jpg)

### More sounds from the same lamp

The original app only offered a guided sleep playlist and a few noises. Inside, the lamp holds **12 named songs** (from *Sleep
Baby Sleep* to *Crickets in Space*). It can only play them through its custom playlist, so our page plays a single song by
loading a one-song playlist, remembers your own playlist, and offers to put it back. There's also a playlist editor. What it
can't do: new audio files. The sounds live inside the second chip, and changing them would mean a risky firmware update.

![Songs](images/page-v3-songs.jpg)


---

## Plot twist: someone got there first 🙌

After all this, while researching the hardware for this post, we found
**[stramanu/lumalou](https://github.com/stramanu/lumalou)** by Emanuele Strazzullo (MIT licence): the **same protocol, cracked
independently**, with a Python package, an npm package and a Web Bluetooth app that runs in your phone's browser. We hadn't seen
it. Two independent teams arrived at the same ECDH + "mattel" key stretch + AES-CTR + CRC-8 design, which is about the best
confirmation a reverse-engineering result can get.

Lessons: **search GitHub for the device name before you start** (we searched for the service UUID, which found nothing). And
it's fine to be second: our angle is different. They give you a library and a browser app; we give the lamp a **permanent,
always-on bridge** (ESP32 + ESPHome) with its own page, Home Assistant entities, automatic clock sync, and a byte-level spec of all
68 commands. Use whichever fits. If you just want to try your lamp right now, their web app is the fastest start.

---

## What's inside, and what's next

* **Two chips:** the TI **CC2640R2** Bluetooth chip (in the HY-40R201PC module) handles the radio and the encryption. A second
  "toy IC", probably a Nuvoton audio microcontroller (our guess; nobody has published the chip marking), runs the light, the sounds and
  the clock. They talk over SPI, which is why every command is wrapped as an "SPI write".
* **No custom sounds:** the "custom playlist" only reorders the 12 built-in tracks. Uploading your own audio would mean
  flashing firmware, and we're not going there.
* **The clock forgets on every power cut,** and the manual says the sleep trainer and routines stay off until the clock is set
  again. That used to need the app. Our bridge sets the clock automatically whenever it reconnects, which is after every power cut.
* **The siblings:** the app's spec lists two more products on the same encrypted protocol: the **Hoppy Dreams** bunny soother
  (`gmn58`) and a product code `ghp38` ("Whisper"). They should work with the same bridge plus their own command set.
* **Ideas we want to build next:** wake times driven by a Home Assistant calendar (school days vs holidays), a "child is up"
  phone notification, and a weekly sleep log. (The sunrise wake light is already done, see above.) The full ranked list is in
  [RESEARCH-IDEAS.md](../docs/RESEARCH-IDEAS.md).

---

## Do it yourself

Everything is in the repository: **[README](../README.md)**.

**If you have a Lumalou and just want to try it now:** open the [stramanu web app](https://github.com/stramanu/lumalou) in
Chrome on Android or desktop.

**For a permanent setup:** get any ESP32 board with Bluetooth, install ESPHome, put your WiFi into `secrets.yaml`, your lamp's
Bluetooth address and timezone into `lumalou.yaml`, flash, and open `http://lumalou.local`. That's it. No reverse engineering
needed: it's done. No ESP32? `python lumalou_cli.py` controls the lamp from any PC with Bluetooth.

**If you have a different abandoned gadget**, here's the method in short (the long version, with commands, is in
[REVERSE-ENGINEERING.md](../docs/REVERSE-ENGINEERING.md)):

0. **Search GitHub and forums for the device name first.** Someone may already have done it (we learned that the hard way).
1. **Label → FCC ID → radio chip.** Know whether it's Bluetooth LE, WiFi or something else before you start.
2. **Scan and map it read-only.** Note which characteristics write, notify and read. Don't touch firmware-update services.
3. **Get an old APK** from before the version that dropped your device. Unzip it and read the file list and the assets: config
   files often name everything.
4. **Search strings** in the binaries to find the architecture (UI → bridge → native crypto).
5. **jadx** for Java/Kotlin, **Ghidra** for native libraries, a Flutter/Dart decompiler for Flutter apps.
6. **Find out whether a server is involved.** If the keys are in the app or on the device, you can win.
7. **Re-implement in Python first**, test with *read-only* requests, verify every checksum, then change one visible thing.
8. **Expect silence** after a correct handshake. Devices often wait for a real command.
9. **Move it to an ESP32** with ESPHome for a permanent, local, cloud-free home.

### What it took

* About **6 hours**, one evening.
* Tools: Python (bleak, cryptography), jadx, Ghidra, a Dart decompiler and radare2 on a Kali laptop, ESPHome, a spare ESP32-S3.
* Done together with an AI coding assistant (Claude Code), which did the heavy reading of decompiled code, wrote the
  re-implementation and the firmware, and kept a journal of every step, which became this post.

### Fair play

We only used our own device and our own copy of the app, and this repository contains **no Mattel code, keys or binaries**:
only our own code and descriptions of how the protocol works, which is what interoperability work is about. The lamp's own
security checks (the signed factory token) are untouched: we simply talk to it the same way the app did.

---

*If this helped you rescue a device, tell us! And if your Lumalou behaves differently (another firmware version, for example),
open an issue with the output of `python lumalou_cli.py <address> status -v`.*
