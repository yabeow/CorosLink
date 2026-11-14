import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fixtureFace } from './test-coros-watchface-ble.mjs';
if (process.platform !== 'darwin') { console.log('Swift CoreBluetooth protocol checks require macOS.'); process.exit(0); }
const require = createRequire(path.resolve('dist-electron/corosBleWatchfaceProtocol.js'));
const { encodeWatchfaceFile, encodeWatchfaceBlockHeader } = require('./corosBleWatchfaceProtocol.js');
const { encodeMusicDeleteFile, encodeMusicDeleteHeader } = require('./corosBleMusicProtocol.js');
const { encodeFirmwareBlockHeader } = require('./corosFirmwareProtocol.js');
const source = await fs.readFile('native/corebluetooth/main.swift', 'utf8');
const functions = source.slice(source.indexOf('func decodeWatchInteraction('), source.indexOf('\nlet worker = BluetoothWorker()'));
assert.ok(functions.startsWith('func decodeWatchInteraction('));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coros-swift-protocol-'));
try {
  const file = encodeWatchfaceFile(fixtureFace()).file;
  const block = file.subarray(0, 4096);
  const header = encodeWatchfaceBlockHeader(block, 0, file.length, 1);
  const musicFile = encodeMusicDeleteFile({name:'Café.mp3',watchPath:'/emmc2:/Music/Café.mp3',sizeBytes:1234,watchId:42});
  const musicHeader = encodeMusicDeleteHeader(musicFile);
  // A firmware file's middle and last blocks, as corosFirmwareService.ts sends them.
  const firmware = Buffer.alloc(3 * 4096 + 700, 0);
  for (let index = 0; index < firmware.length; index++) firmware[index] = (index * 31 + 7) & 255;
  const firmwareMiddle = firmware.subarray(4096, 8192), firmwareLast = firmware.subarray(3 * 4096);
  const firmwareMiddleHeader = encodeFirmwareBlockHeader(9, firmwareMiddle, 4096, firmware.length);
  const firmwareLastHeader = encodeFirmwareBlockHeader(81, firmwareLast, 3 * 4096, firmware.length);
  const swift = `import Foundation\n${functions}\n
func expect(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
let block = Data([${[...block]}])
let header = Data([${[...header]}])
expect(validFileBlock(header, block, 8), "accept valid watch face block")
expect(!validFileBlock(header, block, 0x14), "reject wrong transfer type")
var bad = header; bad[16] = 10
expect(!validFileBlock(bad, block, 8), "reject invalid slot")
bad = header; bad[20] ^= 1
expect(!validFileBlock(bad, block, 8), "reject invalid header sum")
var badBlock = block; badBlock[0] ^= 1
expect(!validFileBlock(header, badBlock, 8), "reject corrupted body")
let musicFile = Data([${[...musicFile]}]), musicHeader = Data([${[...musicHeader]}])
expect(validFileBlock(musicHeader, musicFile, 93), "accept one local MP3 deletion")
expect(!validFileBlock(musicHeader, musicFile, 8), "delete cannot write watch faces")
var badMusicHeader=musicHeader;badMusicHeader[16]=1
expect(!validFileBlock(badMusicHeader,musicFile,93), "delete cannot target another storage category")
var badMusic=musicFile;badMusic[19]=1
expect(!validMusicDeleteFile(badMusic), "reject non-music HS category")
badMusic=musicFile;badMusic[48]=18
expect(!validMusicDeleteFile(badMusic), "reject malformed delete protobuf")
expect(!validMusicDeleteFile(Data(repeating:0,count:513)), "bounded delete file")
let deletion=CorosMusicDeleteReceiver()
try deletion.acceptStorage(Data([0xc1,0,1,1,0,1,3]))
expect(deletion.result==nil,"storage response alone cannot complete deletion")
deletion.fileAcknowledged=true
expect(deletion.result==Data([1,1,0,1]),"wait for both acknowledgements in either order")
let fragmented=CorosMusicDeleteReceiver();fragmented.fileAcknowledged=true
try fragmented.acceptStorage(Data([0xc1,1,1,1]));expect(fragmented.result==nil,"wait for complete storage response")
try fragmented.acceptStorage(Data([0xc1,0,0,1,3]));expect(fragmented.result==Data([1,1,0,1]),"fragmented storage checksum")
for frame: [UInt8] in [[0xc1,0,1,1,0,1,4],[0xc1,0,1,1,1,1,4],[0xc1,0,1,1,0],[0xc1,0,1,1,0,1,3,0]] {
 do {try CorosMusicDeleteReceiver().acceptStorage(Data(frame));fatalError("accepted invalid storage response")}catch CorosMusicReadError.invalid {}
}
let firmwareMiddle = Data([${[...firmwareMiddle]}]), firmwareMiddleHeader = Data([${[...firmwareMiddleHeader]}])
let firmwareLast = Data([${[...firmwareLast]}]), firmwareLastHeader = Data([${[...firmwareLastHeader]}])
expect(validFirmwareBlock(firmwareMiddleHeader, firmwareMiddle, 9), "accept a firmware block")
expect(validFirmwareBlock(firmwareLastHeader, firmwareLast, 81), "accept a firmware file's short last block")
expect(!validFirmwareBlock(firmwareMiddleHeader, firmwareMiddle, 81), "a firmware block goes to its own type")
expect(!validFileBlock(firmwareMiddleHeader, firmwareMiddle, 9), "firmware goes only through firmwareBlock")
var badFirmware = firmwareMiddleHeader; badFirmware[16] = 1; badFirmware[20] &+= 1
expect(!validFirmwareBlock(badFirmware, firmwareMiddle, 9), "no slot byte on a firmware block")
badFirmware = firmwareMiddleHeader; badFirmware[3] = 1; badFirmware[20] &+= 1
expect(!validFirmwareBlock(badFirmware, firmwareMiddle, 9), "firmware blocks start on 4 KB boundaries")
expect(!validFirmwareBlock(firmwareLastHeader, firmwareLast.prefix(600), 81), "the block is as long as the header says")
var badFirmwareBlock = firmwareMiddle; badFirmwareBlock[100] ^= 1
expect(!validFirmwareBlock(firmwareMiddleHeader, badFirmwareBlock, 9), "reject a corrupted firmware block")
badFirmware = firmwareMiddleHeader; badFirmware[2] = 86; badFirmware[20] &+= 77
expect(!validFirmwareBlock(badFirmware, firmwareMiddle, 86), "no firmware type without a staging area")
let call = decodeWatchInteraction(Data([2,0,2,2]))
expect(call?["kind"] as? String == "call-rejected", "decode call reject")
let media = decodeWatchInteraction(Data([0xc5,0,2,1,3]))
expect(media?["kind"] as? String == "media-control" && media?["action"] as? Int == 2 && media?["value"] as? Int == 1, "decode media")
for frame: [UInt8] in [[], [0xc5], [0xc5,0,2], [0xc5,0,2,1,4], [0xc5,1,2,1,3], [0xc5,0,8,1,9], [0xa5,0,2,1,3], [0x79,0,2,1,3], [2,0,1,1]] {
  expect(decodeWatchInteraction(Data(frame)) == nil, "ignore unsupported/corrupt/fragmented events")
}
expect(decodeUsbAccess(Data([0x0d,0,0x11,1,0,0x12])) == "usb-access-request", "decode USB access request")
expect(decodeUsbAccess(Data([0x0d,0,0x11,1,1,0x13])) == "usb-access-closed", "decode USB access prompt closed")
for frame: [UInt8] in [[0x0d,0,0x11,1,0,0x13], [0x0d,1,0x11,1,0,0x12], [0x0d,0,0x11,1,2,0x14], [0x0d,0,0x12,1,0,0x13], [0x0e,0,0x11,1,0,0x12], [0x0d,0,0x11,1,0]] {
  expect(decodeUsbAccess(Data(frame)) == nil, "ignore other or corrupt USB access frames")
}
print("CoreBluetooth file validation, firmware blocks, bounded music deletion, both acknowledgement orders, storage framing, watch interaction and USB access decoders passed.")
`;
  const filename = path.join(directory, 'protocol.swift');
  await fs.writeFile(filename, swift);
  console.log(execFileSync('/usr/bin/swift', [filename], { encoding: 'utf8', timeout: 60000 }).trim());
} finally { await fs.rm(directory, { recursive: true, force: true }); }
