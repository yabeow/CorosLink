import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import {
  compareFirmwareVersions, decodeFirmwareCheck, decodeFirmwareCommit, encodeFirmwareBlockHeader, encodeFirmwareCheck, encodeFirmwareCommit,
  FIRMWARE_BLOCK_BYTES, FIRMWARE_MIN_VERSION, FIRMWARE_TEXT, firmwareCrc16, firmwareRefusalMessage, firmwareVersionOf, FirmwareUserError,
  inspectFirmwareFile, nextFirmware, normalizeFirmwareManifest, OTA_OPCODE, planFirmwareFiles, IN_PLACE_TYPES, firmwareStagingBytes, FIRMWARE_QUERY_APP_VERSION, firmwareQueryAppVersion
} from "../dist-electron/corosFirmwareProtocol.js";
import { CorosFirmwareUpdater } from "../dist-electron/corosFirmwareService.js";
import { crc16Ccitt } from "../dist-electron/corosBleRouteProtocol.js";
import { watchSupports } from "../dist-electron/localSync/watchSyncModels.js";

// Watch firmware over Bluetooth (corosFirmwareProtocol.ts, corosFirmwareService.ts), checked
// against the PACE 4 3.2008.0 firmware's OTA (0x94) and SendFile handlers. Runs on the compiled
// modules (npm run build:electron first). With COROSLINK_FIRMWARE_SAMPLES set to a folder holding
// COROS's ota_query.json and the files it lists, the real release is checked too.

let passed = 0;
const test = async (name, body) => { try { await body(); passed += 1; } catch (error) { console.error(`✗ ${name}`); throw error; } };

/** A component as COROS serves it: [HF|DF][type BE][fmt][2][body length][body CRC][header CRC] + body. */
function component(type, length, seed = type) {
  const body = Buffer.alloc(length);
  let value = seed * 2654435761 >>> 0;
  for (let index = 0; index < length; index++) { value = (value * 1103515245 + 12345) >>> 0; body[index] = value >>> 24; }
  const file = Buffer.alloc(16 + length);
  file.write(type === 7 || type === 9 ? "DF" : "HF", 0, "latin1");
  file.writeUInt16BE(type, 2); file[4] = 0x10; file[5] = 0xf1;
  file.writeUInt32LE(length, 8); file.writeUInt16LE(crc16Ccitt(body), 12);
  file.writeUInt16LE(crc16Ccitt(file.subarray(0, 14)), 14);
  body.copy(file, 16);
  return file;
}
const manifestFile = (type, bytes, extra = {}) => ({ type, fileUrl: `https://s3.coros.com/firmware/3.3000.0-1-1/${type}_part.bin`,
  fileHttpUrl: `http://s3.coros.com/firmware/3.3000.0-1-1/${type}_part.bin`, fileSize: bytes.length, fileCRC: crc16Ccitt(bytes),
  fileCRC32: crc32(bytes), force: false, overSizeSkip: 0, timeuse: 5, ...extra });

await test("CRC-16: the table matches the bitwise CCITT-FALSE", () => {
  const data = component(21, 5000);
  assert.equal(firmwareCrc16(data), crc16Ccitt(data));
  assert.equal(firmwareCrc16(Buffer.from("123456789")), 0x29b1);
});

await test("BLEOTA: refusal codes, the component list, malformed replies", () => {
  assert.deepEqual([...encodeFirmwareCheck()], [0]);
  assert.deepEqual(decodeFirmwareCheck(Buffer.from([0x1a])), { ready: false, code: 0x1a });
  assert.match(firmwareRefusalMessage(0x1a), /Unplug the charging cable/);
  assert.match(firmwareRefusalMessage(0x33), /watch face/);
  assert.match(firmwareRefusalMessage(0x16), /activity/);
  assert.equal(firmwareRefusalMessage(0x99), FIRMWARE_TEXT.refusedUnknown, "no codes in what the user reads");
  assert.deepEqual(decodeFirmwareCheck(Buffer.from([1, 2, 0x34, 0x12, 81, 0, 0])),
    { ready: true, components: [{ type: 2, crc: 0x1234 }, { type: 81, crc: 0 }] });
  assert.deepEqual(decodeFirmwareCheck(Buffer.from([1])), { ready: true, components: [] });
  assert.throws(() => decodeFirmwareCheck(Buffer.from([1, 2, 3])));
  assert.throws(() => decodeFirmwareCheck(Buffer.alloc(0)));
});

await test("BLEOTA_GO: [1][length u32][CRC u16][types], and its answer", () => {
  const payload = encodeFirmwareCommit({ length: 8_798_950, crc: 0xbeef }, [2, 81, 102]);
  assert.deepEqual([...payload], [1, 0xe6, 0x42, 0x86, 0x00, 0xef, 0xbe, 2, 81, 102]);
  assert.equal(encodeFirmwareCommit({ length: 1000, crc: 1 }, []).length, 7);
  assert.throws(() => encodeFirmwareCommit({ length: 1000, crc: 1 }, [9]), /Invalid/, "the system image is checked on its own");
  assert.throws(() => encodeFirmwareCommit({ length: 1000, crc: 1 }, [86]), /Invalid/, "no staging area");
  assert.throws(() => encodeFirmwareCommit({ length: 1000, crc: 1 }, [2, 2]), /Invalid/);
  assert.throws(() => encodeFirmwareCommit({ length: 1000, crc: 0x10000 }, []), /Invalid/);
  const many = [0, 1, 2, 11, 16, 17, 19, 21, 23, 43, 44, 45, 47, 48, 50, 52, 81, 91, 92, 94, 95, 96, 102];
  assert.equal(encodeFirmwareCommit({ length: 1000, crc: 1 }, many).length, 7 + many.length);
  assert.throws(() => encodeFirmwareCommit({ length: 1000, crc: 1 }, Array.from({ length: 25 }, (_, index) => index)), /Invalid/, "the watch's answer buffer");
  assert.deepEqual(decodeFirmwareCommit(Buffer.from([1, 0x82, 0xd1]), [2, 81]), { ok: true, failedTypes: [] });
  assert.deepEqual(decodeFirmwareCommit(Buffer.from([0, 0x82, 81]), [2, 81]), { ok: false, failedTypes: [81] });
  assert.deepEqual(decodeFirmwareCommit(Buffer.from([0]), []), { ok: false, failedTypes: [] }, "the system image failed");
  assert.throws(() => decodeFirmwareCommit(Buffer.from([1, 0x83]), [2]));
  assert.throws(() => decodeFirmwareCommit(Buffer.from([1]), [2]));
});

await test("files: header, CRCs and the manifest's checksums", () => {
  const system = component(9, 10_000);
  const expected = { type: 9, size: system.length, crc: crc16Ccitt(system), crc32: crc32(system) };
  assert.deepEqual(inspectFirmwareFile(system, expected), { crc: crc16Ccitt(system) });
  const damaged = Buffer.from(system); damaged[5000] ^= 1;
  assert.throws(() => inspectFirmwareFile(damaged, expected), /damaged/);
  assert.throws(() => inspectFirmwareFile(system.subarray(0, 9000), expected), /incomplete/);
  assert.throws(() => inspectFirmwareFile(component(21, 10_000), { ...expected }), /not the expected component/);
  const hf = Buffer.from(system); hf.write("HF", 0, "latin1"); hf.writeUInt16LE(crc16Ccitt(hf.subarray(0, 14)), 14);
  assert.throws(() => inspectFirmwareFile(hf, { ...expected, crc: crc16Ccitt(hf), crc32: crc32(hf) }), /not the expected component/, "the system image is DF");
  assert.throws(() => inspectFirmwareFile(system, { ...expected, crc32: expected.crc32 ^ 1 }), /doesn't match/);
});

await test("SendFile block headers: 4 KB blocks from 4 KB boundaries, no slot bytes, mode 3", () => {
  const file = component(9, 10_000);
  const block = file.subarray(8192, 8192 + FIRMWARE_BLOCK_BYTES);
  const header = encodeFirmwareBlockHeader(9, block, 8192, file.length);
  assert.equal(header.length, 21);
  assert.deepEqual([...header.subarray(0, 3)], [0x78, 0, 9]);
  assert.equal(header.readUInt32LE(3), 8192);
  assert.equal(header.readUInt16LE(7), block.length);
  assert.equal(header.readUInt32LE(9), file.length - 8192);
  assert.equal(header.readUInt16LE(13), crc16Ccitt(block));
  assert.equal(header[15], block.reduce((sum, byte) => (sum + byte) & 255, 0));
  assert.deepEqual([...header.subarray(16, 20)], [0, 0, 0, 3]);
  assert.equal(header[20], header.subarray(2, 20).reduce((sum, byte) => (sum + byte) & 255, 0));
  assert.throws(() => encodeFirmwareBlockHeader(9, file.subarray(100, 4196), 100, file.length), /Invalid/);
  assert.throws(() => encodeFirmwareBlockHeader(9, file.subarray(0, 100), 0, file.length), /Invalid/, "only the last block is short");
  assert.throws(() => encodeFirmwareBlockHeader(86, file.subarray(0, 4096), 0, file.length), /Invalid/);
  assert.throws(() => encodeFirmwareBlockHeader(97, file.subarray(0, 4096), 0, file.length), /Invalid/, "no PACE 4 staging area");
});

await test("versions", () => {
  assert.equal(firmwareVersionOf("V 3.2008.0"), "3.2008.0");
  assert.equal(firmwareVersionOf("W336-3.1308.0"), "3.1308.0");
  assert.equal(firmwareVersionOf("unknown"), undefined);
  assert.equal(compareFirmwareVersions("3.2008.0", "3.1308.0"), 1);
  assert.equal(compareFirmwareVersions("3.13.0", "3.1308.0"), -1);
  assert.equal(compareFirmwareVersions("3.2008.0", "3.2008.0"), 0);
  assert.equal(FIRMWARE_MIN_VERSION, "3.2008.0", "the release whose update handler was traced");
});

await test("ota/query: releases in order, COROS HTTPS files only, intermediate releases never skipped", () => {
  const system7 = component(7, 3000), system9 = component(9, 4000), font = component(2, 2000);
  const manifest = normalizeFirmwareManifest({
    latestVersion: "3.2008.0", clientProfile: { iosBtTransferSpeed: 25000 },
    batchList: [
      { version: "3.2008.0", content: "- Emoji support (partial).\r\n- Global map support.", date: "2026-09-24 06:36:29",
        files: [manifestFile(9, system9), manifestFile(2, font)] },
      { version: "3.1308.0", content: "3.1308.0", files: [manifestFile(7, system7)] },
      { version: "garbage", files: [] }
    ]
  });
  assert.equal(manifest.latestVersion, "3.2008.0");
  assert.equal(manifest.transferBytesPerSecond, 25000);
  assert.deepEqual(manifest.releases.map(release => release.version), ["3.1308.0", "3.2008.0"]);
  assert.equal(manifest.releases[0].notes, undefined, "a version number isn't notes");
  assert.equal(manifest.releases[1].notes, "- Emoji support (partial).\n- Global map support.");
  assert.deepEqual(manifest.releases[1].files[1], { type: 2, url: "https://s3.coros.com/firmware/3.3000.0-1-1/2_part.bin", size: font.length,
    crc: crc16Ccitt(font), crc32: crc32(font), force: false, installSeconds: 5 });
  assert.deepEqual(nextFirmware(manifest, "3.13.0"), { kind: "release", release: manifest.releases[0], followedBy: "3.2008.0" }, "an intermediate release comes first");
  assert.deepEqual(nextFirmware(manifest, "3.1308.0"), { kind: "release", release: manifest.releases[1] });
  assert.deepEqual(nextFirmware(manifest, "3.2008.0"), { kind: "current" });
  assert.equal(normalizeFirmwareManifest(null).releases.length, 0);

  // An intermediate release CorosLink can't check stops everything after it: never skipped, never "latest".
  for (const bad of [{ fileUrl: "https://example.com/7.bin" }, { fileUrl: "http://s3.coros.com/7.bin" }, { fileSize: "3016" }, { fileSize: 0x3000001 }, { fileCRC: undefined }]) {
    const broken = normalizeFirmwareManifest({ latestVersion: "3.2008.0", batchList: [
      { version: "3.1308.0", files: [{ ...manifestFile(7, system7), ...bad }] },
      { version: "3.2008.0", files: [manifestFile(9, system9)] }
    ] });
    assert.deepEqual(broken.unusableVersions, ["3.1308.0"]);
    assert.deepEqual(nextFirmware(broken, "3.13.0"), { kind: "unavailable", version: "3.2008.0" }, JSON.stringify(bad));
    assert.equal(nextFirmware(broken, "3.1308.0").kind, "release");
  }
  assert.deepEqual(nextFirmware(normalizeFirmwareManifest({ latestVersion: "3.2008.0", batchList: [] }), "3.1308.0"),
    { kind: "unavailable", version: "3.2008.0" }, "COROS names a newer release it doesn't offer here");
});

await test("ota/query: a release newer than the app version asked with, and files without install times", () => {
  // PACE 4 3.2108.0 (2026-11): asked as app 4.10.8, COROS lists only 3.2008.0 and names 4.11.8.
  assert.equal(FIRMWARE_QUERY_APP_VERSION, "4.10.8");
  assert.equal(firmwareQueryAppVersion({ latestVersion: "3.2108.0", appTargetVersion: "4.11.8", batchList: [] }, "4.10.8"), "4.11.8");
  assert.equal(firmwareQueryAppVersion({ appTargetVersion: "4.10.8" }, "4.10.8"), undefined, "not newer: no second query");
  assert.equal(firmwareQueryAppVersion({ appTargetVersion: "4.9.0" }, "4.10.8"), undefined);
  assert.equal(firmwareQueryAppVersion({ appTargetVersion: "latest" }, "4.10.8"), undefined);
  assert.equal(firmwareQueryAppVersion({}, "4.10.8"), undefined);
  assert.equal(firmwareQueryAppVersion(null, "4.10.8"), undefined);
  const release = normalizeFirmwareManifest({ batchList: [{ version: "3.2108.0", files: [
    manifestFile(9, component(9, 100)), manifestFile(2, component(2, 100), { timeuse: undefined }), manifestFile(21, component(21, 100), { timeuse: 0 })
  ] }] }).releases[0];
  assert.deepEqual(release.files.map(file => file.installSeconds), [release.files[0].installSeconds, 30, 0], "missing: 30 s; COROS's 0 stays 0");
});

await test("plan: the system image, what the watch lists with another CRC, parts written in place last", () => {
  const release = normalizeFirmwareManifest({ batchList: [{ version: "3.3000.0", files: [
    manifestFile(9, component(9, 100)), manifestFile(45, component(45, 100)), manifestFile(2, component(2, 100)), manifestFile(21, component(21, 100)),
    manifestFile(86, component(86, 100)), manifestFile(92, component(92, 100)), manifestFile(81, component(81, 100), { force: true })
  ] }] }).releases[0];
  const crcOf = type => release.files.find(file => file.type === type).crc;
  const plan = planFirmwareFiles(release, [
    { type: 2, crc: crcOf(2) },     // unchanged
    { type: 21, crc: 0x1234 },      // older
    { type: 45, crc: 0 },           // missing (written in place)
    { type: 81, crc: crcOf(81) }    // unchanged but forced (written in place)
  ]);
  assert.equal(plan.system.type, 9);
  assert.deepEqual(plan.files.map(file => file.type), [9, 21, 45, 81], "92 (another voice language) isn't listed by the watch");
  assert.throws(() => planFirmwareFiles({ ...release, files: release.files.filter(file => file.type !== 9) }, []),
    error => error instanceof FirmwareUserError && error.message === FIRMWARE_TEXT.cantInstall);
  assert.throws(() => planFirmwareFiles(release, [{ type: 86, crc: 1 }]),
    error => error instanceof FirmwareUserError && error.message === FIRMWARE_TEXT.cantInstall, "a listed part CorosLink can't send: the COROS app's job");
  const sizeOf = type => release.files.find(file => file.type === type).size;
  const staging = new Map([[9, sizeOf(9)], [21, sizeOf(21)], [45, sizeOf(45)], [81, sizeOf(81) - 1]]);
  assert.throws(() => planFirmwareFiles(release, [{ type: 21, crc: 0x1234 }, { type: 81, crc: crcOf(81) }], staging),
    error => error instanceof FirmwareUserError && error.message === FIRMWARE_TEXT.cantInstall, "a file larger than its staging area: refused before anything is sent");
  assert.deepEqual(planFirmwareFiles(release, [{ type: 21, crc: 0x1234 }], staging).files.map(file => file.type), [9, 21], "the others fit");
  assert.throws(() => planFirmwareFiles(release, [{ type: 2, crc: 1 }], staging), FirmwareUserError, "no known staging area: refused");
  const w336 = firmwareStagingBytes("COROS W336");
  assert.equal(w336.get(9), 0x1700000);
  assert.equal(w336.get(81), 0x40000);
  assert.equal(firmwareStagingBytes("COROS W337"), undefined);
});

await test("models: the PACE 4 only", () => {
  assert.ok(watchSupports("firmware", "pace-4"));
  for (const model of ["pace-4-pro", "pace-pro", "apex-4", "pace-3", "vertix-2", undefined]) assert.ok(!watchSupports("firmware", model), String(model));
});

// ----- the update, end to end, against a fake watch and a fake COROS -----

const SYSTEM = component(9, 3 * FIRMWARE_BLOCK_BYTES + 123, 1);
const FONT = component(2, FIRMWARE_BLOCK_BYTES - 16, 2);
const LANGUAGE = component(21, 5000, 3);
const GPS = component(45, 6000, 5);
const OTA_DATA = { latestVersion: "3.3000.0", batchList: [{ version: "3.3000.0", content: "- Notes", files: [
  manifestFile(9, SYSTEM), manifestFile(45, GPS, { timeuse: 7 }), manifestFile(2, FONT), manifestFile(21, LANGUAGE), manifestFile(86, component(86, 10))
] }] };
const FILES = new Map([[9, SYSTEM], [2, FONT], [21, LANGUAGE], [45, GPS]]);

class FakeWatch {
  constructor({ version = "3.2008.0", identity = "SERIAL-1", installed = { 2: crc16Ccitt(FONT), 21: 0x4242, 45: 0x1111 }, refusals = [], battery = 80, heldBlocks = 0 } = {}) {
    Object.assign(this, { version, identity, installed, refusals, battery, heldBlocks });
    this.staged = new Map(); this.blocks = []; this.commits = []; this.resets = 0; this.restarted = false; this.exchanges = [];
    this.link = {
      watch: async () => this.current(),
      current: () => this.current(),
      battery: async () => this.battery,
      exchange: async (opcode, payload, timeoutSeconds) => this.exchange(opcode, payload, timeoutSeconds),
      sendBlock: async (type, header, block) => this.block(type, header, block),
      reset: async () => { this.resets += 1; },
      restarting: () => { this.restarted = true; }
    };
  }
  current() {
    if (this.disconnected) throw new Error("The watch is not connected.");
    return { firmwareType: "COROS W336", version: this.version, identity: this.identity };
  }
  async exchange(opcode, payload, timeoutSeconds) {
    assert.equal(opcode, OTA_OPCODE);
    assert.ok(timeoutSeconds >= 30, "BLEOTA and BLEOTA_GO read storage; the default 15 s may not do");
    this.exchanges.push(payload[0]);
    if (payload[0] === 0) {
      const refusal = this.refusals.shift();
      if (refusal) return Buffer.from([refusal]);
      return Buffer.from([1, ...Object.entries(this.installed).flatMap(([type, crc]) => [Number(type), crc & 255, crc >> 8])]);
    }
    assert.equal(payload[0], 1);
    const length = payload.readUInt32LE(1), crc = payload.readUInt16LE(5), types = [...payload.subarray(7)];
    this.commits.push({ length, crc, types });
    if (this.loseCommitAnswer) throw new Error("The watch disconnected.");
    const system = this.staged.get(9) ?? Buffer.alloc(0);
    const systemOk = system.length === length && crc16Ccitt(system) === crc;
    const results = types.map(type => { const staged = this.staged.get(type); return staged?.equals(FILES.get(type)) ? type | 0x80 : type; });
    return Buffer.from([systemOk && results.every(value => value & 0x80) ? 1 : 0, ...results]);
  }
  async block(type, header, block) {
    // What the firmware's SendFile handler checks.
    assert.deepEqual([...header.subarray(0, 3)], [0x78, 0, type]);
    const offset = header.readUInt32LE(3), remaining = header.readUInt32LE(9);
    assert.equal(offset % FIRMWARE_BLOCK_BYTES, 0);
    assert.equal(header.readUInt16LE(7), block.length);
    assert.equal(header.readUInt16LE(13), crc16Ccitt(block));
    assert.deepEqual([...header.subarray(16, 20)], [0, 0, 0, 3]);
    if (this.failBlock?.(type, offset)) throw new Error("The watch did not acknowledge the firmware data.");
    const staged = this.staged.get(type) ?? Buffer.alloc(offset + remaining);
    block.copy(staged, offset);
    this.staged.set(type, staged);
    this.blocks.push([type, offset]);
    // Written in place, the copy BLEOTA reports is the one being written (0 for Wi-Fi, whose record doesn't take FF FF).
    if (IN_PLACE_TYPES.has(type)) this.installed[type] = this.inPlaceCrc?.(type, staged) ?? (type === 48 ? 0 : crc16Ccitt(staged));
    this.onBlock?.(type, offset);
    return this.blocks.length <= this.heldBlocks;
  }
}

function fakeCoros(requests = []) {
  return async (url, options) => {
    requests.push({ url, redirect: options?.redirect });
    const type = Number(/\/(\d+)_part\.bin$/.exec(url)?.[1]);
    if (options?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return new Response(FILES.get(type));
  };
}

function updater(watch, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coroslink-firmware-"));
  const clock = { now: 1_000_000 };
  const requests = [], logs = [], waits = [];
  const store = extra.store ?? { value: undefined, load() { return this.value; }, save(value) { this.value = value; } };
  const instance = new CorosFirmwareUpdater({ link: watch.link, manifest: async (firmwareType, version) => {
    assert.equal(firmwareType, "COROS W336");
    assert.equal(version, watch.version);
    if (extra.manifestError) throw extra.manifestError;
    return extra.data ?? OTA_DATA;
  }, directory: () => directory, fetch: extra.fetch ?? fakeCoros(requests), now: () => clock.now, pending: store,
  log: (event, detail) => logs.push([event, detail]), wait: async ms => { waits.push(ms); clock.now += ms; } });
  return { instance, directory, requests, logs, store, clock, waits, advance: ms => { clock.now += ms; } };
}

await test("update: check, download only what differs, send (in-place parts last), commit, restart, then the new version", async () => {
  const watch = new FakeWatch();
  const { instance, directory, requests, store, logs, advance } = updater(watch);
  const check = await instance.check();
  assert.equal(check.currentVersion, "3.2008.0");
  assert.equal(check.update.version, "3.3000.0");
  assert.equal(check.update.notes, "- Notes");
  assert.equal(check.update.bytes, SYSTEM.length + LANGUAGE.length + GPS.length, "system, language and GPS; the font is current, 86 has no staging area");
  assert.equal(check.update.transferSeconds, Math.ceil(check.update.bytes / 20000));
  assert.equal(check.update.installSeconds, 5 + 5 + 7 + 60, "COROS's estimate plus the restart");
  assert.equal(watch.blocks.length, 0, "a check sends nothing");
  assert.deepEqual(instance.offered(check.id), { version: "3.3000.0", transferSeconds: check.update.transferSeconds, installSeconds: check.update.installSeconds });

  const status = await instance.install(check.id);
  assert.equal(status.phase, "installing");
  assert.equal(status.version, "3.3000.0");
  assert.equal(status.fromVersion, "3.2008.0");
  assert.equal(status.installSeconds, 77);
  assert.ok(status.committedAt);
  assert.deepEqual(requests.map(entry => /\/(\d+)_part/.exec(entry.url)[1]).sort(), ["21", "45", "9"]);
  assert.ok(requests.every(entry => entry.redirect === "error"), "a redirect away from COROS is refused");
  assert.deepEqual(watch.blocks.map(([type]) => type), [9, 9, 9, 9, 21, 21, 45, 45], "the system image first, GPS (written in place) last");
  assert.deepEqual(watch.commits, [{ length: SYSTEM.length, crc: crc16Ccitt(SYSTEM), types: [21, 45] }]);
  assert.deepEqual(watch.exchanges, [0, 0, 0, 0, 1], "BLEOTA at the check, before downloading, before sending and before the commit");
  assert.ok(watch.restarted);
  assert.equal(watch.resets, 0);
  assert.equal(store.value.version, "3.3000.0", "kept across restarts of CorosLink");
  assert.ok(!fs.existsSync(path.join(directory, "COROS-W336", "3.3000.0")), "the downloads go once the watch has them");
  assert.ok(logs.some(([event, detail]) => event === "commit" && detail.ok === true), "the commit is in the diagnostics");
  assert.ok(!JSON.stringify(logs).includes("SERIAL-1"), "never the serial number");
  await assert.rejects(instance.check(), error => error.message === FIRMWARE_TEXT.installing, "nothing new while it installs");

  watch.version = "3.2008.0";
  instance.observe(watch.current());
  assert.equal(instance.updateStatus().phase, "installing", "seen too soon after the commit to judge");
  instance.observe({ ...watch.current(), identity: "OTHER", version: "3.3000.0" });
  assert.equal(instance.updateStatus().phase, "installing", "another watch says nothing");
  watch.version = "3.3000.0";
  instance.observe(watch.current());
  assert.equal(instance.updateStatus().phase, "complete");
  assert.equal(store.value, undefined);
  advance(1);
});

await test("update: an install pending when CorosLink restarts is still settled when the watch comes back", async () => {
  const watch = new FakeWatch();
  const first = updater(watch);
  await first.instance.install((await first.instance.check()).id);
  const reopened = updater(watch, { store: first.store });
  assert.equal(reopened.instance.updateStatus().phase, "installing", "read back at start");
  assert.equal(reopened.instance.updateStatus().version, "3.3000.0");
  watch.version = "3.3000.0";
  const check = await reopened.instance.check();
  assert.equal(reopened.instance.updateStatus().phase, "complete", "connecting for the check settled it");
  assert.equal(check.update, undefined);
  assert.equal(first.store.value, undefined);
});

await test("update: a watch back on its old version didn't install it", async () => {
  const watch = new FakeWatch();
  const { instance, advance } = updater(watch);
  await instance.install((await instance.check()).id);
  advance(120_000);
  instance.observe(watch.current());
  assert.equal(instance.updateStatus().phase, "failed");
  assert.equal(instance.updateStatus().error, FIRMWARE_TEXT.notInstalled);
});

await test("update: a commit whose answer is lost counts as installing, and a later check settles it", async () => {
  const watch = new FakeWatch();
  watch.loseCommitAnswer = true;
  const { instance } = updater(watch);
  const status = await instance.install((await instance.check()).id);
  assert.equal(status.phase, "installing", "the watch may well be installing");
  assert.ok(watch.restarted);
  await assert.rejects(instance.install("anything"), /Wait|Check for updates|installing/);
  watch.version = "3.3000.0";
  const check = await instance.check();
  assert.equal(check.update, undefined, "back on the new version: nothing to install");
  assert.equal(instance.updateStatus().phase, "complete", "settled when the check connected");
  await instance.check();
  assert.equal(instance.updateStatus().phase, "idle", "the next check starts clean");
});

await test("update: older firmware, up to date, and a release CorosLink can't install", async () => {
  const older = new FakeWatch({ version: "3.1308.0" });
  const first = updater(older, { data: { ...OTA_DATA, latestVersion: "3.3000.0" } });
  const check = await first.instance.check();
  assert.deepEqual(check.unavailable, { version: "3.3000.0" }, "the COROS app updates firmware older than the traced handler");
  assert.equal(check.update, undefined);
  assert.deepEqual(older.exchanges, [], "nothing asked of the watch");
  await assert.rejects(first.instance.install(check.id), error => error.message === FIRMWARE_TEXT.checkAgain);

  const current = new FakeWatch({ version: "3.3000.0" });
  const second = updater(current);
  const latest = await second.instance.check();
  assert.equal(latest.update, undefined);
  assert.equal(latest.unavailable, undefined);
  assert.deepEqual(current.exchanges, []);

  const unknown = new FakeWatch({ installed: { 2: crc16Ccitt(FONT), 86: 1 } });
  const third = updater(unknown);
  assert.deepEqual((await third.instance.check()).unavailable, { version: "3.3000.0" }, "a listed part CorosLink can't send");
});

await test("update: refusals at the check, the battery floor, and before sending", async () => {
  const charging = new FakeWatch({ refusals: [0x1a, 0x1a] });
  const first = updater(charging);
  const blocked = await first.instance.check();
  assert.equal(blocked.update.version, "3.3000.0");
  assert.equal(blocked.blocked, firmwareRefusalMessage(0x1a));
  assert.equal(blocked.update.bytes, undefined);
  await assert.rejects(first.instance.install(blocked.id), error => error.message === firmwareRefusalMessage(0x1a));
  assert.equal(charging.blocks.length, 0);
  assert.equal(first.instance.updateStatus().phase, "failed");

  const low = new FakeWatch({ battery: 29 });
  const second = updater(low);
  assert.equal((await second.instance.check()).blocked, FIRMWARE_TEXT.lowBattery);
  assert.deepEqual(low.exchanges, [], "the battery is checked first");

  const busy = new FakeWatch({ refusals: [undefined, undefined, 0x16] });
  const third = updater(busy);
  await assert.rejects(third.instance.install((await third.instance.check()).id), /Finish the activity/);
  assert.equal(busy.blocks.length, 0);
  assert.equal(busy.resets, 0, "no transfer was open");
});

await test("update: the watch's downloading screen after the last block is waited out before the commit", async () => {
  // A PACE 4 shows it for about 30 s after a transfer and answers "not on the watch face" (0x33) until it closes.
  const watch = new FakeWatch({ refusals: [undefined, undefined, undefined, 0x33, 0x33, 0x33] });
  const { instance, waits, logs } = updater(watch);
  const status = await instance.install((await instance.check()).id);
  assert.equal(status.phase, "installing");
  assert.equal(watch.commits.length, 1);
  assert.deepEqual(waits, [3000, 3000, 3000]);
  assert.ok(logs.some(([event, detail]) => event === "waiting for the downloading screen" && detail.step === "commit"));

  const stuck = new FakeWatch({ refusals: [undefined, undefined, undefined, ...Array(40).fill(0x33)] });
  const second = updater(stuck);
  const check = await second.instance.check();
  await assert.rejects(second.instance.install(check.id), error => error.message === firmwareRefusalMessage(0x33));
  assert.equal(stuck.commits.length, 0, "never committed while the watch says it can't");
  assert.equal(second.waits.reduce((sum, ms) => sum + ms, 0), 90_000, "waited out for at most 90 s");
  assert.equal(second.instance.updateStatus().staged, true);
  stuck.refusals = [];
  assert.equal((await second.instance.install(check.id)).phase, "installing", "the next try only commits");

  const menu = new FakeWatch({ refusals: [0x33] });
  const third = updater(menu);
  assert.equal((await third.instance.check()).blocked, firmwareRefusalMessage(0x33), "without a recent transfer it's the user's menu: no wait");
  assert.deepEqual(third.waits, []);
});

await test("update: parts written in place must read back as sent before the commit", async () => {
  const watch = new FakeWatch();
  watch.inPlaceCrc = (type, staged) => type === 45 ? 0x9999 : crc16Ccitt(staged);
  const { instance, logs } = updater(watch);
  const check = await instance.check();
  await assert.rejects(instance.install(check.id), error => error.message === FIRMWARE_TEXT.watchDeclined);
  assert.equal(watch.commits.length, 0, "never installed when the watch reads back something else");
  assert.ok(logs.some(([event, detail]) => event === "in place not as sent" && detail.types[0][0] === 45));
  assert.equal(instance.updateStatus().staged, undefined, "the next try sends again");
  watch.inPlaceCrc = undefined;
  const sent = watch.blocks.length;
  assert.equal((await instance.install(check.id)).phase, "installing");
  assert.ok(watch.blocks.length > sent, "sent again, then installed");

  const unknown = new FakeWatch();
  unknown.inPlaceCrc = () => 0;
  const second = updater(unknown);
  assert.equal((await second.instance.install((await second.instance.check()).id)).phase, "installing", "0 (Wi-Fi's record) says nothing either way");
  assert.ok(second.logs.some(([event, detail]) => event === "in place unverified" && detail.types.includes(45)));
});

await test("update: not ready right before the commit keeps what was sent; the next try only commits", async () => {
  const watch = new FakeWatch({ refusals: [undefined, undefined, undefined, 0x16] });
  const { instance, requests } = updater(watch);
  const check = await instance.check();
  await assert.rejects(instance.install(check.id), /Finish the activity/);
  assert.equal(watch.commits.length, 0, "never committed during an activity");
  assert.equal(instance.updateStatus().staged, true);
  assert.equal(instance.updateStatus().phase, "failed");
  assert.equal(instance.updateStatus().partial, true, "the GPS firmware was written in place");
  const sent = watch.blocks.length, downloads = requests.length;
  watch.battery = 20;
  await assert.rejects(instance.install(check.id), error => error.message === FIRMWARE_TEXT.lowBattery, "the battery is checked again before the commit");
  watch.battery = 60;
  const status = await instance.install(check.id);
  assert.equal(status.phase, "installing");
  assert.equal(watch.blocks.length, sent, "nothing sent again");
  assert.equal(requests.length, downloads, "nothing downloaded again");
  assert.equal(watch.commits.length, 1);
});

await test("update: another watch connected mid-update gets nothing", async () => {
  const watch = new FakeWatch();
  const { instance } = updater(watch);
  watch.onBlock = (type, offset) => { if (type === 9 && offset === FIRMWARE_BLOCK_BYTES) watch.identity = "WATCH-B"; };
  await assert.rejects(instance.install((await instance.check()).id), error => error.message === FIRMWARE_TEXT.watchChanged);
  assert.equal(watch.blocks.length, 2, "stopped at the next block");
  assert.equal(watch.commits.length, 0);
  assert.equal(instance.updateStatus().checkAgain, true);
  assert.equal(watch.resets, 1);
});

await test("update: cancelled partway ends the transfer; parts written in place are reported; trying again reuses the downloads", async () => {
  const watch = new FakeWatch();
  const { instance, requests } = updater(watch);
  const check = await instance.check();
  watch.onBlock = (type, offset) => { if (type === 9 && offset === FIRMWARE_BLOCK_BYTES) instance.cancel(); };
  const status = await instance.install(check.id);
  assert.equal(status.phase, "cancelled");
  assert.equal(status.error, undefined);
  assert.equal(status.partial, undefined, "only the staged system image was touched");
  assert.equal(watch.resets, 1, "the half-sent file is ended by closing the link");
  assert.equal(watch.commits.length, 0);
  watch.onBlock = (type) => { if (type === 45) instance.cancel(); };
  const stopped = await instance.install(check.id);
  assert.equal(stopped.phase, "cancelled");
  assert.equal(stopped.partial, true, "the GPS firmware is half written: the user is told to finish");
  watch.onBlock = undefined;
  const downloads = requests.length;
  const again = await instance.install(check.id);
  assert.equal(again.phase, "installing");
  assert.equal(requests.length, downloads, "checked copies in the cache are used");
});

await test("update: Cancel does nothing once the watch is being told to install", async () => {
  const watch = new FakeWatch();
  const { instance } = updater(watch);
  const exchange = watch.link.exchange;
  watch.link.exchange = async (opcode, payload, timeout) => {
    if (payload[0] === 1) {
      assert.equal(instance.updateStatus().phase, "committing");
      instance.cancel();
    }
    return exchange(opcode, payload, timeout);
  };
  assert.equal((await instance.install((await instance.check()).id)).phase, "installing");
});

await test("update: errors the user reads carry no codes or jargon; the details go to diagnostics", async () => {
  const dropped = new FakeWatch();
  dropped.failBlock = (type, offset) => type === 9 && offset === FIRMWARE_BLOCK_BYTES;
  const first = updater(dropped);
  await assert.rejects(first.instance.install((await first.instance.check()).id), error => error.message === FIRMWARE_TEXT.linkDropped);
  assert.equal(first.instance.updateStatus().error, FIRMWARE_TEXT.linkDropped);
  assert.ok(first.logs.some(([event, detail]) => event.startsWith("block 9@4096") && /acknowledge/.test(detail.error)));

  const offline = updater(new FakeWatch(), { manifestError: new TypeError("fetch failed") });
  await assert.rejects(offline.instance.check(), error => error.message === FIRMWARE_TEXT.corosUnreachable);
  const signedOut = updater(new FakeWatch(), { manifestError: new Error("Sign in to your COROS mobile account to continue.") });
  await assert.rejects(signedOut.instance.check(), error => error.message === FIRMWARE_TEXT.signIn);

  const broken = new FakeWatch();
  const third = updater(broken, { fetch: async url => {
    const type = Number(/\/(\d+)_part\.bin$/.exec(url)[1]);
    const bytes = Buffer.from(FILES.get(type)); bytes[bytes.length - 1] ^= 0xff;
    return new Response(bytes);
  } });
  await assert.rejects(third.instance.install((await third.instance.check()).id), error => error.message === FIRMWARE_TEXT.download);
  assert.equal(broken.blocks.length, 0, "a damaged download is never sent");
  const missing = updater(new FakeWatch(), { fetch: async () => new Response("no", { status: 404 }) });
  await assert.rejects(missing.instance.install((await missing.instance.check()).id), error => error.message === FIRMWARE_TEXT.download);
});

await test("update: blocks the watch already holds count as sent; a commit the watch rejects restarts nothing", async () => {
  const watch = new FakeWatch({ heldBlocks: 2 });
  const { instance } = updater(watch);
  const status = await instance.install((await instance.check()).id);
  assert.equal(status.phase, "installing");
  assert.equal(status.sentBytes, status.totalBytes);

  const rejecting = new FakeWatch();
  rejecting.block = async function (type) { this.blocks.push([type]); return false; }; // nothing staged
  const second = updater(rejecting);
  await assert.rejects(second.instance.install((await second.instance.check()).id), error => error.message === FIRMWARE_TEXT.watchDeclined);
  assert.ok(!rejecting.restarted);
  assert.equal(second.instance.updateStatus().phase, "failed");
  assert.equal(second.store.value, undefined, "nothing pending");
});

// The release COROS served for the PACE 4 (W336) on 2026-10-17, when samples are at hand.
const samples = process.env.COROSLINK_FIRMWARE_SAMPLES;
if (samples) {
  await test("samples: COROS's own manifest and files", () => {
    const data = JSON.parse(fs.readFileSync(path.join(samples, "ota_query.json"), "utf8")).data;
    const manifest = normalizeFirmwareManifest(data);
    const release = manifest.releases.find(entry => entry.version === "3.2008.0");
    assert.ok(release, "3.2008.0 is offered");
    assert.deepEqual(manifest.unusableVersions, []);
    assert.equal(nextFirmware(manifest, "3.13.0").release.version, "3.1308.0");
    let checked = 0;
    for (const file of release.files) {
      const filename = path.join(samples, path.basename(new URL(file.url).pathname));
      if (!fs.existsSync(filename)) continue;
      inspectFirmwareFile(fs.readFileSync(filename), file);
      checked += 1;
    }
    assert.ok(checked > 0, "no sample files found");
    const staging = firmwareStagingBytes("COROS W336");
    for (const file of release.files) if (file.type !== 86) assert.ok(file.size <= staging.get(file.type), `type ${file.type} fits its staging area`);
    const plan = planFirmwareFiles(release, release.files.filter(file => file.type !== 9 && file.type !== 86).map(file => ({ type: file.type, crc: file.crc })));
    assert.deepEqual(plan.files.map(file => file.type), [9], "an installed release needs only the system image");
  });
}

console.log(`Watch firmware: ${passed} checks passed${samples ? " (with COROS samples)" : ""}.`);
