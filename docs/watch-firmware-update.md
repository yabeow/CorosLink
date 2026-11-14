# Watch firmware updates over Bluetooth

**Settings → Watch firmware** checks COROS for the next firmware release and installs it over Bluetooth, the way the COROS phone app's Bluetooth update does. It is for the **PACE 4** on firmware **3.2008.0 or newer**, over the Mac's and the Windows/Linux system Bluetooth (not the USB adapter). It needs the COROS sign-in from Watch Faces.

| Module | Role |
|---|---|
| `electron/corosFirmwareProtocol.ts` | The watch protocol (OTA `0x94`, SendFile blocks), file checks, COROS's manifest, what comes next, the update plan, the messages users read. No I/O. |
| `electron/corosFirmwareService.ts` | `CorosFirmwareUpdater`: check, download, send, commit, and the result after the watch restarts. Talks to the watch through an injected link. |
| `electron/corosNativeBleService.ts` | The link (connect, battery, exchange, `firmwareBlock`), the `firmware` link task, the model gate, keeping the computer awake, the pending install in settings, the version check on every sign-in, diagnostics. |
| `electron/corosWatchfaceService.ts` | `queryCorosFirmware`: COROS's mobile `ota/query`. |
| `electron/main.ts` | The native confirmation before an update; asking before Quit or Disconnect stops one. |
| `native/corebluetooth/main.swift`, `scripts/coros_ble_route.py` | The `firmwareBlock` operation on macOS and on Windows/Linux. |
| `src/settings/WatchFirmwareSettings.tsx` | The Settings pane. |

## Flow

1. **Check** (`corosBle:firmwareCheck`). CorosLink connects if needed and reads the watch's version from Device Information (`2A26`, e.g. `V 3.2008.0`). It asks COROS `POST /coros/ota/query` with the model's `firmwareType` (`COROS W336`) and that version, as COROS app 4.10.8. COROS offers a release only to app versions that support it and otherwise names the one it needs (`appTargetVersion`: 4.11.8 for 3.2108.0), so the query is asked again as that version. Files without an install time (`timeuse`; none of 3.2108.0's have one) count 30 s each. The answer's `batchList` lists releases, sometimes an intermediate one first: the oldest release newer than the watch's comes next, one at a time, and the offer says when another follows. A release with a file CorosLink can't check, or one larger than its staging area on the watch (`firmwareStagingBytes`, read from the 3.2008.0 firmware; the watch would refuse it only when its turn came), is never installed in part nor skipped over: the pane says to use the COROS app. So does a watch on firmware older than 3.2008.0, whose update handler is another module. Then the watch is asked whether it can update (battery, then **BLEOTA**), and the pane shows the version, COROS's notes, the size and roughly how long sending takes (COROS's own speed figure). Nothing on the watch changes.
2. **Install** (`corosBle:firmwareInstall`). Main asks for a native confirmation naming the version and the time sending and installing take, then starts the update in the background; the pane follows `corosBle:firmwareStatus`. The updater asks the watch again, downloads what differs, asks once more right before sending, and sends each file: the system image first, the parts written in place (below) last. The computer is kept awake meanwhile, and Quit or Disconnect ask before stopping it.
3. **Commit** (**BLEOTA_GO**). The commit itself doesn't check whether the watch can install now, so the watch is asked (battery, BLEOTA) right before. The watch shows a downloading screen while it receives firmware and for about 30 s after the last block, and answers "not on the watch face" until it closes; within 90 s of a block that answer is waited out (asked every 3 s) instead of reported. The parts written in place are then read back through the watch's own CRC (which ignores the blanked marker): a value other than the new file's CRC withholds the commit, except 0, which says nothing (Wi-Fi firmware's record doesn't accept a blanked marker) and is only logged. If it can't (an activity started, the battery dropped), nothing is committed: the next **Update watch** only commits. Otherwise the watch checks every staged file, marks them installable and restarts; its bootloader verifies each image's RSA signature and installs it, which takes a few minutes with no Bluetooth.
4. **After the restart.** The commit is remembered in settings (`coros.firmware.pending`) before it is sent, so a lost answer or an app restart loses nothing. On the next sign-in in any session (`observeFirmware`), a watch on the new version marks the update complete; one still on the old version a minute or more after the commit marks it failed. The pane offers **Reconnect watch** once COROS's install estimate has passed.

Every step checks it is still talking to the same watch (serial number, model and version). The battery must be at least 30% (`FIRMWARE_MIN_BATTERY_PERCENT`) to start and to commit.

**Parts written in place.** Most components are staged apart from the copy the watch uses and change nothing until the commit. A few are staged over the live copy: GPS firmware (19, 45), Wi-Fi firmware (48), the stored bootloader and recovery images (81, 102) and the voice files (91, 92, 95, 96) (`IN_PLACE_TYPES`). A transfer that stopped after starting one of them leaves that feature unusable until the update is finished; the pane says so and **Update watch** finishes it (a retry sends only the blocks the watch doesn't hold yet).

Downloads are kept in `userData/watch-firmware/<model>/<version>/`, checked against the manifest (size, CRC-16 and CRC-32) and their own headers before use and again before sending, reused on a retry, and removed once the watch has them. Only `https://*.coros.com` files are fetched, and redirects are refused. Both COROS requests are reads, so they work in Local-Only Mode.

Users read only the messages in `FIRMWARE_TEXT` and `FIRMWARE_REFUSALS` (all translated); the raw errors, the watch's answers, the plan and the outcome go to the diagnostics log (`corosBle:firmware`), never the serial number.

## The watch's side (PACE 4 W336, 3.2008.0)

Traced in the firmware: the OTA handler and its worker (`0x604a0790`, `0x604a035c`), the readiness check (`0x604a0268`), the SendFile header and data handlers (`0x6049f684`, `0x6049fdd8`), the component records (`0x0065baf8`) and the staging-area table (`0x0065b848`).

**OTA, opcode `0x94`.** Subcommand byte, then data; the answer comes from a work queue.

| Sub | Name | Request | Answer |
|---|---|---|---|
| 0 | BLEOTA | `[0]` | `[status]` when the watch can't update now, else `[1]{type, CRC-16 LE}…` |
| 1 | BLEOTA_GO | `[1][system length u32][system CRC u16][types…]`, 7–70 bytes | `[ok][type \| ok << 7 …]`, then the watch restarts when all pass |
| 6 | OTA_STATUS | `[6]` | 17 bytes (not used) |

BLEOTA refuses with `0x15` low battery (and not charging), `0x16` an activity is running, `0x1A` USB cable in, `0x1B` music playing, `0x1C` navigating, `0x33` not on the watch face. Its list holds the components the watch keeps up to date (fonts, language, bitmaps, Bluetooth and Wi-Fi firmware, GPS firmware, voice resources for the selected voice language, bootloader, recovery); touch firmware and a few others are never listed. Each CRC is **CRC-16/CCITT-FALSE over the whole file, header included**: exactly COROS's `fileCRC`. It is 0 for a component that is missing or unreadable. The system image is never listed: it is sent whenever the version changes, and BLEOTA_GO always checks it. BLEOTA_GO doesn't run the readiness check.

**SendFile, opcode `0x78`, file ID = component type.** Header as for every SendFile (`[0x78 0][type][offset u32][len u16][remaining u32][crc16][sum][0 0 0][3][sum]`), 4 KB blocks from 4 KB boundaries. Each type has a fixed staging area (the system image at `mmcblk0p3:0x04000000`, up to 23 MB; type 2, 45 MB). The header answer is `[status, bound, MTU, window, 1, 3]`: status 0 sends the data, 1 means the area already holds this block. Data frames go on the bulk channel numbered **modulo the window**; the watch answers `78 00` on bulk (handle 0x1f) after each full window, and `[1, bound, type]` on control once the block's CRC checks out (`[2, bound]` if a frame went missing). A type with no staging area (for example NFC firmware, 86) is answered "done" with mode byte 0: CorosLink never treats that as sent. For the image types, the watch writes `FF FF` over the HF/DF magic while staging and computes CRCs as if it were there, so files go exactly as COROS serves them; the commit writes the magic back.

The bootloader verifies the system image, bootloader and recovery against a fixed RSA key before installing; the commit itself checks only lengths and CRCs.

**Tried on a PACE 4 (3.2008.0, macOS).** Read-only: BLEOTA refused with `0x33` from a menu (49 ms), and on the watch face listed 17 components in about 1 s, the same answer twice; every CRC equals the manifest's `fileCRC` except type 44, which is still 3.1308.0's (COROS's update left it), so the next update sends it too. Writes, never committed: the first 20 blocks of type 9 (block 0 written, 1–19 already staged from COROS's last update) and of type 44 (14 written at about 16 KB/s, 6 already there). The component list was unchanged afterwards, and the downloading screen closed by itself 31.5 s after the last block. The bootloader zeroes the staging marker after installing and treats `FF FF` the same way, so a staged-but-uncommitted image is never installed.

**Installed on the same PACE 4 (3.2008.0 → 3.2108.0).** Seven files (system, bitmap font, Bluetooth, language, JP font, stored bootloader, recovery; 65.6 MB) took about an hour with no retries. Right before the commit the stored bootloader (81) and recovery (102) read back as sent, the watch accepted the commit for every file, and it was back on the watch face about 2 minutes later on 3.2108.0, every listed component at the new `fileCRC` (44 included). The watch's downloading screen stays at 0% throughout: as far as traced, its percentage is the OTA status that the watch's own Wi-Fi update fills in, which the Bluetooth file transfer never touches.

## Models

`WATCH_FEATURE_MODELS.firmware`: the PACE 4 only. The PACE 4 Pro, PACE Pro and APEX 4 builds have their own component lists and staging areas (records 97 and 99, other sizes, touch firmware written in place on the PACE Pro); the PACE 3 is another platform.

## Tests

- `npm run test:coros-firmware`: the protocol, manifest and plan, and the updater end to end against a fake watch and a fake COROS: refusals at each step and the battery floor, a refusal right before the commit and the commit-only retry, another watch mid-update, a lost commit answer, a pending install across restarts, cancel (with and without parts written in place), the error messages, damaged downloads. With `COROSLINK_FIRMWARE_SAMPLES` set to a folder with COROS's `ota_query.json` and its files, the real release is checked as well.
- `npm run test:coros-ble-python`: `send_firmware_block` against a fake watch that numbers frames modulo the window and acknowledges each window.
- `scripts/test-coros-corebluetooth-protocol.mjs`: the Swift helper's block checks.
- `npm run test:watch-firmware-ui`: the Settings pane in each state.
