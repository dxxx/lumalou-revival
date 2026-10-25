# Lumalou: hardware research and ideas

Research notes compiled 2026-10-12 (web research only, no device access). Every claim carries a source number from the
**Sources** list at the end. Anything not confirmed by a source is marked **(unconfirmed)**. No part numbers or dates were
guessed: where a source did not give one, the field says so.

---

## 1. Hardware

### 1.1 Summary table

| Item | Finding | Status / source |
|---|---|---|
| Product names | "Lumalou Better Bedtime Routine System" (US), "Lumalou sleep & routine assistant" (EU), "Lumalu Schlafassistent" (DE) | [1][3][4][5] |
| Model numbers | **GLD09** (US owner's manual, and the app's product code `gld09`); **GWM53** (EU retail SKU, EAN 887961943023); **GWM52** (Mattel UK shop) | [1][3][5]. That GWM52/GWM53 are regional SKUs of the same GLD09 hardware is **likely but unconfirmed** |
| Manual | GLD09 owner's manual, 28 pages, revision "Primary 07/31/2020", doc no. GLD09-0970-1102345604-DOM | [1] |
| Launch | Announced for **December 2020** on fisher-price.com at about **$100**; JPMA 2020 Innovation Award (Nursery) | [6] (secondary source: Working Mother via AOL) |
| Price | $99 (ttpm review), £104.99 RRP (Mattel UK), $80 (Walmart, out of stock); EU deals as low as €25.99 | [3][6][7][8] |
| Power | AC adapter input 100-240 VAC, output **5 VDC 1 A 5 W**; unit "Current/Power rating: 0.3 A MAX" | [1] |
| Remote | Included, **2 x AAA (LR03)**. Top button = start the Ready-Settle-Sleep lights/sounds; underside button = nap timer start/stop and end routine; the child presses it to advance tasks and to ask "sleep or wake?" | [1]. The radio link of the remote (IR, 2.4 GHz proprietary, BLE) is **unconfirmed** |
| Buttons on unit | Pairing button (manual shows its location) | [1] |
| Display | Clock display that "should immediately illuminate" at power-on; the time is **lost on power loss** and routines/sleep trainer stay disabled until the app re-syncs | [1]. Display technology (LED 7-segment?) **unconfirmed** |
| Routine tasks | 8 fixed tasks (Change Clothes, Brush Teeth, Pack Bag, Eat, Read, Clean Up, Wash Up, Go Potty) + 3 custom tasks; one routine per day; multiple routines | [1] |
| Sleep trainer | Bedtime + wake time per weekday, plus nap; red star = sleep, green star = wake | [1][7] |
| Sound | "Ready, Settle, Sleep" guided playlist (about 20 min of music and sounds incl. white noise); 12-track custom playlist of built-in tracks; speaker size/power **not published** | [2][4][7] |
| Product FCC ID | **None found.** Fisher-Price's grantee code **CCT** (104 IDs) shows no Lumalou/GLD09 filing; Mattel's codes (APB, BSU, JNW, PIY) do not either. The lamp relies on the module's **modular grant** | [9][10] |
| BLE module | **HY-40R201PC** (= WMD40R201SR6PC), Shenzhen Sheng Run Technology (tuner168.com, brand TTCIOTSDK). PCB IFA antenna with shield case, PCBA 25.16 x 15.22 x 2.0/2.6 mm, shield 13.0 x 18.4 x 1.5 mm, 40 pins | [11][12] |
| Module FCC/IC | FCC ID **2ADXEHY-40R201PC** (grantee 2ADXE), grants 2017-10-08 and 2020-04-28 (DTS, 2402-2480 MHz, test lab AGC Shenzhen); IC 23267-HY40R201PC. Exhibits online: user manual, **internal photos**, external photos, test report; block diagram/schematics/operational description are confidential | [11][12] |
| BLE SoC | TI **CC2640R2** die in a 6x6 mm 48-pin package marked "TTC2640R2" | [12][13] |
| CC2640R2F specs | Arm Cortex-M3 48 MHz + Cortex-M0 radio core + 16-bit sensor controller; **128 KB flash**, 28 KB SRAM (+8 KB cache/RAM); BLE stack, TI-RTOS and drivers in ROM; debug **2-pin cJTAG and JTAG**; SDK = SimpleLink CC2640R2 SDK | [14] |
| Module radio | +5 dBm TX typical, -97 dBm RX sensitivity, 1.8-3.8 V (2.7-3.3 V recommended), VDD must be 2.4-3.3 V while programming | [12] |
| Second MCU ("toy IC") | Firmware 1.99 on our unit; updated over SPI by the BLE chip; the app calls the mechanism "nuvoton" | our own reverse engineering. The exact Nuvoton part number is **unconfirmed** (no teardown found) |

### 1.2 HY-40R201PC pinout (from datasheet V2.2, 11 Nov 2017) [12]

| Pin | Name | Note |
|---|---|---|
| 1, 14, 27, 30, 40 | GND | (pin 2 also listed as ground in the garbled table) |
| 2-13 | DIO_0 ... DIO_11 | DIO_2 = **UART RX**, DIO_3 = **UART TX**, DIO_4 = wake-up (must not float), DIO_5-DIO_7 high drive 8 mA |
| 15-18 | DIO_12 ... DIO_15 | GPIO |
| **19** | **JTAG TMSC** | cJTAG data |
| **20** | **JTAG TCKC** | cJTAG clock |
| 21 | DIO_16 / TDO | 4-wire JTAG only |
| 22 | DIO_17 / TDI | 4-wire JTAG only |
| 23-26, 28 | DIO_18 ... DIO_22 | GPIO |
| **29** | **VDD** | 1.8-3.8 V |
| **31** | **RESET** | active low, pulled up on module |
| 32-39 | DIO_23 ... DIO_30 | GPIO / sensor controller / analog |

The table in the PDF is mis-aligned from pin 23 onward; the mapping above is our reconstruction from the name column and
should be checked with a multimeter before soldering.

**Which pins carry the SPI link to the toy IC is unknown** (needs a look at the board). Everything needed for a debug probe
(VDD, GND, RESET, TMSC, TCKC) is on the module's castellated edge, so it is reachable with fine wires even if the main PCB has
no test pads.

### 1.3 The CC2640R2: can its firmware be replaced?

* **Technically yes.** The CC2640R2F is fully supported by TI's free SimpleLink CC2640R2 SDK, Code Composer Studio and
  UniFlash, and is programmed over 2-pin cJTAG with an XDS110 probe (a TI LaunchPad's on-board XDS110 works) [14].
* **Reading out the original firmware is likely blocked.** Production devices normally set the CCFG debug lock. On a
  locked chip the only allowed action is a **forced mass erase**, which wipes the Mattel firmware and its keys for good
  [15]. **We have no backup**, and the Mattel image and its keys are not ours to redistribute anyway.
* **Risks:**
  1. Irreversible: after the mass erase the lamp has no BLE firmware; we would have to write our own, including the
     SPI protocol to the toy IC (which we only know from the BLE side).
  2. Bricking: TI forum reports describe chips that stay locked even after a forced mass erase (a bad CCFG write) and had to be
     replaced [15].
  3. Power: the module must be fed 2.4-3.3 V while programming [12]; do not back-feed the lamp's 5 V rail.
* **Verdict:** not worth it. The ESP32 bridge already gives full control without touching the lamp. Only consider it on a
  second, spare unit.

### 1.4 The toy IC: which Nuvoton?

No teardown or internal photo of the Lumalou was found, so the part number is **unconfirmed**. Reasoning:

* It has updatable firmware (version 1.99, OTA over SPI), so it is a **flash** part, not an OTP speech chip.
* It drives the speaker, RGB light and clock display, so it needs audio output and several PWM/GPIO lines.
* Plausible Nuvoton families: the **ISD9100/ISD9160 ChipCorder audio SoC** (Cortex-M0, up to 49 MHz, 145 KB flash for code and
  audio, 12 KB SRAM, 1 W speaker driver, 2.4-5.5 V, optional external audio flash, marketed for toys) [16]; the
  **NuVoice N57x flash speech controllers**; or a general Nuvoton MCU (M031/M0-class, 8051 N76E-class) with a separate audio
  flash. To find out: open the lamp and read the chip marking.

### 1.5 App and discontinuation timeline

| Date | Event | Source |
|---|---|---|
| 2020-07-31 | The manual already states: "We reserve the right to terminate digital applications after **April 30, 2022**" | [1] |
| 2020-12 | Launch | [6] |
| 2022-09-08 | App 8.6.4; 9.0.0 in March 2023 | [17] (APKMirror, via search snippet) |
| 2024-02-29 | App **10.0.0**: "Removed app control capabilities for older generation products" (users of the Seahorse soother got shutdown notices around March 2024) | [17][18] |
| 2025-03-19 | Android app removed from Google Play | [19] (third-party tracker AppBrain, via search snippet) |
| 2025-04-02 | iOS app last seen on the App Store | [20] |
| 2025-08 | App backend services shut down | [21] (community project; **no official source found**) |

**No official Fisher-Price/Mattel announcement was found.** French retail reviews from 2026 report that the app no longer
exists and the Bunny soother cannot be set up [22].

What the app offered: light colours and brightness, song and sound choice, light and sound timers, volume, the Ready-Settle-Sleep
playlist on/off, routines per weekday, sleep and wake times per weekday, nap timer, and setting the lamp's clock on pairing [1].

### 1.6 Prior art (important for the blog)

**stramanu/lumalou** (Emanuele Strazzullo, MIT) independently reverse-engineered the same MPID protocol: Python package
`lumalou` 0.1.0 on PyPI (2026-07-23), an npm/TypeScript package, and a Web Bluetooth web app at
lumalou.emanuelestrazzullo.dev [21][23]. Its write-up documents the ECDH P-256 handshake, AES-128-CTR framing, CRC-8, and the
GATT service `4cea0001-…`, and it also blacklists the DFU service. Our project adds the **ESP32/ESPHome bridge**, the full
68-command set (routines, sleep trainer, clock display) and Home Assistant entities. Credit it, compare notes, and consider
contributing back (e.g. our command list to its `spec/protocol.json`).

---

## 2. What else we can do (ranked)

Value: what it adds for the family. Effort: S (< 1 evening), M (a weekend), L (several weekends). Risk: to the lamp or the child.

| # | Idea | Value | Effort | Risk | How |
|---|---|---|---|---|---|
| 1 | **Self-healing clock and schedule** | Very high | S | None | The lamp forgets the time on every power cut and disables routines and the sleep trainer [1]. Have the ESP32 re-sync time **and re-push the weekly schedule** on every reconnect and once a night (NTP via ESPHome `time:`). Mostly done; add a "schedule pushed" status sensor. |
| 2 | **Home Assistant sleep-trainer control** | Very high | S-M | None | Expose bedtime/wake time per weekday as HA `time`/`select` entities, so HA (calendar, holidays, school days, DST) drives the lamp. E.g. a "no school" calendar event moves wake time to 7:30. |
| 3 | **Wake-up light (sunrise)** | High | S | None | HA script ramps brightness from 1 to max and warm colours over 20-30 min before wake time, then turns the star green. Uses the existing colour/brightness entities. |
| 4 | **"Child is up" notification** | High | S | None (privacy: keep local) | Trigger on the remote button (if the bridge reports routine/button events) or on the lamp state change; send a phone notification ("Up at 05:42, star was still red"). If the lamp does not report button presses, add a cheap mmWave/PIR sensor (ESPHome) next to the bed. |
| 5 | **Sleep log and statistics** | Medium-high | M | None | Log bedtime, lights-off, first wake, "asked too early" presses into HA's recorder/InfluxDB; weekly chart in Grafana or an HA dashboard. Good blog material. |
| 6 | **Bedtime scene** | Medium-high | S | None | One HA scene/voice command "bedtime": dim the room lights, start the routine on the lamp, start white noise at volume X, turn off the TV. |
| 7 | **Voice control** | Medium | S | None | Free via HA Assist (local), Google Home or Alexa through HA (Nabu Casa or manual). "Hey Google, start Lumalou bedtime routine". |
| 8 | **Powered from the lamp's USB / ESP32 inside** | Medium | M | Low-medium | The lamp needs 5 V 1 A and draws 0.3 A max [1]; an ESP32 draws about 0.1-0.25 A, so a USB Y-splitter or a 5 V tap is within the adapter's budget. Putting an ESP32-C3 inside the cloud is possible but: keep it away from the PCB antenna of the BLE module [12], no exposed wires (the product is near a child's bed), and it voids the warranty. A Y-cable is the safe 90 % solution. |
| 9 | **Notification light for other events** | Medium | S | Low | Use the cloud/star light for adult signals: washing machine done, doorbell, "dinner is ready" (blink purple 3x, then restore the previous state). Avoid during sleep hours. |
| 10 | **Speaker for other events** | Low-medium | S | Low | Only the built-in tracks can be played, so use them as "chimes" (one short track = "time to tidy up"). Not a TTS speaker. |
| 11 | **Nicer routines** | Medium | M | None | Weekend vs. weekday routines from an HA calendar; morning routine with countdown; reward sound only after all tasks; "routine done" event to HA for a sticker chart. |
| 12 | **ESP32 as HA Bluetooth proxy too** | Medium | S | None | ESPHome `bluetooth_proxy:` on the same board (check that it does not compete with the active connection; the lamp accepts only one connection). |
| 13 | **Bunny / Whisper support** | Medium (community) | M | Low | Same MPID handshake, different commands [21]. Ask owners for HCI snoop logs (see section 3). |
| 14 | **Custom sounds / audio upload** | Low (nice to have) | L | **High** | No evidence that the protocol ever accepted user audio: the "customPlaylist" only orders the 12 built-in tracks [21]. Audio sits in the toy IC's flash (or a flash chip next to it). Changing it would require the toy-IC OTA path ("nuvoton") with a valid image format we do not know: high brick risk, no recovery. Alternative: put a small I2S DAC + speaker (or a MAX98357A) on the ESP32 itself and play your own sounds next to the lamp. |
| 15 | **Firmware updates via DFU/OTA** | Low | L | **Very high** | There is no newer firmware to install (the backend is gone [21]) and a wrong write to the DFU service can brick the device [21][23]. Keep the DFU service blacklisted. |
| 16 | **Replace the CC2640R2 firmware** | Low | L | **Very high** | See 1.3: mass erase destroys the original firmware, we must re-implement the SPI side. Only on a spare unit. |

### Top 5 in short

1. Self-healing clock plus schedule re-push after power cuts (fixes the lamp's biggest weakness).
2. Sleep trainer in Home Assistant, driven by calendar/holidays/DST.
3. Sunrise wake-up light.
4. "Child is up" notification (lamp event or a presence sensor).
5. Sleep log and weekly statistics.

---

## 3. Other compatible products

From the app analysis published by stramanu/lumalou [21] (product codes from the app's asset files) and Mattel manuals:

| Device | Product code | Protocol generation | Notes |
|---|---|---|---|
| **Lumalou** (Better Bedtime Routine System) | gld09 | "magic device" MPID | ours; confirmed |
| **Bunny**: Hoppy Dreams Soother & Sleep Trainer (2019), 4 x AA | gmn58 | MPID | same handshake, different commands (untested) [21][22][24] |
| **Whisper** | ghp38 | MPID | GHP38 is listed as a Fisher-Price "Platinum Luminate" bassinet (2021) [25]; whether "Whisper" is that bassinet is **unconfirmed** |
| Swing, Cradle Swing, Revolve Swing, Glider | cbv76, dkd85, flg83, ffh99, gdd39 | legacy | different GATT/crypto |
| Mobile, Mobile Baby, Mobile Baby 2 | cdm85, cmk04, dfp73 | legacy | |
| Sleeper, Deluxe Sleeper, Bassinet | cmp94, dpv51, dpv70 | legacy | |
| Lamp Soother, Seahorse | dyw47, fhc95 | legacy | |

Several legacy devices use Fisher-Price's own "Mattel Bluetooth Low Energy Module" **CCT-CBV76-14** (granted 2017) or
**CCT-DPV70-01** [10][26]. Our ESP32 bridge can be reused for the Bunny and Whisper with a new command table; the legacy line
needs a separate reverse-engineering effort (an Android HCI snoop log from someone who still has the old app installed would be
the fastest start).

### Community and similar projects

* **stramanu/lumalou** (GitHub, PyPI, npm, web app) [21][23]: the closest project; link to it.
* Home Assistant community forum: no existing Fisher-Price Smart Connect integration was found. A post in
  "Share your Projects" plus a GitHub topic set (`home-assistant`, `esphome`, `fisher-price`, `lumalou`, `ble`,
  `right-to-repair`) would make the project findable.
* Comparable revivals of discontinued smart devices to mention in the blog: Hatch Rest (sound machine; HA integration
  `ha_hatch`), and other BLE devices kept alive through ESPHome (e.g. `ha-adjustable-bed` uses HA's Bluetooth stack [27]).

---

## 4. Legal / blog notes (keep it short)

* **EU, Software Directive 2009/24/EC, Article 6 (Decompilation):** reproducing and translating code is allowed without the
  rightholder's permission when it is **indispensable to obtain the information needed for interoperability** of an
  independently created program, done by a licensee, limited to the parts needed, and the information was not already readily
  available. The information may not be used for other goals, given to others except when necessary for interoperability, or
  used to make a substantially similar program [28]. Article 5(3) also allows observing and testing a program to find its
  underlying ideas [28].
* **US, 17 U.S.C. §1201(f) (Reverse engineering):** a person who lawfully obtained a program may circumvent a technological
  measure **solely to identify and analyze the elements needed for interoperability** of an independently created program,
  and may share that information or the means **solely for that purpose**, as long as it does not infringe copyright or break
  other laws [29].
* **EU Data Act (Regulation 2023/2854)**, applicable since 12 September 2025: users of connected products have a right to access
  the data their product generates [30]. Useful context, though it does not by itself oblige Mattel to keep an app alive.
* **Practical lines we keep:** no Mattel code, binaries or keys in the repo (the handshake key is read from the user's own app
  copy or device), no DFU/OTA writes, trademarks named only descriptively, and a clear "unofficial, not affiliated" notice.
  This is not legal advice.

---

## 5. Sources

1. Fisher-Price, *Lumalou GLD09 Better Bedtime Routine System, Owner's Manual* (rev. 07/31/2020): https://service.mattel.com//instruction_sheets/GLD09-0970-1102345604-DOM.pdf
2. Mattel product page, Lumalou GLD09: https://www.mattel.com/products/lumalou-5-soother-sleep-gld09
3. Action (EU retail, GWM53, EAN 887961943023): https://shop.action.com/en-nl/p/887961943023/fisher-price-lumalou-sleep-and-routine-assistant
4. Galaxus, Lumalu Schlafassistent + test: https://www.galaxus.at/de/s14/product/fisher-price-lumalu-schlafassistent-nachtlicht-14725802 and https://www.galaxus.at/de/page/der-schlafassistent-lumalu-will-einfach-kein-wecker-sein-20390
5. Mattel UK shop, GWM52: https://shopping.mattel.com/en-gb/products/fisher-price-lumalou-better-bedtime-routine-system-gwm52-en-gb
6. AOL / Working Mother, "The 8 Best New Baby and Toddler Sleep Products…" (launch Dec 2020, ~$100, JPMA award): https://www.aol.com/lifestyle/8-best-baby-toddler-sleep-193618644.html
7. ttpm review: https://ttpm.com/products/lumalou-better-bedtime-routine-system/
8. MonsterDealz (GWM53 at €25.99): https://www.monsterdealz.de/hobby-freizeit/spielwaren/fisher-price-gwm53-lumalu-schlafassistent-fuer-2599e/1327101
9. fccid.io search, Mattel grantee codes: https://fccid.io/search?q=Mattel
10. fccid.io, Fisher-Price grantee CCT: https://fccid.io/CCT
11. fccid.io, FCC ID 2ADXEHY-40R201PC (grants, exhibits incl. internal photos): https://fccid.io/2ADXEHY-40R201PC (official: https://www.fcc.gov/oet/ea/fccid)
12. Shengrun, *HY-40R201 Bluetooth BLE 5.0 Module Specifications* V2.2 (LCSC C172808): https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/Shenzhen-Shengrun-Tech-HY-40R201PC_C172808.pdf
13. JLCPCB part page HY-40R201PC: https://jlcpcb.com/partdetail/184196-HY40R201PC/C172808
14. TI, CC2640R2F product page: https://www.ti.com/product/CC2640R2F
15. TI E2E, "CC2640R2F-Q1: how to unlock the debug interface when it is locked": https://e2e.ti.com/support/tools/code-composer-studio-group/ccs/f/code-composer-studio-forum/848608/ccs-cc2640r2f-q1-how-to-unlock-the-debug-interface-when-it-is-locked
16. Nuvoton, I9160 / ISD9160 audio SoC: https://www.nuvoton.com/products/smart-home-audio/audio-socs/audio-socs-arm-cortex-m0/i9160fi/ and https://www.nuvoton.com/news/news/all/TSNuvotonNews-000042/
17. APKMirror, Fisher-Price Smart Connect versions and changelog: https://www.apkmirror.com/apk/fisher-price-inc/fisher-price-smart-connect/
18. AppStorio, Smart Connect app reviews (shutdown notice reports): https://fisher-price-smart-connect-app.appstor.io/app-reviews
19. AppBrain, com.fisher_price.android: https://www.appbrain.com/app/fisher-price%C2%AE-smart-connect%E2%84%A2/com.fisher_price.android
20. AppsHunter, iOS app 945748296: https://appshunter.io/ios/app/945748296
21. stramanu/lumalou on GitHub (README, docs/reversing.md, device table, shutdown dates): https://github.com/stramanu/lumalou
22. Auchan FR, Fisher-Price Lapinou compagnon dodo (2026 review: app gone): https://www.auchan.fr/mattel-peluche-lapinou-compagnon-dodo-fisher-price/pr-C1715896
23. PyPI, lumalou 0.1.0 (2026-07-23): https://pypi.org/project/lumalou/ ; web app: https://lumalou.emanuelestrazzullo.dev
24. Mattel, GMN58 instruction sheet: https://service.mattel.com//instruction_sheets/GMN58-4L.pdf
25. ManualsNet, Fisher-Price Platinum Luminate GHP38: https://manualsnet.com/fisher-price/mattel-platinum-luminate-ghp38
26. Mattel, FVY59 instruction sheet (contains module FCC ID CCT-CBV76-14, IC 4390A-CBV76): https://service.mattel.com//instruction_sheets/FVY59.pdf
27. ha-adjustable-bed (BLE via HA Bluetooth stack): https://tomevault.io/tome/kristofferR/ha-adjustable-bed
28. Directive 2009/24/EC on the legal protection of computer programs (Art. 5, 6): https://eur-lex.europa.eu/eli/dir/2009/24/oj
29. 17 U.S. Code §1201(f): https://www.law.cornell.edu/uscode/text/17/1201
30. Regulation (EU) 2023/2854 (Data Act): https://eur-lex.europa.eu/eli/reg/2023/2854/oj
