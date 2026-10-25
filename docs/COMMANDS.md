# Lumalou application-layer command reference

Source: static analysis of the official app's behaviour and our own observations of the lamp's traffic.
We name commands after what they do; the names are ours, not the vendor's. Read-only analysis; nothing here was invented, but items marked **I** are inferred.

**Legend:** **C** = certain (confirmed from the app's behaviour or on the real lamp). **I** = inferred (from names, UI usage or symmetry). Hex is always hex.

---

## 0. Conventions (apply to every command)

| Item | Rule | |
|---|---|---|
| Frame | Every command is a payload `[opcode] + args`, which the transport wraps as `01 10 FE len payload xor`. Replies arrive as `01 50 FE len <code> <data…> xor`. | C (framing was already known) |
| Enum argument | An enum is sent as its **index** (`enum.index`, one byte), never as a mapped value. | C |
| Bool argument | `true` → `01`, `false` → `00`. Confirmed by the bedtime-schedule behaviour. | C |
| Reply dispatch | An empty reply is ignored. `code = reply[0]` selects the reply type (table in section 5); an unknown code is ignored. `reply.length < 2` is ignored. Otherwise the parser gets `data = reply.sublist(1)` (the bytes after the code). In this document, `data[0]` is the first byte after the reply code. | C |
| BCD | BCD encoding produces decimal digits MSB-first, prepends a 0 digit when the digit count is odd, and packs two digits per byte. For 0..99 that is one byte: 7 → `07`, 23 → `23`, 59 → `59`. BCD decoding returns **null when b > 0x99**; otherwise it reads `hex(b)` as a decimal number. | C |
| "No time" | A null hour or minute is sent as `FF`. A whole day slot is "unset" when it is `FF FF`. | C |
| Nibble packing | When the list length is odd it prepends 0 (`insert(0,0)`). It then packs pairs: `byte = (a<<4 & F0) \| (b & 0F)`. Used by clock settings, routine music status and R2R alarms. | C |
| Day order in 7-day blocks | Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday (su=0 … sa=6). | C |

---

## 1. Time / date / clock (priority)

### 1.1 `setCurrentDate` 0x30 — set the lamp RTC  (C)
- Args: 4 bytes, all BCD: `HH MM SS WD`.
  - HH = hour 00–23, MM = minute, SS = second.
  - WD = weekday, **0 = Sunday, 1 = Monday … 6 = Saturday**. This is ISO weekday modulo 7.
- **No year, month or day is sent.** The payload is `bcd(hour) + bcd(minute) + bcd(second) + bcd(weekday % 7)`.
- Example: Monday 07:05:09 → payload `30 07 05 09 01`.
- App use: The app sends the phone's local time every time the device becomes ready (C).

### 1.2 `requestCurrentDate` 0x31 (no args) → reply **0x13 currentDate**  (C)
- `data` must be ≥ 4 bytes: `data[0]`=hour, `[1]`=minute, `[2]`=second, `[3]`=weekday (0 = Sun). All BCD.
- If any byte is > 0x99, the parser stores nothing.
- Your observations decode as follows. `05 37 00 00` = 05:37:00, Sunday. `05 58 00 00` = 05:58:00, Sunday. The weekday is 0, which suggests the RTC was not set and is counting from power-on (I).
- The app only uses it for display.

### 1.3 `setClockSettings` 0x79 — digit clock on the lamp  (C)
- Source list is `[0, isOn, brightness, format]` → `reduceWithLowNibbles` → **2 bytes**:

| Byte | Bits | Meaning |
|---|---|---|
| 0 | high nibble = 0, low nibble = `Status` (0 off, 1 on) | clock display on/off |
| 1 | high nibble = brightness `LedBrightnessLevel` 0–9, low nibble = `ClockFormat` (0 = 12 h, 1 = 24 h) | |

- Example: on, brightness 5, 24 h → `79 01 51`.
- App use: Each change sends the full settings, and the saved clock settings are re-sent on every connect.

### 1.4 `requestClockSettings` 0x7A → reply **0x99 clockSettings**  (C for the reply; the app has no wrapper that sends 0x7A, so I assume no args)
- `data` must be **exactly 2** bytes, in the same layout as setClockSettings.
- `data[0]` low nibble = on/off. `data[1]` high nibble = brightness, low nibble = format.

### 1.5 `setTimePreScaler` 0x52  (C)
- 1 byte, `TimePrescaler` index: 0 normal, 1 scale10x, 2 scale60x, 3 scale3600x. This is a developer clock-acceleration feature (the "time machine").
- Example: `52 00` = normal.
- `requestTimePreScaler` 0x73 → reply **0x28**: `data[0]` = TimePrescaler index. The app has no wrapper for 0x73 (I). The value is also in global state byte 7, high nibble.

---

## 2. Sleep trainer: Ready-to-Rise (R2R), sleepy time, alarms, nap (priority)

### Semantics (C)
- Device slot `sleepy[D]` = bedtime on the evening of day D.
- Device slot `r2r[D]` = wake time on the morning of day D. `alarm[D]` = alarm for the morning of day D.
- The app's per-night schedule entry for day D has bedtime = `sleepy[D]`, wake = `r2r[D+1]` and alarm = `alarm[D+1]`. When the app writes the schedule it therefore shifts the R2R times and alarms by one day: the R2R Sunday slot gets Saturday-night's wake time.

### 2.1 `setSleepyTimes` 0x48 — 14 bytes  (C)
- 7 × (`HH MM`) in BCD, in the order Sun, Mon, Tue, Wed, Thu, Fri, Sat. `FF FF` = no bedtime that day.
- Example: 19:30 every night → `48 19 30 19 30 19 30 19 30 19 30 19 30 19 30`.

### 2.2 `setR2RTimes` 0x46 — 14 bytes  (C)
- Same layout as 2.1: 7 × `HH MM` BCD, Sun..Sat. Slot = wake time on that morning. `FF FF` = none.
- Example: wake 07:00 Mon–Fri only → `46 FF FF 07 00 07 00 07 00 07 00 07 00 FF FF`.

### 2.3 `setR2RAlarms` 0x4A — 4 bytes  (C)
- The list `[Sun, Mon, Tue, Wed, Thu, Fri, Sat, 0]` of `Alarm` indices is packed by nibble pairs:
  - byte0 = Sun<<4 | Mon
  - byte1 = Tue<<4 | Wed
  - byte2 = Thu<<4 | Fri
  - byte3 = Sat<<4 | 0
- `Alarm` values:

| Index | Value |
|---|---|
| 0 | active (alarm sounds at the R2R time) |
| 1 | activeAfter15minutes |
| 2 | activeAfter30minutes |
| 3 | activeAfter45minutes |
| 4 | activeAfter60minutes |
| 5 | activeAfter75minutes |
| 6 | activeAfter90minutes |
| 7 | activeAfter105minutes |
| 8 | activeAfter120minutes |
| 9 | **inactive** |
| 10 | activeAfter1minute |

- The app sends inactive (9) for any day without a schedule entry.
- Example: Mon–Fri active, weekend off → `4A 90 00 00 90`. All off → `4A 99 99 99 90`.

### 2.4 `setR2RStatus` 0x44 — 1 byte bool (C)
- `01` = enable the sleep trainer, `00` = disable it.

### 2.5 App flows (C)
- **Saving a schedule** (`sleepTrainerSchedule=`), in order:
  1. `setSleepyTimes`
  2. `setR2RTimes`
  3. `setR2RAlarms`
  4. `setR2RStatus(01)`
- **Removing all entries** (`removeSleepTrainerSchedule`), in order:
  1. `setSleepyTimes` with all `FF FF`
  2. `setR2RTimes` with all `FF FF`
  3. `setR2RAlarms` with all inactive (`99 99 99 90`)
  4. `setR2RStatus(00)`
  5. `startNapTime(00)` (stop nap)
- **On connect:** the schedule saved on the phone is compared with the device's values and re-sent when they differ.

### 2.6 Replies (C)

| Code | Request | Layout |
|---|---|---|
| 0x22 readyToRiseTimes | `requestR2RTimes` 0x47 | `data` ≥ 14 bytes. Same layout as 2.2 (Sun..Sat, BCD `HH MM`). If length < 14 **or the sum of all bytes is 0**, every day is treated as unset. Bytes > 0x99 decode to a null hour or minute. |
| 0x23 sleepyTimeTimes | `requestSleepyTimes` 0x49 | Same rules as 0x22. |
| 0x27 readyToRiseAlarmTimes | `requestR2RAlarms` 0x4C | `data` ≥ 4 bytes, same nibble layout as 2.3: Sun = `d0`>>4, Mon = `d0`&F, Tue = `d1`>>4, Wed = `d1`&F, Thu = `d2`>>4, Fri = `d2`&F, Sat = `d3`>>4. Each value is an Alarm index 0–10. |
| 0x21 readyToRiseStatus | `requestR2RStatus` 0x45 (I) | `data[0]` = Status 0/1. The parser only range-checks it (< 2) and stores nothing. |
| 0x26 readyToRiseAlarmStatus | `requestR2RAlarmStatus` 0x4B (I) | `data[0]` < 2, same no-store parser. |

### 2.7 Nap  (C unless noted)
- `startNapTime` 0x4D — 1 byte `NapDuration` index:

| Index | Value |
|---|---|
| 0 | inactive (stops the nap) |
| 1 | 15 min |
| 2 | 30 min |
| 3 | 45 min |
| 4 | 60 min |
| 5 | 75 min |
| 6 | 90 min |
| 7 | 105 min |
| 8 | 120 min |
| 9 | 1 min (test) |

  - App: `startNap(d)` sends the index; `stopNap()` sends `4D 00`.
  - Example: `4D 04` = 60-minute nap.
- `requestCurrentNapTimeStatus` 0x4E → reply **0x1C napTimeStatus**: `data[0]` high nibble < 2, low nibble < 10. I read these as nap status (0/1) and NapDuration index. The inherited parser range-checks them and stores nothing.
- `requestNapTimeAlarm` 0x51 (sent in initial sync) → reply **0x25 napTimeAlarmTime**: `data[0]` < 11, which looks like an `Alarm` index (I). Nothing is stored.
- `requestNapTimeAlarmStatus` 0x50 → **0x24**: `data[0]` < 2. Nothing is stored.
- `setNapTimeAlarm` 0x4F: **no app wrapper exists, so the argument format is unknown.** By analogy it is probably 1 byte with an Alarm index (I; needs a live test).

### 2.8 Stopping a ringing alarm (C, `stopAlarm`)
1. Send `setGlobalOn` 0x03 with `01`.
2. If the operation mode is routine (7), also send `routineControlCommand` `6B 04` (cancel).

The app calls `stopAlarm` when global-state byte 12, low nibble = 1, which means the alarm is ringing.

---

## 3. Routines (priority)

`Task` values:

| Index | Task |
|---|---|
| 0 | noTask |
| 1 | clothes |
| 2 | wash |
| 3 | brushingTeeth |
| 4 | toilet |
| 5 | backpack |
| 6 | food |
| 7 | book |
| 8 | cleaning |
| 9 | wildcard1Heart |
| 10 | wildcard2Swirly |
| 11 | wildcard3Starburst |

`TaskStatus`: 0 inActive, 1 inProgress, 2 complete.

### 3.1 `set{Day}Routine` (Sun 5A, Mon 5C, Tue 5E, Wed 60, Thu 62, Fri 64, Sat 66) — 14 bytes  (C)
`_setDayRoutine` trims the task list to 12 (removeLast) and pads it with noTask to 12. `_encodeDayRoutineRequestBytes` then builds:

| Byte | Meaning |
|---|---|
| 0 | start hour, BCD (`FF` when no start time) |
| 1 | start minute, BCD (`FF` when no start time) |
| 2..13 | slot i = 1..12: `(i<<4) \| task` → `1T 2T 3T … CT` |

- Example: Monday 07:30, tasks clothes, wash, brushingTeeth → `5C 07 30 11 22 33 40 50 60 70 80 90 A0 B0 C0`.
- App use: Routine editing. For each day whose task string changed, the app first sends `6B 04` (cancel) if the lamp is in routine mode, then sends `setDayRoutine`. This also runs on connect from saved preferences.

### 3.2 `request{Day}Routine` (Sun 5B, Mon 5D, Tue 5F, Wed 61, Thu 63, Fri 65, Sat 67), no args → replies  (C)

| Reply code | Day |
|---|---|
| 0x2B | Sunday |
| 0x2C | Monday |
| 0x2D | Tuesday |
| 0x2E | Wednesday |
| 0x2F | Thursday |
| **0x90** | **Friday** |
| **0x91** | **Saturday** |

- The Friday and Saturday codes are not 0x30/0x31; this is exactly what the code's map says.
- `data` must be **exactly 14** bytes:
  - `data[0]` = BCD hour, `data[1]` = BCD minute (> 0x99 → null).
  - `data[2..13]`: task = `byte & 0x0F`. The upper nibble (slot number) is ignored. Values ≥ 12 and noTask are skipped.

### 3.3 `setRoutineModeStatus` 0x58 — 1 byte bool  (C)
- Enables (`01`) or disables (`00`) routines. App: `isRoutineEnabled=`, also sent on connect.
- `requestRoutineModeStatus` 0x59 → reply **0x92**: `data[0]` = Status (range-checked, nothing stored). The app has no wrapper for 0x59 (I).

### 3.4 `setRoutineModeVolume` 0x77 — 1 byte `VolumeLevel` 0–9  (C)
- App: Routine volume (accepts 0..9), also sent on connect.
- `requestRoutineModeVolume` 0x78 → reply **0x98**: `data[0]` = VolumeLevel. This value also appears in global-state byte 11, low nibble.

### 3.5 `setRoutineMusicStatus` 0x69 — 2 bytes  (C layout; arg meanings I)
- The setter takes three bools `(a,b,c)`, packed as `[a, (b<<4)|c]`.
- The app always calls it as `(taskMusicOn, rewardMusicOn, rewardMusicOn)`. From the setters `isTaskMusicOn=` / `isRewardMusicOn=`.
- Example: task music on, reward music on → `69 01 11`.
- `requestRoutineMusicStatus` 0x6A → reply **0x93**: `data` ≥ 2 bytes, laid out as `data[0]`&F, `data[1]`>>4, `data[1]`&F. Each value is range-checked (< 2) and **not stored** by the app.

### 3.6 `routineControlCommand` 0x6B — 1 byte `RoutineControlCommand` index  (C)

| Value | Meaning | App use |
|---|---|---|
| 0 | completeCurrentTask | "next" when status `data[0]` > 0 |
| 1 | returnToPreviousTask | "previous" |
| 2 | returnToBeginningOfSequence | "next" when status `data[0]` == 0 |
| 4 | cancelRoutinesWithoutCompletion | cancel / exit, before editing a day, and when stopping an alarm |

- Index 3 was not defined; the app never uses it.

### 3.7 `startRoutineMode` 0x7B — no args  (C). App: `startRoutine()`.

### 3.8 `requestRoutineTaskStatus` 0x68 → reply **0x94 routineTaskStatus**  (C layout; meaning of byte 0 I)
- `data` ≥ 7 bytes.
- `data[0]` = an integer. It is 0 when no routine is running. The app compares it with the task count, so I read it as the 1-based current step.
- Task statuses (TaskStatus 0–2):

| Task | Position |
|---|---|
| clothes | `d1`>>4 |
| wash | `d1`&F |
| brushingTeeth | `d2`>>4 |
| toilet | `d2`&F |
| backpack | `d3`>>4 |
| food | `d3`&F |
| book | `d4`>>4 |
| cleaning | `d4`&F |
| heart | `d5`>>4 |
| swirly | `d5`&F |
| starburst | `d6`>>4 |

---

## 4. Light, sound, soother, global

| Command | Op | Args | App caller | |
|---|---|---|---|---|
| setLightColor | 3C | 1 B `LightColor` index (0 warm … 10 off, table §6) | light switched on in the app resends the current colour | C |
| turnOffCloudBackLight | 3E | none | light switched off in the app | C |
| setLedBrightness | 3A | 1 B `LedBrightnessLevel` 0–9 | set from the app UI | C |
| setVolume | 37 | 1 B `VolumeLevel` 0–9 | set from the app UI | C |
| playAudio | 3F | 1 B `AudioCommand` (table §6) | starting a sleep stage sends `3F 00` | C |
| turnOffAudio | 38 | none | set from the app UI | C |
| setMusicPlaylist | 40 | **12 B**: `Song` index per slot. Truncated to 12 and padded with `00` (noSong). An empty list sends nothing. | `customPlaylists=`. Afterwards `playAudio(01)` plays the custom playlist (I). | C |
| setPlaylistDuration | 42 | 1 B `PlaylistDuration`: 0 = 5 min, 1 = 10, 2 = 15, 3 = 20, 4 = 1 min | music timer setting in the app | C |
| setSootherModeLightDuration | 6C | 1 B `LightDuration`: 0 = 15 min, 1 = 30, 2 = 60, 3 = 90, 4 = continuous, 5 = 1 min | light timer setting in the app | C |
| setGlobalOn | 03 | 1 B bool | `stopAlarm` sends `03 01`; sleep-stages `isActive=false` sends `03 00` | C (exact firmware effect I) |
| setGlobalState | 01 | **unknown**: there is no wrapper in the app | — | — |
| sendPairingComplete | 34 | none | initial sync | C |
| requestGlobalState | 53 | none → reply 0x02 | initial sync, refresh | C |
| requestToyIcFwVersion | 35 | none → reply 0x12 (2 B, stored as a hex string) | initial sync | C |
| requestMusicPlaylist | 41 | none → reply 0x19 | initial sync | C |
| requestTransmissionMode | 76 | none → reply 0x1D (`data[0]` < 2, not stored) | initial sync | C |

The following request opcodes have **no wrapper in the app**: 3B (brightness), 3D (colour), 39 (volume), 55 (song playing), 43 (playlist duration), 6D (light duration), 72 (operation mode), 74 (activity), 75 (stage), 73, 59, 6A, 78, 7A, 45, 4B, 4E, 50. They presumably take no args (I). Their likely replies are listed in §5.

---

## 5. Reply codes and layouts

The code → reply-type mapping is **C**. The "triggered by" column is **I** unless noted.

| Code | Reply | Triggered by | `data` layout |
|---|---|---|---|
| 02 | globalState | 53 (C) | 13 B, see 5.1 |
| 11 | otaCompleteNotification | OTA | stored as a hex string |
| 12 | toyIcFirmwareVersion | 35 (C) | 2 B, hex string |
| 13 | currentDate | 31 (C) | 4 B BCD: H M S WD (§1.2) |
| 14 | currentSong | 55 | `d0` = Song 0–18 |
| 15 | currentVolume | 39 / 37 | `d0` = VolumeLevel 0–9 |
| 16 | lightStatus | 3E / 3C | `d0` = Status 0/1 |
| 17 | lightBrightness | 3B / 3A | `d0` = LedBrightnessLevel |
| 18 | lightColor | 3D / 3C | `d0` = LightColor 0–10 |
| 19 | currentPlaylist | 41 (C) | exactly 12 B, each a Song index (noSong is kept) |
| 1A | audioTimerDuration | 43? | `d0` = TimerDuration (table §6) |
| 1B | timerAboutToExpire | lamp-initiated | no data used |
| 1C | napTimeStatus | 4E / 4D | `d0`>>4 < 2 (status), `d0`&F < 10 (NapDuration); not stored |
| 1D | transmissionMode | 76 (C) | `d0` < 2; not stored |
| 1E | operationMode | 72 | `d0` = OperationMode 0–7 |
| 1F | activityState | 74 | `d0` = Status |
| 20 | currentStage | 75 | `d0` = Stage 0–3 |
| 21 | readyToRiseStatus | 45 / 44 | `d0` = Status; not stored |
| 22 | readyToRiseTimes | 47 (C) | §2.6 |
| 23 | sleepyTimeTimes | 49 (C) | §2.6 |
| 24 | napTimeAlarmStatus | 50 | `d0` < 2 |
| 25 | napTimeAlarmTime | 51 (C) | `d0` < 11 (Alarm?) |
| 26 | readyToRiseAlarmStatus | 4B | `d0` < 2 |
| 27 | readyToRiseAlarmTimes | 4C (C) | §2.6 |
| 28 | timePrescaler | 73 / 52 | `d0` = TimePrescaler |
| 2B–2F | Sunday–Thursday routine | 5B–63 (C) | §3.2 |
| 90 | fridayRoutine | 65 (C) | §3.2 |
| 91 | saturdayRoutine | 67 (C) | §3.2 |
| 92 | routineModeStatus | 59 / 58 | `d0` = Status; not stored |
| 93 | routineMusicStatus | 6A / 69 | §3.5 |
| 94 | routineTaskStatus | 68 (C) | §3.8 |
| 95 | lightDuration | 6D / 6C | `d0` = LightDuration 0–5 |
| 98 | routineVolumeLevel | 78 / 77 | `d0` = VolumeLevel |
| 99 | clockSettings | 7A / 79 | exactly 2 B (§1.3) |

The single-byte replies carry `d0` as a whole byte and ignore the reply if `data` is empty. "Not stored" means the app range-checks the value and discards it (inherited parsers); the byte still carries the value shown.

### 5.1 Global state 0x02 : **13 bytes, all nibble-packed**  (C)
Nothing is parsed unless `data.length ≥ 13`. H = high nibble, L = low nibble.

| Byte | H | L |
|---|---|---|
| 0 | operation mode, `OperationMode` | activityState, Status |
| 1 | music playing, Status (the app reads it as the music-on flag) | current song, upper 4 bits |
| 2 | current song, lower 4 bits. **song = (`b1`&F)<<4 \| (`b2`>>4)**, Song 0–18 | volume, VolumeLevel 0–9 |
| 3 | audio timer, TimerDuration 0–6 | light on/off, Status |
| 4 | light brightness, LedBrightnessLevel 0–9 | light colour, LightColor 0–10 |
| 5 | range-checked < 2, not used | range-checked < 10, not used |
| 6 | < 2, not used | < 2, not used |
| 7 | TimePrescaler 0–3 | sleep Stage 0–3 |
| 8 | **clock on** (Status; any value ≥ 2 also counts as on) | **clock brightness** 0–9 |
| 9 | **clock format** (0 = 12 h, 1 = 24 h) | < 2, not used |
| 10 | < 2, not used | < 2, not used |
| 11 | soother light duration, LightDuration 0–5 | routine volume, VolumeLevel 0–9 |
| 12 | < 2, not used | **alarm ringing** (Status). When 1, the app calls `stopAlarm` |

Your sample `01 00 05 51 50 04 00 00 12 01 11 45 00` decodes as:
- mode = soother, activity = on
- music off, song = noSong, volume 5
- audio timer = continuous, light on
- brightness 5, colour = warmSpectrum
- byte 5 = `04` (unknown)
- prescaler normal, stage none
- clock on, clock brightness 2, 12 h
- bytes 9L–10 = `1`,`1`,`1` (unknown flags)
- light duration = continuous, routine volume 5
- not alarming

---

## 6. Enum tables used (index = wire value)

| Enum | Values |
|---|---|
| OperationMode | 0 soother, 1 reserved, 2 daytimeAwake, 3 sleepyTime, 4 pairing, 5 firmwareUpdate, 6 napTime, 7 routine |
| Status | 0 off, 1 on |
| VolumeLevel / LedBrightnessLevel / LightBrightness | level0 … level9 = 0 … 9 |
| LightColor | 0 warmSpectrum, 1 red, 2 yellow, 3 orange, 4 green, 5 blue, 6 purple, 7 nighLight, 8 coolSpectrum, 9 rainbow, 10 off |
| Song | 0 noSong, 1 sleepBabySleep, 2 hourGlass, 3 frereJacques, 4 howLovelyTheEvening, 5 tarregaLagrima, 6 whatsTheMatterDear, 7 suoGan, 8 waterColorDreams, 9 danceOfTheJellyFish, 10 insideTheBubble, 11 paperKites, 12 cricketsInSpace, 13 pinkNoise, 14 ocean, 15 rain, 16 brownNoise, 17 nature, 18 highway |
| AudioCommand | 0 defaultReadySettleSleepPlaylist, 1 customPlaylist, 2 sfxPinkNoise, 3 sfxOcean, 4 sfxRain, 5 sfxBrownNoise, 6 sfxNature, 7 sfxHighway |
| TimerDuration | 0 15 min, 1 30, 2 60, 3 90, 4 120, 5 continuous, 6 1 min |
| PlaylistDuration | 0 5 min, 1 10, 2 15, 3 20, 4 1 min |
| LightDuration | 0 15 min, 1 30, 2 60, 3 90, 4 continuous, 5 1 min |
| TimePrescaler | 0 normal, 1 ×10, 2 ×60, 3 ×3600 |
| Stage | 0 none, 1 ready, 2 settle, 3 sleep |
| ClockFormat | 0 twelveHour, 1 twentyFourHour |
| WeekDay | 0 su, 1 mo, 2 tu, 3 we, 4 th, 5 fr, 6 sa |
| Alarm | 0 active, 1–8 activeAfter 15/30/45/60/75/90/105/120 min, 9 inactive, 10 activeAfter1minute |
| NapDuration | 0 inactive, 1–8 = 15/30/45/60/75/90/105/120 min, 9 1 min |
| Task | 0 noTask, 1 clothes, 2 wash, 3 brushingTeeth, 4 toilet, 5 backpack, 6 food, 7 book, 8 cleaning, 9 wildcard1Heart, 10 wildcard2Swirly, 11 wildcard3Starburst |
| TaskStatus | 0 inActive, 1 inProgress, 2 complete |
| RoutineControlCommand | 0 completeCurrentTask, 1 returnToPreviousTask, 2 returnToBeginningOfSequence, 4 cancelRoutinesWithoutCompletion |

---

## 7. Connect / pairing flow

### initial sync (C, exact order)
1. firmware-version request (transport level)
2. `sendPairingComplete` 34
3. `requestGlobalState` 53
4. `requestCurrentDate` 31
5. `requestToyIcFwVersion` 35
6. `requestMusicPlaylist` 41
7. `requestR2RTimes` 47
8. `requestSleepyTimes` 49
9. `requestR2RAlarms` 4C
10. `requestNapTimeAlarm` 51
11. `requestRoutineTaskStatus` 68
12. Day routines in the order Mon 5D, Tue 5F, Wed 61, Thu 63, Fri 65, Sat 67, Sun 5B
13. `requestTransmissionMode` 76

The generic connection layer calls initial sync when the session starts (I).

### After the model is ready (C, the order across components is I)
- `setCurrentDate` (phone local time, §1.1).
- Each component's saved-settings sync pushes the phone-side state:
  - clock: `setClockSettings`
  - routines: weekly `set{Day}Routine` (when changed), `setRoutineMusicStatus`, `setRoutineModeVolume`, `setRoutineModeStatus`
  - sleep trainer: when it differs from the device, `setSleepyTimes`, `setR2RTimes`, `setR2RAlarms`, `setR2RStatus`
  - timers: `setPlaylistDuration` / `setSootherModeLightDuration`

### Refresh
refresh → `requestGlobalState`.

---

## 8. Coverage and what still needs a live test
- **Fully decoded (C):** 31 setters and actions (all in §1–§4 except setGlobalState and setNapTimeAlarm), all 7 day routines, every request the app actually sends, and all 38 reply codes in the table.
- **Partial or unknown:**
  - `setGlobalState` 0x01 and `setNapTimeAlarm` 0x4F have no wrapper in the app, so their args are unknown.
  - The third bit of setRoutineMusicStatus has an unknown meaning.
  - Global-state bytes 5, 6, 9L, 10 and 12H have unknown meanings.
  - The meaning of `data[0]` in 0x94 is inferred.
  - Request→reply pairing for opcodes without a wrapper is inferred.
  - 0x1A (TimerDuration) vs setPlaylistDuration (PlaylistDuration) is ambiguous.
- **Live tests worth doing:**
  - **Clock and RTC:** `30 HH MM SS WD`, then `31`, and expect 0x13 to echo. `7A`, and expect 0x99. `79 01 51`, and expect the clock to go to 24 h.
  - **Day routine:** `5D`, and expect a 14-byte 0x2D. Confirm that Friday and Saturday really answer with 0x90 / 0x91.
  - **Sleep trainer:**
    - Confirm that R2R slot D really means the morning of D. Set one test time a few minutes ahead with the alarm active, then `44 01`.
    - Check whether `4F <Alarm>` is accepted.
  - **Global:** what `03 01` vs `03 00` does when no alarm is ringing.
