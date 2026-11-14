"""Bounded SFT file blocks (routes, watch faces, music deletes); no credentials or UI-visible raw GATT API.

Mirrors the CoreBluetooth helper's `validFileBlock` and file acknowledgements, so Windows and
Linux send the same bytes as macOS.
"""
import asyncio
import binascii
from coros_ble_protocol import ProtocolError

ROUTE_FILE, WATCHFACE_FILE, MUSIC_DELETE_FILE = 0x14, 8, 93
# Small files pushed like the phone app does: a workout (41), weather (80), the training calendar (42), GPS assistance
# (13 ELPO or LTO, 68 the second ELPO file, 70 the RTO ephemeris).
WORKOUT_FILE, WEATHER_FILE, TRAINING_PLAN_FILE, EPO_FILE, ELPO_AHEAD_FILE, RTO_FILE = 41, 80, 42, 13, 68, 70
SATELLITE_FILES = frozenset({EPO_FILE, ELPO_AHEAD_FILE, RTO_FILE})
DATA_FILES = frozenset({WORKOUT_FILE, WEATHER_FILE, TRAINING_PLAN_FILE}) | SATELLITE_FILES
DATA_FILE_LIMIT = 65_536
# The firmware takes satellite files up to 256 KB (SendFile descriptors of 13, 68 and 70).
SATELLITE_FILE_LIMIT = 262_144
NAMES = {ROUTE_FILE: 'route', WATCHFACE_FILE: 'watch face', MUSIC_DELETE_FILE: 'music delete',
         WORKOUT_FILE: 'workout', WEATHER_FILE: 'weather', TRAINING_PLAN_FILE: 'training calendar', EPO_FILE: 'satellite data',
         ELPO_AHEAD_FILE: 'satellite data', RTO_FILE: 'satellite data'}


def little(data, offset, size):
    return int.from_bytes(data[offset:offset + size], 'little')


def validate_file_block(header, block, file_index):
    # Imported lazily: the music module imports this one for `little`.
    from coros_ble_music import valid_music_delete_file, valid_netease_delete_block
    # A NetEase delete has storage category 3 at +16 (local music 0), in the same 21-byte header.
    if file_index == MUSIC_DELETE_FILE and len(header) == 21 and header[16] == 3:
        if not (0 < len(block) <= 4096 and valid_netease_delete_block(header, block)):
            raise ProtocolError('Invalid COROS ' + NAMES.get(file_index, 'file') + ' block.')
        return
    limit = (0x320000 if file_index == WATCHFACE_FILE else SATELLITE_FILE_LIMIT if file_index in SATELLITE_FILES
             else DATA_FILE_LIMIT if file_index in DATA_FILES else 2_000_000)
    if (file_index not in NAMES or len(header) != 21 or header[:3] != bytes([0x78, 0, file_index]) or
            not 0 < len(block) <= 4096 or little(header, 7, 2) != len(block) or
            little(header, 9, 4) < len(block) or little(header, 9, 4) > limit or
            little(header, 3, 4) + little(header, 9, 4) > limit or
            (file_index == WATCHFACE_FILE and header[16] >= 10) or
            (file_index == MUSIC_DELETE_FILE and (header[16] != 0 or little(header, 3, 4) != 0 or
                                                  little(header, 9, 4) != len(block) or not valid_music_delete_file(block))) or
            # GPS assistance carries a 24-bit hour in bytes 16-18; other files a single byte.
            (header[19] != 3 if file_index in SATELLITE_FILES else header[17:20] != b'\x00\x00\x03') or
            sum(header[2:20]) & 255 != header[20] or sum(block) & 255 != header[15] or
            binascii.crc_hqx(block, 0xffff) != little(header, 13, 2)):
        raise ProtocolError('Invalid COROS ' + NAMES.get(file_index, 'file') + ' block.')


def validate_block(header, block):
    validate_file_block(header, block, ROUTE_FILE)


# Firmware components an update carries and the watch stages over SendFile (electron/corosFirmwareProtocol.ts),
# and the largest staging area (type 2's); the watch checks each type's own.
FIRMWARE_FILES = frozenset({0, 1, 2, 7, 9, 11, 16, 17, 19, 21, 23, 43, 44, 45, 47, 48, 50, 52, 81, 91, 92, 94, 95, 96, 102})
FIRMWARE_FILE_LIMIT = 0x3000000


def validate_firmware_block(header, block, file_index):
    """One 4 KB block of a firmware file, sent from a 4 KB boundary, with no slot or flag bytes."""
    if (file_index not in FIRMWARE_FILES or len(header) != 21 or header[:3] != bytes([0x78, 0, file_index]) or
            header[16:20] != b'\x00\x00\x00\x03' or not 0 < len(block) <= 4096 or
            little(header, 3, 4) % 4096 or little(header, 3, 4) + little(header, 9, 4) > FIRMWARE_FILE_LIMIT or
            len(block) != min(4096, little(header, 9, 4)) or little(header, 7, 2) != len(block) or
            sum(header[2:20]) & 255 != header[20] or sum(block) & 255 != header[15] or
            binascii.crc_hqx(block, 0xffff) != little(header, 13, 2)):
        raise ProtocolError('Invalid COROS firmware block.')


async def send_firmware_block(header, block, queue, write_control, write_bulk, maximum, file_index, timeout=20):
    """One firmware block: the header on control, then data on bulk a window at a time; the watch acknowledges
    each window with 78 00 on bulk and the block with its CRC check on control. `queue` yields (is_control, bytes).
    Returns True when the watch's staging area already held the block."""
    validate_firmware_block(header, block, file_index)
    if maximum < 21:
        raise ProtocolError('Bluetooth packet size is too small for a firmware update. Reconnect the watch to negotiate a larger MTU.')

    def window_ack(control, value):
        return value[:2] == b'\x78\x00' and 2 <= len(value) <= (2 if control else 4)

    async def next_item():
        item = await asyncio.wait_for(queue.get(), timeout)
        if item is None:
            raise ProtocolError('The watch disconnected during the firmware update.')
        return item

    def reply(value):
        # A refusal is a single status byte (firmware: 2 busy, 3 bad header, 0x14/0x2b/0xfd file not accepted now).
        if len(value) == 4 and value[1] == 0 and value[2] == value[3]:
            raise ProtocolError('The watch refused the firmware file (code ' + str(value[2]) + ').')
        if not 5 <= len(value) <= 9 or value[1] != 0 or sum(value[2:-1]) & 255 != value[-1]:
            raise ProtocolError('Invalid COROS file acknowledgement.')
        return value

    await write_control(header)
    while True:
        control, value = await next_item()
        if control and value and value[0] == 0x78 and not window_ack(control, value):
            value = reply(value)
            break
    # [status, bound, MTU, window, 1, 3]; status 1 is a block the staging area already holds. A file ID the
    # watch has no staging area for is answered "done" with mode 0, and one too large with 0x18.
    if len(value) == 8 and value[6] == 0x18:
        raise ProtocolError('The watch has no room for this firmware file.')
    if len(value) != 9 or value[6] != 1 or value[7] != 3:
        raise ProtocolError("The watch doesn't take this firmware file.")
    if value[2] == 1:
        return True
    if value[2] != 0 or value[4] < 20 or value[5] == 0:
        raise ProtocolError('The watch rejected the firmware block header.')
    payload_size = min(maximum, value[4], 240) - 3
    if payload_size < 17:
        raise ProtocolError('The firmware block exceeds the negotiated packet limit.')
    # Sequence numbers count modulo the watch's window; it rejects a block whose frames skip one.
    window = value[5]
    frames = [bytes([0x78, index % window, file_index]) + block[offset:offset + payload_size]
              for index, offset in enumerate(range(0, len(block), payload_size))]
    sent = 0

    async def send_window():
        nonlocal sent
        end = min(sent + window, len(frames))
        for frame in frames[sent:end]:
            await write_bulk(frame)
            # Bound queues on adapters without an exposed native flow-control callback.
            await asyncio.sleep(0.003)
        sent = end

    await send_window()
    while True:
        control, value = await next_item()
        if window_ack(control, value):
            if sent < len(frames):
                await send_window()
            continue
        if not control or not value or value[0] != 0x78:
            continue
        value = reply(value)
        # [status, bound, file]: 1 once the stored block's CRC matches; [2, bound] when a frame went missing.
        if len(value) == 5 and value[2] == 2:
            raise ProtocolError('Part of the firmware block was lost on the way. Keep the watch close and try again.')
        if len(value) != 6 or value[4] != file_index or value[2] != 1:
            raise ProtocolError('The watch rejected the firmware block.')
        if sent != len(frames):
            raise ProtocolError('Invalid COROS file acknowledgement.')
        return False


async def send_file_block(header, block, queue, write_control, write_bulk, maximum, file_index, on_frame=None):
    """Sends one block: the header on control, data frames on bulk, then waits for the watch's acknowledgement.
    Other control frames (such as music storage replies) go to `on_frame`."""
    validate_file_block(header, block, file_index)
    name = NAMES[file_index]
    if maximum < 21:
        raise ProtocolError('Bluetooth packet size is too small for ' + name + ' sync. Reconnect the watch to negotiate a larger MTU.')

    def done(value):
        return value[2] == 1 and (value[6] == 1 if len(value) == 9 else value[4] == file_index)

    async def answer(stage):
        while True:
            value = await queue.get()
            if value is None:
                raise ProtocolError('The watch disconnected during ' + name + ' sync.')
            if not value or value[0] != 0x78:
                if value and on_frame is not None:
                    on_frame(value)
                continue
            # A refusal is a single status byte (firmware: 2 busy, 3 bad header, others file not accepted now).
            if len(value) == 4 and value[1] == 0 and value[2] == value[3]:
                raise ProtocolError('The watch refused the ' + name + ' transfer (code ' + str(value[2]) + ').')
            if len(value) not in (6, 9) or value[1] != 0 or sum(value[2:-1]) & 255 != value[-1]:
                raise ProtocolError('Invalid COROS ' + name + ' acknowledgement.')
            if stage == 'ready':
                if done(value):
                    return None  # Watch verified a block retained from an interrupted transfer.
                if len(value) != 9 or value[2] not in (0, 1) or value[6] != 1 or value[4] < 20:
                    raise ProtocolError('The watch rejected the ' + name + ' block header.')
                return min(maximum, value[4], 240)
            if not done(value):
                raise ProtocolError('The watch rejected the ' + name + ' data block.')
            return None

    await write_control(header)
    size = await asyncio.wait_for(answer('ready'), 15)
    if size is None:
        return
    payload_size = size - 3
    if payload_size < 17 or (len(block) + payload_size - 1) // payload_size > 256:
        raise ProtocolError('The ' + name + ' block exceeds the negotiated packet limit.')
    for sequence, offset in enumerate(range(0, len(block), payload_size)):
        await write_bulk(bytes([0x78, sequence, file_index]) + block[offset:offset + payload_size])
        # Bound queues on adapters without an exposed native flow-control callback.
        await asyncio.sleep(0.003)
    await asyncio.wait_for(answer('complete'), 20)


async def send_route_block(header, block, queue, write_control, write_bulk, maximum):
    await send_file_block(header, block, queue, write_control, write_bulk, maximum, ROUTE_FILE)
