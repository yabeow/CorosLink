import { crc32 } from "node:zlib";
import { firmwareVersionOf } from "./corosFirmwareTypes";

export { firmwareVersionOf };

/**
 * Watch firmware over Bluetooth, as the PACE 4 (W336) 3.2008.0 firmware takes it. The
 * firmware running on the watch handles the update, so only watches already on that
 * version (FIRMWARE_MIN_VERSION) are updated; older builds have another OTA module.
 *
 * 1. OTA (0x94) subcommand 0, BLEOTA: the watch checks it can update now and lists
 *    each installed component as [type, CRC-16 LE]. The CRC is CRC-16/CCITT-FALSE over
 *    the whole file, header included, which is the update manifest's `fileCRC`; 0 means
 *    the component is missing or unreadable. The system image is never listed.
 *    A watch that can't update now answers one status byte (FIRMWARE_REFUSALS).
 * 2. SendFile (0x78), file ID = the component's type, 4 KB blocks, extra bytes 0: each
 *    type has a fixed staging area. The watch writes FF FF over the HF/DF magic while
 *    staging and checks block CRCs as if it were there, so files go as COROS serves them.
 *    A block the area already holds is answered "done" without its data.
 * 3. OTA subcommand 1, BLEOTA_GO: [1][system length u32][system CRC u16][types…]. The
 *    watch checks the staged system image's length and CRC and every listed type's header
 *    and CRCs, answers [ok][type | ok << 7 …], and when all pass writes the HF/DF magics
 *    and restarts. Its bootloader verifies the RSA signature before installing anything.
 */

/** The oldest firmware whose update handler was traced. */
export const FIRMWARE_MIN_VERSION = "3.2008.0";
export const OTA_OPCODE = 0x94;
const OTA_CHECK = 0;
const OTA_COMMIT = 1;
export const FIRMWARE_BLOCK_BYTES = 4096;
/** The system image: type 7 in 3.13 builds, 9 since (one staging area). Its staging area is checked on every commit. */
export const SYSTEM_IMAGE_TYPES: ReadonlySet<number> = new Set([7, 9]);
/**
 * Types an update carries that the watch stages over SendFile: the types in BLEOTA's
 * list that have a staging area, plus the system image. Others, such as the NFC
 * firmware (86), have no staging area and are never sent.
 */
export const FIRMWARE_FILE_TYPES: ReadonlySet<number> = new Set([0, 1, 2, 7, 9, 11, 16, 17, 19, 21, 23, 43, 44, 45, 47, 48, 50, 52, 81, 91, 92, 94, 95, 96, 102]);
/**
 * Types staged over the copy the watch uses: GPS (19, 45) and Wi-Fi (48) firmware, the
 * stored bootloader and recovery images (81, 102) and the voice files (91, 92, 95, 96).
 * Until a commit finishes them, a transfer that stopped partway leaves them broken, so
 * they are sent last.
 */
export const IN_PLACE_TYPES: ReadonlySet<number> = new Set([19, 45, 48, 81, 91, 92, 95, 96, 102]);
/** The largest staging area (type 2's is 45 MB); the watch checks each type's own. */
export const FIRMWARE_FILE_LIMIT = 0x3000000;
/**
 * Each component's staging area on a PACE 4 running 3.2008.0 (descriptor table 0x65b848). The watch
 * refuses a file larger than its area at that file's first block; checking before anything is sent
 * keeps an update from stopping after it has written parts in place. Later firmware may have larger
 * areas: a file too big for these goes to the COROS app.
 */
const W336_STAGING_BYTES: ReadonlyMap<number, number> = new Map([
  [0, 0x1400000], [1, 0x100000], [2, 0x2d00000], [7, 0x1700000], [9, 0x1700000], [11, 0x200000], [16, 0x200000], [17, 0x400000],
  [19, 0x400000], [21, 0x800000], [23, 0x80000], [43, 0x200000], [44, 0xc00000], [45, 0x400000], [47, 0xa00000], [48, 0x200000],
  [50, 0x200000], [52, 0xc00000], [81, 0x40000], [91, 0x500000], [92, 0x500000], [94, 0x1900000], [95, 0x500000], [96, 0x500000], [102, 0x100000]
]);

export function firmwareStagingBytes(firmwareType: string): ReadonlyMap<number, number> | undefined {
  return firmwareType === "COROS W336" ? W336_STAGING_BYTES : undefined;
}
/** BLEOTA_GO's answer buffer holds about 26 bytes: the watch lists at most 24 components. */
const COMMIT_MAX_TYPES = 24;
/** Sending speed for estimates until a transfer measures its own (COROS's own figure for iPhones). */
export const DEFAULT_TRANSFER_BYTES_PER_SECOND = 20_000;

/**
 * Customer-facing messages for what goes wrong; the details go to the diagnostics log.
 * Each is in the renderer's catalogs.
 */
export const FIRMWARE_TEXT = {
  refusedUnknown: "Your watch can't update right now. Try again in a moment.",
  lowBattery: "Charge your watch to at least 30%, unplug the cable, then try again.",
  cantInstall: "This update can't be installed from CorosLink. Install it with the COROS app.",
  download: "The update didn't download completely. Check your internet connection, then try again.",
  corosUnreachable: "CorosLink couldn't reach COROS. Check your internet connection, then try again.",
  signIn: "Sign in to COROS in Watch Faces to check for firmware updates.",
  watchUnreachable: "CorosLink couldn't reach your watch. Keep it nearby, then try again.",
  linkDropped: "The connection to your watch dropped. Keep it nearby, then select Update watch to continue.",
  watchDeclined: "Your watch couldn't take the update right now. Wait a moment, then try again.",
  watchChanged: "The connected watch changed. Check for updates, then try again.",
  checkAgain: "Check for updates, then try again.",
  notInstalled: "Your watch restarted without installing the update. Check for updates, then try again.",
  installing: "Your watch is installing an update. Reconnect it from the watch menu once it has restarted."
} as const;

/** Why a watch refuses BLEOTA, as its firmware names the codes. */
export const FIRMWARE_REFUSALS: Readonly<Record<number, string>> = {
  0x15: "Your watch's battery is too low to update. Charge it, unplug the cable, then try again.",
  0x16: "Finish the activity on your watch, then try again.",
  0x1a: "Unplug the charging cable from your watch, then try again.",
  0x1b: "Stop the music playing on your watch, then try again.",
  0x1c: "Stop navigating on your watch, then try again.",
  0x33: "Go back to the watch face on your watch, then try again."
};

export function firmwareRefusalMessage(code: number): string {
  return FIRMWARE_REFUSALS[code] ?? FIRMWARE_TEXT.refusedUnknown;
}

/** An error whose message is customer-facing as is (the others are mapped to FIRMWARE_TEXT). */
export class FirmwareUserError extends Error {
  constructor(message: string, readonly options: { checkAgain?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "FirmwareUserError";
  }
}

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let index = 0; index < 256; index++) {
    let crc = index << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    table[index] = crc;
  }
  return table;
})();

/** CRC-16/CCITT-FALSE, table-driven with an indexed loop: firmware files run to tens of megabytes. */
export function firmwareCrc16(data: Uint8Array, crc = 0xffff): number {
  for (let index = 0; index < data.length; index++) crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ data[index]!) & 0xff]!;
  return crc;
}

// ----- BLEOTA (0x94 00) -----

export interface WatchFirmwareComponent { type: number; crc: number }
export type FirmwareReadiness = { ready: true; components: WatchFirmwareComponent[] } | { ready: false; code: number };

export function encodeFirmwareCheck(): Buffer { return Buffer.from([OTA_CHECK]); }

export function decodeFirmwareCheck(reply: Buffer): FirmwareReadiness {
  if (reply.length === 1 && reply[0] !== 1) return { ready: false, code: reply[0]! };
  if (reply.length < 1 || reply[0] !== 1 || (reply.length - 1) % 3 !== 0) throw new Error("The watch sent an unreadable firmware check.");
  const components: WatchFirmwareComponent[] = [];
  for (let offset = 1; offset < reply.length; offset += 3) components.push({ type: reply[offset]!, crc: reply.readUInt16LE(offset + 1) });
  return { ready: true, components };
}

// ----- BLEOTA_GO (0x94 01) -----

export function encodeFirmwareCommit(system: { length: number; crc: number }, types: readonly number[]): Buffer {
  const listed = [...new Set(types)];
  if (!Number.isInteger(system.length) || system.length <= 16 || system.length > FIRMWARE_FILE_LIMIT ||
      !Number.isInteger(system.crc) || system.crc < 0 || system.crc > 0xffff || listed.length !== types.length ||
      listed.length > COMMIT_MAX_TYPES || listed.some(type => !FIRMWARE_FILE_TYPES.has(type) || SYSTEM_IMAGE_TYPES.has(type))) {
    throw new Error("Invalid firmware commit.");
  }
  const payload = Buffer.alloc(7 + listed.length);
  payload[0] = OTA_COMMIT;
  payload.writeUInt32LE(system.length, 1);
  payload.writeUInt16LE(system.crc, 5);
  payload.set(listed, 7);
  return payload;
}

/** [ok][type | ok << 7 …]: overall result (the system image's check included), then each listed type's. */
export function decodeFirmwareCommit(reply: Buffer, types: readonly number[]): { ok: boolean; failedTypes: number[] } {
  if (reply.length !== 1 + types.length || reply[0]! > 1) throw new Error("The watch sent an unreadable answer to the firmware update.");
  const failedTypes: number[] = [];
  types.forEach((type, index) => {
    const value = reply[1 + index]!;
    if ((value & 0x7f) !== type) throw new Error("The watch sent an unreadable answer to the firmware update.");
    if (!(value & 0x80)) failedTypes.push(type);
  });
  return { ok: reply[0] === 1 && failedTypes.length === 0, failedTypes };
}

// ----- the files -----

export interface FirmwareFileExpectation { type: number; size: number; crc: number; crc32?: number }

/**
 * Checks a downloaded component against the manifest and its own header:
 * [HF|DF][type u16 BE][2 format bytes][2][body length u32][body CRC u16][header CRC u16].
 * DF marks the system image. Returns the whole-file CRC the watch reports once it's installed.
 */
export function inspectFirmwareFile(bytes: Buffer, expected: FirmwareFileExpectation): { crc: number } {
  const problem = (detail: string) => new Error(`The downloaded firmware file ${expected.type} ${detail}. Check for updates again.`);
  if (bytes.length !== expected.size || bytes.length <= 16 || bytes.length > FIRMWARE_FILE_LIMIT) throw problem("is incomplete");
  const magic = bytes.toString("latin1", 0, 2);
  if (magic !== (SYSTEM_IMAGE_TYPES.has(expected.type) ? "DF" : "HF") || bytes.readUInt16BE(2) !== expected.type) throw problem("is not the expected component");
  if (bytes.readUInt32LE(8) !== bytes.length - 16 || firmwareCrc16(bytes.subarray(0, 14)) !== bytes.readUInt16LE(14) ||
      firmwareCrc16(bytes.subarray(16)) !== bytes.readUInt16LE(12)) throw problem("is damaged");
  const crc = firmwareCrc16(bytes);
  if (crc !== expected.crc || (expected.crc32 !== undefined && crc32(bytes) !== expected.crc32)) throw problem("doesn't match the update");
  return { crc };
}

/** SendFile block header: [0x78 0][type][offset u32][len u16][remaining u32][crc16][sum][0 0 0][3][sum]. */
export function encodeFirmwareBlockHeader(type: number, block: Buffer, offset: number, totalBytes: number): Buffer {
  if (!FIRMWARE_FILE_TYPES.has(type) || !Number.isInteger(offset) || offset < 0 || offset % FIRMWARE_BLOCK_BYTES !== 0 ||
      !Number.isInteger(totalBytes) || totalBytes > FIRMWARE_FILE_LIMIT || offset >= totalBytes ||
      block.length !== Math.min(FIRMWARE_BLOCK_BYTES, totalBytes - offset)) {
    throw new Error("Invalid firmware block.");
  }
  const header = Buffer.alloc(21);
  header[0] = 0x78; header[2] = type;
  header.writeUInt32LE(offset, 3); header.writeUInt16LE(block.length, 7);
  header.writeUInt32LE(totalBytes - offset, 9); header.writeUInt16LE(firmwareCrc16(block), 13);
  header[15] = block.reduce((sum, byte) => (sum + byte) & 255, 0);
  header[19] = 3;
  header[20] = header.subarray(2, 20).reduce((sum, byte) => (sum + byte) & 255, 0);
  return header;
}

// ----- the update manifest (COROS ota/query) -----

export interface FirmwareManifestFile {
  type: number;
  url: string;
  size: number;
  crc: number;
  crc32?: number;
  force: boolean;
  /** COROS's estimate of the watch's install time for this file, in seconds. */
  installSeconds: number;
}
export interface FirmwareRelease { version: string; notes?: string; files: FirmwareManifestFile[] }
export interface FirmwareManifest {
  latestVersion?: string;
  releases: FirmwareRelease[];
  /** Releases with a file CorosLink can't check: never installed in part, never skipped over. */
  unusableVersions: string[];
  transferBytesPerSecond: number;
}

/** The app version CorosLink's `ota/query` names (COROS's phone app's). */
export const FIRMWARE_QUERY_APP_VERSION = "4.10.8";
/**
 * COROS offers a release only to phone-app versions that support it; to an older one it lists
 * the releases before it and names the app version it needs (`appTargetVersion`, e.g. 4.11.8 for
 * PACE 4 3.2108.0). That version, when it is newer than the one asked with, is asked with again.
 */
export function firmwareQueryAppVersion(data: unknown, asked: string): string | undefined {
  const target = data && typeof data === "object" ? (data as { appTargetVersion?: unknown }).appTargetVersion : undefined;
  return typeof target === "string" && /^\d{1,3}(\.\d{1,4}){1,3}$/.test(target) && compareFirmwareVersions(target, asked) > 0 ? target : undefined;
}
/** COROS's install time for a file that doesn't give one (3.2108.0's don't): longer than any it has given but GPS's. */
const INSTALL_SECONDS_UNKNOWN = 30;

export function compareFirmwareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Firmware downloads come only from COROS over HTTPS. */
function corosFileUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "coros.com" || url.hostname.endsWith(".coros.com")) && !url.username && !url.password
      ? url.toString() : undefined;
  } catch { return undefined; }
}

const integer = (value: unknown, max: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;

/** `data` of COROS's mobile `ota/query`: releases in `batchList`, oldest first. */
export function normalizeFirmwareManifest(data: unknown): FirmwareManifest {
  const value = (data && typeof data === "object" ? data : {}) as { latestVersion?: unknown; batchList?: unknown; clientProfile?: unknown };
  const releases: FirmwareRelease[] = [];
  const unusableVersions: string[] = [];
  for (const entry of Array.isArray(value.batchList) ? value.batchList : []) {
    const batch = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const version = firmwareVersionOf(typeof batch.version === "string" ? batch.version : undefined);
    if (!version || !Array.isArray(batch.files)) continue;
    const files: FirmwareManifestFile[] = [];
    let valid = true;
    for (const item of batch.files) {
      const file = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const type = integer(file.type, 255), size = integer(file.fileSize, FIRMWARE_FILE_LIMIT), crc = integer(file.fileCRC, 0xffff);
      const url = corosFileUrl(file.fileUrl);
      if (type === undefined || size === undefined || size <= 16 || crc === undefined || !url) { valid = false; break; }
      const checksum = integer(file.fileCRC32, 0xffffffff);
      files.push({ type, url, size, crc, ...(checksum !== undefined ? { crc32: checksum } : {}), force: file.force === true,
        installSeconds: integer(file.timeuse, 3600) ?? INSTALL_SECONDS_UNKNOWN });
    }
    // A release with a file CorosLink can't check can't be installed in part.
    if (!valid || !files.length || new Set(files.map(file => file.type)).size !== files.length) { unusableVersions.push(version); continue; }
    const notes = typeof batch.content === "string" ? batch.content.replace(/\r\n?/g, "\n").trim().slice(0, 4000) : "";
    releases.push({ version, ...(notes && notes !== version ? { notes } : {}), files });
  }
  releases.sort((a, b) => compareFirmwareVersions(a.version, b.version));
  const latestVersion = firmwareVersionOf(typeof value.latestVersion === "string" ? value.latestVersion : undefined);
  const profile = (value.clientProfile && typeof value.clientProfile === "object" ? value.clientProfile : {}) as { iosBtTransferSpeed?: unknown };
  const speed = integer(profile.iosBtTransferSpeed, 1_000_000);
  return { ...(latestVersion ? { latestVersion } : {}), releases, unusableVersions,
    transferBytesPerSecond: speed && speed >= 1000 ? speed : DEFAULT_TRANSFER_BYTES_PER_SECOND };
}

export type NextFirmware =
  | { kind: "current" }
  /** COROS has a newer release CorosLink can't install, or can't install next. */
  | { kind: "unavailable"; version: string }
  | { kind: "release"; release: FirmwareRelease; followedBy?: string };

/**
 * What comes next for a watch on `current`: the oldest release newer than it (COROS steps
 * some watches through an intermediate release, one at a time). When that one can't be
 * installed, nothing later is offered either: an intermediate release is never skipped.
 */
export function nextFirmware(manifest: FirmwareManifest, current: string): NextFirmware {
  const newer = (version: string) => compareFirmwareVersions(version, current) > 0;
  const versions = [...manifest.releases.map(release => release.version), ...manifest.unusableVersions, ...(manifest.latestVersion ? [manifest.latestVersion] : [])]
    .filter(newer).sort(compareFirmwareVersions);
  if (!versions.length) return { kind: "current" };
  const latest = versions[versions.length - 1]!;
  const release = manifest.releases.find(entry => entry.version === versions[0]);
  if (!release || manifest.unusableVersions.includes(versions[0]!)) return { kind: "unavailable", version: latest };
  return { kind: "release", release, ...(compareFirmwareVersions(latest, release.version) > 0 ? { followedBy: latest } : {}) };
}

/** Roughly how long sending `bytes` takes, in seconds. */
export function transferSeconds(bytes: number, bytesPerSecond: number): number {
  return Math.ceil(bytes / Math.max(bytesPerSecond, 1000));
}

/**
 * What to send: the system image, and every other component the watch lists whose
 * installed CRC differs (0 when missing). Components the watch doesn't list aren't
 * kept up to date this way (another hardware variant's, another voice language's).
 * The parts staged over the live copy go last, so they are exposed for the shortest
 * time before the commit. A listed component CorosLink can't send, or one larger than
 * its staging area (`staging`, when known for the model), makes the whole release one
 * for the COROS app.
 */
export function planFirmwareFiles(release: FirmwareRelease, components: readonly WatchFirmwareComponent[],
  staging?: ReadonlyMap<number, number>): { system: FirmwareManifestFile; files: FirmwareManifestFile[] } {
  const systems = release.files.filter(file => SYSTEM_IMAGE_TYPES.has(file.type));
  if (systems.length !== 1) throw new FirmwareUserError(FIRMWARE_TEXT.cantInstall, { checkAgain: true });
  const installed = new Map(components.map(component => [component.type, component.crc]));
  const needed = release.files.filter(file => !SYSTEM_IMAGE_TYPES.has(file.type) && installed.has(file.type) &&
    (file.force || installed.get(file.type) !== file.crc));
  if (needed.some(file => !FIRMWARE_FILE_TYPES.has(file.type)) || needed.length > COMMIT_MAX_TYPES ||
      (staging && [systems[0]!, ...needed].some(file => !(file.size <= (staging.get(file.type) ?? 0))))) {
    throw new FirmwareUserError(FIRMWARE_TEXT.cantInstall, { checkAgain: true });
  }
  const staged = needed.filter(file => !IN_PLACE_TYPES.has(file.type)), inPlace = needed.filter(file => IN_PLACE_TYPES.has(file.type));
  return { system: systems[0]!, files: [systems[0]!, ...staged, ...inPlace] };
}
