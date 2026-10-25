# Lumalou hardware

Short version below; sources, the module pinout and the full reasoning are in [RESEARCH-IDEAS.md](RESEARCH-IDEAS.md) §1.

| Part | What we know | Confidence |
|---|---|---|
| Product | Fisher-Price **Lumalou**: "Better Bedtime Routine System" (US), "sleep & routine assistant" (EU). Launched Dec 2020, ~$100 | manual, retailers |
| Model numbers | **GLD09** (manual, app product code `gld09`); **GWM53** (EU retail SKU, on our unit's label); **GWM52** (UK) | regional SKUs of the same hardware: likely, unconfirmed |
| Power | 5 V DC 1 A adapter; the unit draws 0.3 A max | manual |
| Bluetooth module | **HY-40R201PC** (Shenzhen Sheng Run / TTCIOTSDK), FCC ID 2ADXEHY-40R201PC, IC 23267-HY40R201PC; 40 pins, PCB antenna | FCC filing, datasheet |
| Bluetooth chip | **TI CC2640R2F**: Cortex-M3 48 MHz, 128 KB flash, 28 KB SRAM, BLE 5.0; 2-pin cJTAG | TI datasheet |
| Second chip ("toy IC") | runs the light, sounds and clock; talks to the BLE chip over **SPI**; firmware 1.99 on our unit; updatable; the app calls its update path "nuvoton" → a **Nuvoton** MCU, exact part unknown | our protocol work; part number unconfirmed (no teardown published) |
| Remote control | included, 2 × AAA; starts the bedtime routine, starts/stops a nap, advances routine tasks | manual; its radio link is unknown |
| Display | clock display; **the time is lost on every power cut** (the bridge re-sets it automatically on reconnect) | manual |
| Product FCC filing | none found (the lamp relies on the module's certification) | FCC database search |

## Can you replace its firmware?

Technically the CC2640R2 can be re-flashed over cJTAG, but production chips are almost certainly debug-locked. Unlocking means a
**mass erase**: the original firmware and the factory keys are gone for good, and you'd have to re-implement the SPI link to the
toy IC from scratch. Not worth it: the encrypted protocol is fully understood and does everything. **Never write to the lamp's
firmware-update (DFU) service.**

## Custom sounds?

No: the "custom playlist" only re-orders the 12 built-in tracks; the audio lives on the toy IC.
