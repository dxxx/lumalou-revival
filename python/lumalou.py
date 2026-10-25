"""Lumalou application layer, on top of mpid.py (see docs/PROTOCOL.md and docs/COMMANDS.md).

Command path:
    payload  = [OPCODE[cmd]] + args
    fp       = FE | len(payload) | payload | xor(len, *payload)          (frame)
    spi      = 01 10 | fp                                                (transport wrapper)
    -> encrypted MPID packet on the tx characteristic
Control messages (not framed): enable read transmission = 01 50 01
"""
from functools import reduce

# Command name -> opcode, as observed from the official app
OPCODE = {
    "setGlobalOn": 0x03, "setGlobalState": 0x01, "requestGlobalState": 0x53,
    "setCurrentDate": 0x30, "requestCurrentDate": 0x31, "sendPairingComplete": 0x34, "requestToyIcFwVersion": 0x35,
    "setLedBrightness": 0x3A, "requestLedBrightness": 0x3B, "setLightColor": 0x3C, "requestLightColor": 0x3D,
    "turnOffCloudBackLight": 0x3E, "setVolume": 0x37, "requestVolume": 0x39, "turnOffAudio": 0x38, "playAudio": 0x3F,
    "requestSongPlaying": 0x55, "setMusicPlaylist": 0x40, "requestMusicPlaylist": 0x41, "setPlaylistDuration": 0x42,
    "requestPlaylistDuration": 0x43, "setR2RStatus": 0x44, "requestR2RStatus": 0x45, "setR2RTimes": 0x46,
    "requestR2RTimes": 0x47, "setSleepyTimes": 0x48, "requestSleepyTimes": 0x49, "setR2RAlarms": 0x4A,
    "requestR2RAlarms": 0x4C, "requestR2RAlarmStatus": 0x4B, "startNapTime": 0x4D, "requestCurrentNapTimeStatus": 0x4E,
    "setNapTimeAlarm": 0x4F, "requestNapTimeAlarm": 0x51, "requestNapTimeAlarmStatus": 0x50, "setTimePreScaler": 0x52,
    "requestTimePreScaler": 0x73, "requestOperationMode": 0x72, "requestActivityState": 0x74,
    "requestCurrentStage": 0x75, "requestTransmissionMode": 0x76, "setRoutineModeStatus": 0x58,
    "requestRoutineModeStatus": 0x59, "requestRoutineTaskStatus": 0x68, "setRoutineMusicStatus": 0x69,
    "requestRoutineMusicStatus": 0x6A, "routineControlCommand": 0x6B, "setRoutineModeVolume": 0x77,
    "requestRoutineModeVolume": 0x78, "startRoutineMode": 0x7B, "setSundayRoutine": 0x5A, "requestSundayRoutine": 0x5B,
    "setMondayRoutine": 0x5C, "requestMondayRoutine": 0x5D, "setTuesdayRoutine": 0x5E, "requestTuesdayRoutine": 0x5F,
    "setWednesdayRoutine": 0x60, "requestWednesdayRoutine": 0x61, "setThursdayRoutine": 0x62,
    "requestThursdayRoutine": 0x63, "setFridayRoutine": 0x64, "requestFridayRoutine": 0x65,
    "setSaturdayRoutine": 0x66, "requestSaturdayRoutine": 0x67, "setSootherModeLightDuration": 0x6C,
    "requestSootherModeLightDuration": 0x6D, "setClockSettings": 0x79, "requestClockSettings": 0x7A,
}
NAME = {v: k for k, v in OPCODE.items()}

ENABLE_READ_TRANSMISSION = bytes([0x01, 0x50, 0x01])


def fp_frame(payload: bytes) -> bytes:
    if not payload:
        return b""
    x = reduce(lambda a, b: a ^ b, payload, len(payload))
    return bytes([0xFE, len(payload)]) + payload + bytes([x])


def command(name: str, *args: int) -> bytes:
    """SPI payload for one Lumalou command (goes inside an MPID packet)."""
    return bytes([0x01, 0x10]) + fp_frame(bytes([OPCODE[name], *args]))


def parse_fp(data: bytes):
    """Find FE-framed messages in a decrypted payload -> list of (opcode name, args bytes, checksum_ok)."""
    out, i = [], 0
    while i + 2 <= len(data):
        if data[i] != 0xFE:
            i += 1
            continue
        n = data[i + 1]
        body = data[i + 2:i + 2 + n]
        if len(body) < n or i + 2 + n >= len(data) + 1:
            break
        x = data[i + 2 + n] if i + 2 + n < len(data) else None
        ok = x == reduce(lambda a, b: a ^ b, body, n)
        out.append((NAME.get(body[0], f"0x{body[0]:02X}") if body else "?", body[1:], ok))
        i += 3 + n
    return out
