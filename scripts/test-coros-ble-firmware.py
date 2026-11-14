"""Firmware blocks over the Windows/Linux worker (coros_ble_route.send_firmware_block), against a fake
watch that behaves like the PACE 4 3.2008.0 SendFile receiver: header reply [status, bound, MTU,
window, 1, 3]; data frames numbered modulo the window, 78 00 on bulk after each full window; the block's
CRC checked at the end; a frame out of sequence aborts the block with [2, bound]."""
import asyncio, binascii, unittest
from coros_ble_route import send_firmware_block, validate_firmware_block
from coros_ble_protocol import ProtocolError


def header(block, file_index=9, offset=0, total=None):
    total = len(block) + offset if total is None else total
    h = bytearray(21); h[0] = 0x78; h[2] = file_index; h[3:7] = offset.to_bytes(4, 'little')
    h[7:9] = len(block).to_bytes(2, 'little'); h[9:13] = (total - offset).to_bytes(4, 'little')
    h[13:15] = binascii.crc_hqx(block, 0xffff).to_bytes(2, 'little'); h[15] = sum(block) & 255; h[19] = 3
    h[20] = sum(h[2:20]) & 255
    return bytes(h)


def ack(body):
    return b'\x78\x00' + body + bytes([sum(body) & 255])


class FakeWatch:
    def __init__(self, block, file_index=9, mtu=240, window=26, status=0, mode=3, ack_last_window=False, lose=None):
        self.block, self.file_index, self.mtu, self.window = block, file_index, mtu, window
        self.status, self.mode, self.ack_last_window, self.lose = status, mode, ack_last_window, lose
        self.queue = asyncio.Queue()
        self.received = bytearray()
        self.last = -1
        self.in_window = 0
        self.frames = 0
        self.outstanding = 0
        self.max_outstanding = 0
        self.failed = False

    async def control(self, value):
        validate_firmware_block(value, self.block, self.file_index)
        self.queue.put_nowait((True, ack(bytes([self.status, 1, self.mtu, self.window, 1, self.mode]))))

    async def bulk(self, value):
        self.frames += 1
        self.outstanding += 1
        self.max_outstanding = max(self.max_outstanding, self.outstanding)
        if self.failed or self.frames == self.lose:
            return
        self.assert_frame(value)
        if value[1] != (self.last + 1) % self.window:
            self.failed = True
            self.queue.put_nowait((True, ack(b'\x02\x01')))
            return
        self.last = value[1]
        self.received += value[3:]
        self.in_window += 1
        complete = len(self.received) == len(self.block)
        if self.in_window >= self.window or complete:
            self.in_window = 0
            self.outstanding = 0
            if not complete or self.ack_last_window:
                self.queue.put_nowait((False, b'\x78\x00'))
        if complete:
            ok = binascii.crc_hqx(bytes(self.received), 0xffff) == binascii.crc_hqx(self.block, 0xffff)
            self.queue.put_nowait((True, ack(bytes([1 if ok else 0, 1, self.file_index]))))

    def assert_frame(self, value):
        assert value[0] == 0x78 and value[2] == self.file_index and len(value) <= min(self.mtu, 240)

    async def send(self, maximum=244):
        return await send_firmware_block(header(self.block, self.file_index), self.block, self.queue, self.control, self.bulk,
                                         maximum, self.file_index, timeout=2)


class FirmwareBlockTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_window(self):
        for ack_last in (False, True):
            watch = FakeWatch(bytes(range(256)) * 16, ack_last_window=ack_last)
            self.assertFalse(await watch.send())
            self.assertEqual(bytes(watch.received), watch.block)

    async def test_waits_for_each_window(self):
        # A 20-byte link: 241 frames of 17 bytes, acknowledged every 20.
        watch = FakeWatch(bytes(range(256)) * 16, mtu=20, window=20)
        self.assertFalse(await watch.send(244))
        self.assertEqual(bytes(watch.received), watch.block)
        self.assertEqual(watch.max_outstanding, 20)

    async def test_last_block_shorter_than_a_window(self):
        watch = FakeWatch(b'\x5a' * 1000, file_index=81, mtu=100, window=4)
        self.assertFalse(await watch.send())
        self.assertEqual(bytes(watch.received), watch.block)

    async def test_block_already_held(self):
        watch = FakeWatch(b'held' * 1024, status=1)
        self.assertTrue(await watch.send())
        self.assertEqual(watch.frames, 0)

    async def test_watch_without_a_staging_area(self):
        # An ID the watch has no descriptor for is answered "done" with mode 0: never treated as sent.
        watch = FakeWatch(b'nfc' * 100, file_index=9, status=1, mode=0)
        with self.assertRaisesRegex(ProtocolError, "doesn't take"):
            await watch.send()

    async def test_refusals(self):
        block = b'x' * 64
        queue = asyncio.Queue()
        async def refuse(value): queue.put_nowait((True, b'\x78\x00\x02\x02'))
        async def room(value): queue.put_nowait((True, ack(b'\x00\x01\xf0\x1a\x18')))
        async def bulk(value): self.fail('Unexpected data')
        with self.assertRaisesRegex(ProtocolError, r'code 2'):
            await send_firmware_block(header(block), block, queue, refuse, bulk, 244, 9, timeout=1)
        with self.assertRaisesRegex(ProtocolError, 'no room'):
            await send_firmware_block(header(block), block, queue, room, bulk, 244, 9, timeout=1)

    async def test_lost_frame(self):
        watch = FakeWatch(bytes(range(256)) * 16, mtu=20, window=20, lose=5)
        with self.assertRaisesRegex(ProtocolError, 'lost'):
            await watch.send()

    async def test_disconnect(self):
        block = b'x' * 64
        queue = asyncio.Queue()
        async def gone(value): queue.put_nowait(None)
        async def bulk(value): self.fail('Unexpected data')
        with self.assertRaisesRegex(ProtocolError, 'disconnected'):
            await send_firmware_block(header(block), block, queue, gone, bulk, 244, 9, timeout=1)

    def test_validation(self):
        block = bytes(4096)
        validate_firmware_block(header(block, 9, 8192, 8192 + 5000), block, 9)
        for bad_header, bad_block, file_index in [
            (header(block, 86), block, 86),                         # no staging area: never sent
            (header(block, 9, 100, 5000), block, 9),                # not on a 4 KB boundary
            (header(block[:100], 9, 0, 5000), block[:100], 9),      # short block that isn't the last
            (header(block, 9, 0, 0x3000001), block, 9),             # larger than any staging area
        ]:
            with self.assertRaises(ProtocolError):
                validate_firmware_block(bad_header, bad_block, file_index)
        slot = bytearray(header(block)); slot[16] = 1; slot[20] = sum(slot[2:20]) & 255
        with self.assertRaises(ProtocolError):
            validate_firmware_block(bytes(slot), block, 9)
        with self.assertRaises(ProtocolError):
            validate_firmware_block(header(block), bytes(4095) + b'\x01', 9)


if __name__ == '__main__':
    unittest.main()
