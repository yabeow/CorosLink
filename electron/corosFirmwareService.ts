import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  compareFirmwareVersions, decodeFirmwareCheck, decodeFirmwareCommit, encodeFirmwareBlockHeader, encodeFirmwareCheck, encodeFirmwareCommit,
  FIRMWARE_BLOCK_BYTES, FIRMWARE_MIN_VERSION, FIRMWARE_TEXT, firmwareRefusalMessage, firmwareStagingBytes, FirmwareUserError, IN_PLACE_TYPES, inspectFirmwareFile,
  nextFirmware, normalizeFirmwareManifest, OTA_OPCODE, planFirmwareFiles, SYSTEM_IMAGE_TYPES, transferSeconds,
  type FirmwareManifestFile, type FirmwareRelease, type WatchFirmwareComponent
} from "./corosFirmwareProtocol";
import { FIRMWARE_MIN_BATTERY_PERCENT, type FirmwareUpdateCheck, type FirmwareUpdateStatus } from "./corosFirmwareTypes";

/**
 * Updates the watch's firmware over Bluetooth the way the COROS phone app does
 * (protocol in corosFirmwareProtocol.ts): COROS says which release comes next,
 * the watch says what it has, only the components that differ are downloaded and
 * sent, and the watch installs them after it restarts.
 *
 * Most components are staged apart from the copy the watch uses and change nothing
 * until the commit. A few are written over the live copy (IN_PLACE_TYPES): they are
 * sent last, and a run that stopped after starting them says so (`partial`), because
 * those features may not work until the update is finished. Trying again sends only
 * the blocks the watch doesn't hold yet, and a run that sent everything but couldn't
 * commit (the watch wasn't ready) only commits the next time.
 *
 * The watch is checked for readiness (its own check, plus the battery) before
 * sending and again right before the commit, because the commit itself doesn't
 * check. Every step checks it's still the same watch.
 */

/** The connected watch, as an update needs it. */
export interface FirmwareWatch {
  firmwareType: string;
  version: string;
  /** Stable across restarts (the serial number), to tell the same watch when it comes back. */
  identity: string;
}

export interface FirmwareLink {
  /** Connects and authenticates if needed; throws when this watch can't be updated from here. */
  watch(): Promise<FirmwareWatch>;
  /** The watch connected now, without connecting; throws when there is none. */
  current(): FirmwareWatch;
  /** The battery level, read from the watch now. */
  battery(): Promise<number | undefined>;
  exchange(opcode: number, payload: Buffer, timeoutSeconds: number): Promise<Buffer>;
  /** One SendFile block; true when the watch already held it. */
  sendBlock(type: number, header: Buffer, block: Buffer): Promise<boolean>;
  /** Closes the link, ending a transfer that stopped partway. */
  reset(): Promise<void>;
  /** The watch is restarting to install: its disconnect is expected. */
  restarting(): void;
}

/** An update the watch was told to install, kept until the watch comes back and shows whether it took. */
export interface PendingFirmwareInstall {
  identity: string;
  version: string;
  fromVersion: string;
  committedAt: number;
  installSeconds: number;
}

export interface FirmwareUpdaterOptions {
  link: FirmwareLink;
  /** COROS's `ota/query` data for this model and version. */
  manifest(firmwareType: string, version: string): Promise<unknown>;
  /** Where downloads are kept until the watch has them. */
  directory(): string;
  /** Keeps a pending install across app restarts. */
  pending?: { load(): PendingFirmwareInstall | undefined; save(value: PendingFirmwareInstall | undefined): void };
  /** Diagnostics for support: steps, plans, the watch's answers and the raw errors behind customer messages. */
  log?(event: string, detail: Record<string, unknown>): void;
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/** BLEOTA reads every component's CRC from the watch's storage. */
const CHECK_TIMEOUT_SECONDS = 60;
/** BLEOTA_GO checks every staged file before answering. */
const COMMIT_TIMEOUT_SECONDS = 90;
/** A check pins the release and the watch for this long: a long transfer and a retry fit in it. */
const CHECK_VALID_MS = 2 * 60 * 60_000;
/** A watch seen on its old version this soon after accepting an update may not have restarted yet. */
const RESTART_GRACE_MS = 60_000;
/** The watch's restart, on top of COROS's install estimate. */
const RESTART_SECONDS = 60;
/** A download that receives nothing for this long has stalled. */
const DOWNLOAD_IDLE_MS = 60_000;
/**
 * The watch shows its "downloading" screen while it receives firmware and for about half a
 * minute after the last block (31.5 s on a PACE 4), answering BLEOTA "not on the watch face"
 * meanwhile. That refusal is the update's own doing, so it's waited out, up to this long.
 */
const DOWNLOAD_SCREEN_MS = 90_000;
const DOWNLOAD_SCREEN_POLL_MS = 3_000;
const NOT_ON_WATCH_FACE = 0x33;

const idle = (): FirmwareUpdateStatus => ({ phase: "idle", downloadedBytes: 0, downloadBytes: 0, sentBytes: 0, totalBytes: 0 });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Plan = ReturnType<typeof planFirmwareFiles>;

export class CorosFirmwareUpdater {
  private checked?: { result: FirmwareUpdateCheck; watch: FirmwareWatch; release?: FirmwareRelease; transferBytesPerSecond: number; expires: number };
  /** Everything was sent for this release, but the watch wasn't ready to install it. */
  private staged?: { identity: string; version: string; plan: Plan };
  private pending?: PendingFirmwareInstall;
  private status: FirmwareUpdateStatus;
  private task?: Promise<FirmwareUpdateStatus>;
  private cancelled = false;
  private committing = false;
  private abort?: AbortController;
  /** When a block last went to the watch: its downloading screen may still be up. */
  private lastBlockAt?: number;

  constructor(private readonly options: FirmwareUpdaterOptions) {
    try { this.pending = options.pending?.load(); } catch { this.pending = undefined; }
    this.status = this.pending ? this.installingStatus(this.pending) : idle();
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private log(event: string, detail: Record<string, unknown> = {}): void { try { this.options.log?.(event, detail); } catch { /* never affects the update */ } }

  updateStatus(): FirmwareUpdateStatus { return { ...this.status }; }

  /** A download, transfer or commit is under way. */
  running(): boolean { return Boolean(this.task); }

  /** The version a check offered and its estimates, while it can still be installed. */
  offered(checkId: string): { version: string; transferSeconds?: number; installSeconds?: number } | undefined {
    const checked = this.checked;
    if (!checked?.release || checked.result.id !== checkId || checked.expires < this.now()) return undefined;
    const update = checked.result.update;
    return { version: checked.release.version, ...(update?.transferSeconds ? { transferSeconds: update.transferSeconds } : {}),
      ...(update?.installSeconds ? { installSeconds: update.installSeconds } : {}) };
  }

  private installingStatus(pending: PendingFirmwareInstall): FirmwareUpdateStatus {
    return { ...idle(), phase: "installing", version: pending.version, fromVersion: pending.fromVersion, committedAt: pending.committedAt, installSeconds: pending.installSeconds };
  }

  private savePending(value: PendingFirmwareInstall | undefined): void {
    this.pending = value;
    try { this.options.pending?.save(value); } catch (error) { this.log("pending not saved", { error: errorText(error) }); }
  }

  /** The watch's answer, in customer terms, with the raw error kept for support. */
  private userError(error: unknown, fallback: string, step: string): FirmwareUserError {
    if (error instanceof FirmwareUserError) return error;
    this.log(`${step} failed`, { error: errorText(error) });
    return new FirmwareUserError(fallback, { cause: error });
  }

  /** Asks COROS for the next release and the watch what it has. Changes nothing on the watch. */
  async check(): Promise<FirmwareUpdateCheck> {
    if (this.task) throw new FirmwareUserError("Wait for the firmware update to finish.");
    const { link } = this.options;
    // A finished update's outcome is shown until the next check, unless connecting for this one settles a pending install.
    if (!this.pending) this.status = idle();
    // Connecting settles an install the watch was doing (observe); errors here are the connection's own.
    const watch = await link.watch();
    this.observe(watch);
    if (this.pending?.identity === watch.identity) throw new FirmwareUserError(FIRMWARE_TEXT.installing);
    let data: unknown;
    try { data = await this.options.manifest(watch.firmwareType, watch.version); } catch (error) {
      const signIn = /sign in/i.test(errorText(error));
      throw this.userError(error, signIn ? FIRMWARE_TEXT.signIn : FIRMWARE_TEXT.corosUnreachable, "update query");
    }
    const manifest = normalizeFirmwareManifest(data);
    const next = nextFirmware(manifest, watch.version);
    const result: FirmwareUpdateCheck = { id: randomUUID(), checkedAt: this.now(), currentVersion: watch.version };
    let release: FirmwareRelease | undefined;
    if (next.kind === "unavailable") {
      result.unavailable = { version: next.version };
    } else if (next.kind === "release" && compareFirmwareVersions(watch.version, FIRMWARE_MIN_VERSION) < 0) {
      // This firmware's update handler was never traced: the COROS app updates it.
      result.unavailable = { version: next.followedBy ?? next.release.version };
    } else if (next.kind === "release") {
      release = next.release;
      const update: NonNullable<FirmwareUpdateCheck["update"]> = { version: release.version,
        ...(release.notes ? { notes: release.notes } : {}), ...(next.followedBy ? { followedBy: next.followedBy } : {}) };
      const readiness = await this.readiness("check");
      if (readiness.ready) {
        try {
          const plan = planFirmwareFiles(release, readiness.components, firmwareStagingBytes(watch.firmwareType));
          update.bytes = plan.files.reduce((sum, file) => sum + file.size, 0);
          update.transferSeconds = transferSeconds(update.bytes, manifest.transferBytesPerSecond);
          update.installSeconds = plan.files.reduce((sum, file) => sum + file.installSeconds, RESTART_SECONDS);
          this.log("check", { current: watch.version, offered: release.version, types: plan.files.map(file => file.type), bytes: update.bytes });
        } catch (error) {
          if (!(error instanceof FirmwareUserError)) throw error;
          result.unavailable = { version: next.followedBy ?? release.version };
          release = undefined;
        }
      } else {
        result.blocked = readiness.message;
      }
      if (release) result.update = update;
    } else {
      this.log("check", { current: watch.version, latest: manifest.latestVersion ?? "" });
    }
    if (result.unavailable) this.log("check", { current: watch.version, unavailable: result.unavailable.version, unusable: manifest.unusableVersions });
    this.checked = { result, watch, release, transferBytesPerSecond: manifest.transferBytesPerSecond, expires: this.now() + CHECK_VALID_MS };
    return result;
  }

  /**
   * Starts the update a check offered. Refusals that need no work (busy, an expired check)
   * reject at once; everything after that reports through `updateStatus()` as well.
   */
  install(checkId: string): Promise<FirmwareUpdateStatus> {
    if (this.task) return Promise.reject(new FirmwareUserError("Wait for the firmware update to finish."));
    const checked = this.checked;
    if (this.pending && this.pending.identity === checked?.watch.identity) return Promise.reject(new FirmwareUserError(FIRMWARE_TEXT.installing));
    if (!checked?.release || checked.result.id !== checkId || checked.expires < this.now()) {
      return Promise.reject(new FirmwareUserError(FIRMWARE_TEXT.checkAgain, { checkAgain: true }));
    }
    const release = checked.release;
    this.cancelled = false;
    const partial = this.status.version === release.version && this.status.partial;
    this.status = { ...idle(), phase: "preparing", version: release.version, fromVersion: checked.watch.version, ...(partial ? { partial } : {}) };
    this.task = this.run(checked.watch, release, checked.transferBytesPerSecond).finally(() => { this.task = undefined; });
    return this.task;
  }

  private async run(expected: FirmwareWatch, release: FirmwareRelease, bytesPerSecond: number): Promise<FirmwareUpdateStatus> {
    const { link } = this.options;
    let inFlight = false;
    try {
      const watch = await link.watch();
      this.requireSame(watch, expected);
      const staged = this.staged?.identity === watch.identity && this.staged.version === release.version ? this.staged.plan : undefined;
      let plan: Plan;
      if (staged) {
        plan = staged;
        const total = plan.files.reduce((sum, file) => sum + file.size, 0);
        this.status = { ...this.status, sentBytes: total, totalBytes: total };
      } else {
        const planned = await this.plan(release, watch);
        const directory = this.cacheDirectory(watch, release);
        this.status = { ...this.status, phase: "downloading", downloadBytes: planned.files.reduce((sum, file) => sum + file.size, 0) };
        const downloaded = await this.download(planned.files, directory);
        // The watch checks it can update only when asked, so it's asked again right before sending.
        this.status = { ...this.status, phase: "preparing" };
        plan = await this.plan(release, watch);
        for (const file of plan.files) if (!downloaded.has(file.type)) downloaded.set(file.type, await this.downloadFile(file, directory));
        this.log("transfer", { version: release.version, types: plan.files.map(file => file.type) });
        this.status = { ...this.status, phase: "transferring", totalBytes: plan.files.reduce((sum, file) => sum + file.size, 0), sentBytes: 0 };
        const started = this.now();
        let sent = 0;
        for (const file of plan.files) {
          const bytes = await fs.promises.readFile(downloaded.get(file.type)!);
          try { inspectFirmwareFile(bytes, file); } catch (error) { throw this.userError(error, FIRMWARE_TEXT.download, "file check"); }
          for (let offset = 0; offset < bytes.length; offset += FIRMWARE_BLOCK_BYTES) {
            this.throwIfCancelled();
            const block = bytes.subarray(offset, offset + FIRMWARE_BLOCK_BYTES);
            inFlight = true;
            try {
              this.requireSame(link.current(), watch);
              this.lastBlockAt = this.now();
              const held = await link.sendBlock(file.type, encodeFirmwareBlockHeader(file.type, block, offset, bytes.length), block);
              this.lastBlockAt = this.now();
              if (!held && IN_PLACE_TYPES.has(file.type)) this.status.partial = true;
            } catch (error) {
              throw this.userError(error, FIRMWARE_TEXT.linkDropped, `block ${file.type}@${offset}`);
            }
            this.status.sentBytes += block.length;
            sent += block.length;
            const elapsed = (this.now() - started) / 1000;
            this.status.remainingSeconds = elapsed >= 10
              ? Math.ceil((this.status.totalBytes - this.status.sentBytes) / Math.max(sent / elapsed, 1))
              : transferSeconds(this.status.totalBytes - this.status.sentBytes, bytesPerSecond);
          }
        }
        inFlight = false;
        this.throwIfCancelled();
        this.staged = { identity: watch.identity, version: release.version, plan };
      }
      return await this.commit(watch, release, plan);
    } catch (error) {
      const cancelled = this.cancelled && !this.committing;
      this.status = { ...this.status, phase: cancelled ? "cancelled" : "failed", remainingSeconds: undefined,
        error: cancelled ? undefined : errorText(error),
        ...(error instanceof FirmwareUserError && error.options.checkAgain ? { checkAgain: true } : {}),
        ...(this.staged?.version === release.version ? { staged: true } : {}) };
      this.log(cancelled ? "cancelled" : "failed", { version: release.version, sentBytes: this.status.sentBytes, partial: Boolean(this.status.partial),
        ...(cancelled ? {} : { error: errorText(error) }) });
      // Ends the watch's half-done file transfer before anything else is sent.
      if (inFlight) await link.reset().catch(() => undefined);
      if (cancelled) return this.updateStatus();
      throw error;
    } finally {
      this.committing = false;
      this.abort = undefined;
    }
  }

  private async commit(watch: FirmwareWatch, release: FirmwareRelease, plan: Plan): Promise<FirmwareUpdateStatus> {
    const { link } = this.options;
    this.committing = true;
    this.status = { ...this.status, phase: "committing", remainingSeconds: undefined };
    try { this.requireSame(link.current(), watch); } catch (error) { throw this.userError(error, FIRMWARE_TEXT.linkDropped, "commit"); }
    // BLEOTA_GO doesn't check the watch can install now; an activity or a flat battery can have come up since.
    const readiness = await this.readiness("commit");
    if (!readiness.ready) throw new FirmwareUserError(readiness.message);
    // The parts written in place are the copies the watch uses: its own CRC of each (the stored marker
    // aside) must now be the new file's. 0 says nothing (Wi-Fi firmware, whose record doesn't accept the
    // marker blanked while staging); any other value means the data isn't right, so nothing is installed.
    const reported = new Map(readiness.components.map(component => [component.type, component.crc]));
    const inPlace = plan.files.filter(file => IN_PLACE_TYPES.has(file.type));
    const wrong = inPlace.filter(file => reported.has(file.type) && reported.get(file.type) !== 0 && reported.get(file.type) !== file.crc);
    if (wrong.length) {
      this.log("in place not as sent", { version: release.version, types: wrong.map(file => [file.type, reported.get(file.type), file.crc]) });
      this.staged = undefined;
      throw new FirmwareUserError(FIRMWARE_TEXT.watchDeclined);
    }
    const unverified = inPlace.filter(file => reported.get(file.type) !== file.crc).map(file => file.type);
    if (unverified.length) this.log("in place unverified", { version: release.version, types: unverified });
    const types = plan.files.filter(file => !SYSTEM_IMAGE_TYPES.has(file.type)).map(file => file.type);
    const installSeconds = plan.files.reduce((sum, file) => sum + file.installSeconds, RESTART_SECONDS);
    // Kept before asking: the watch may install even if its answer never arrives (the link can drop as it restarts).
    const pending = { identity: watch.identity, version: release.version, fromVersion: watch.version, committedAt: this.now(), installSeconds };
    this.savePending(pending);
    let reply: Buffer;
    try {
      reply = await link.exchange(OTA_OPCODE, encodeFirmwareCommit({ length: plan.system.size, crc: plan.system.crc }, types), COMMIT_TIMEOUT_SECONDS);
    } catch (error) {
      this.log("commit unanswered", { version: release.version, error: errorText(error) });
      link.restarting();
      this.status = this.installingStatus(pending);
      return this.updateStatus();
    }
    let answer: ReturnType<typeof decodeFirmwareCommit>;
    try { answer = decodeFirmwareCommit(reply, types); } catch (error) {
      this.savePending(undefined);
      throw this.userError(error, FIRMWARE_TEXT.watchDeclined, "commit");
    }
    this.log("commit", { version: release.version, ok: answer.ok, failedTypes: answer.failedTypes });
    if (!answer.ok) {
      // Something staged didn't check out: next time everything that differs is sent again.
      this.savePending(undefined);
      this.staged = undefined;
      throw new FirmwareUserError(FIRMWARE_TEXT.watchDeclined);
    }
    link.restarting();
    this.staged = undefined;
    this.checked = undefined;
    this.status = this.installingStatus(pending);
    await fs.promises.rm(this.cacheDirectory(watch, release), { recursive: true, force: true }).catch(() => undefined);
    return this.updateStatus();
  }

  /** Stops a download or transfer; once the watch is being told to install, it can't be. */
  cancel(): void {
    if (!this.task || this.committing) return;
    this.cancelled = true;
    this.abort?.abort();
  }

  /** The watch connected and signed in: it's back from installing when it runs the new version. */
  observe(watch: FirmwareWatch): void {
    const pending = this.pending;
    if (!pending || !watch.identity || watch.identity !== pending.identity) return;
    if (compareFirmwareVersions(watch.version, pending.version) >= 0) {
      this.savePending(undefined);
      this.staged = undefined;
      this.status = { ...idle(), phase: "complete", version: pending.version, fromVersion: pending.fromVersion };
      this.log("installed", { version: pending.version });
    } else if (this.now() - pending.committedAt > RESTART_GRACE_MS) {
      this.savePending(undefined);
      this.status = { ...idle(), phase: "failed", version: pending.version, fromVersion: pending.fromVersion, error: FIRMWARE_TEXT.notInstalled, checkAgain: true,
        ...(this.staged ? { staged: true } : {}) };
      this.log("not installed", { version: pending.version, running: watch.version });
    }
  }

  private requireSame(watch: FirmwareWatch, expected: FirmwareWatch): void {
    if (!watch.identity || watch.identity !== expected.identity || watch.firmwareType !== expected.firmwareType || watch.version !== expected.version) {
      throw new FirmwareUserError(FIRMWARE_TEXT.watchChanged, { checkAgain: true });
    }
  }

  private throwIfCancelled(): void { if (this.cancelled) throw new Error("Firmware update cancelled."); }

  /** The battery floor, then the watch's own check. */
  private async readiness(step: string): Promise<{ ready: true; components: WatchFirmwareComponent[] } | { ready: false; message: string }> {
    const { link } = this.options;
    const lost = step === "check" ? FIRMWARE_TEXT.watchUnreachable : FIRMWARE_TEXT.linkDropped;
    let battery: number | undefined;
    try { battery = await link.battery(); } catch (error) { throw this.userError(error, lost, `${step} battery`); }
    if (battery !== undefined && battery < FIRMWARE_MIN_BATTERY_PERCENT) {
      this.log("not ready", { step, battery });
      return { ready: false, message: FIRMWARE_TEXT.lowBattery };
    }
    const ask = async () => {
      let reply: Buffer;
      try { reply = await link.exchange(OTA_OPCODE, encodeFirmwareCheck(), CHECK_TIMEOUT_SECONDS); } catch (error) {
        throw this.userError(error, lost, `${step} readiness`);
      }
      try { return decodeFirmwareCheck(reply); } catch (error) { throw this.userError(error, FIRMWARE_TEXT.watchDeclined, `${step} readiness`); }
    };
    let answer = await ask();
    for (let polls = 0; !answer.ready && answer.code === NOT_ON_WATCH_FACE && this.lastBlockAt !== undefined &&
         this.now() - this.lastBlockAt < DOWNLOAD_SCREEN_MS && polls < DOWNLOAD_SCREEN_MS / DOWNLOAD_SCREEN_POLL_MS; polls++) {
      if (polls === 0) this.log("waiting for the downloading screen", { step, seconds: Math.round((this.now() - this.lastBlockAt) / 1000) });
      await (this.options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(DOWNLOAD_SCREEN_POLL_MS);
      this.throwIfCancelled();
      answer = await ask();
    }
    if (!answer.ready) {
      this.log("not ready", { step, code: answer.code });
      return { ready: false, message: firmwareRefusalMessage(answer.code) };
    }
    return answer;
  }

  private async plan(release: FirmwareRelease, watch: FirmwareWatch): Promise<Plan> {
    this.throwIfCancelled();
    try { this.requireSame(this.options.link.current(), watch); } catch (error) { throw this.userError(error, FIRMWARE_TEXT.linkDropped, "plan"); }
    const readiness = await this.readiness("transfer");
    if (!readiness.ready) throw new FirmwareUserError(readiness.message);
    return planFirmwareFiles(release, readiness.components, firmwareStagingBytes(watch.firmwareType));
  }

  private cacheDirectory(watch: FirmwareWatch, release: FirmwareRelease): string {
    return path.join(this.options.directory(), watch.firmwareType.replace(/[^A-Za-z0-9]+/g, "-"), release.version);
  }

  /** Each file, from the cache when a checked copy is there. The cache keeps only this release. */
  private async download(files: readonly FirmwareManifestFile[], directory: string): Promise<Map<number, string>> {
    await fs.promises.mkdir(directory, { recursive: true });
    const parent = path.dirname(directory);
    for (const entry of await fs.promises.readdir(parent)) {
      if (entry !== path.basename(directory)) await fs.promises.rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    for (const entry of await fs.promises.readdir(directory)) {
      if (entry.endsWith(".partial")) await fs.promises.rm(path.join(directory, entry), { force: true }).catch(() => undefined);
    }
    const paths = new Map<number, string>();
    for (const file of files) paths.set(file.type, await this.downloadFile(file, directory));
    return paths;
  }

  private async downloadFile(file: FirmwareManifestFile, directory: string): Promise<string> {
    const abort = new AbortController();
    this.abort = abort;
    this.throwIfCancelled();
    const target = path.join(directory, `${file.type}.bin`);
    try {
      inspectFirmwareFile(await fs.promises.readFile(target), file);
      this.status.downloadedBytes += file.size;
      return target;
    } catch { /* not there yet, or not this file */ }
    this.throwIfCancelled();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const alive = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => abort.abort(), DOWNLOAD_IDLE_MS); };
    try {
      alive();
      // Only COROS's own HTTPS files (normalizeFirmwareManifest): a redirect elsewhere is refused.
      const response = await (this.options.fetch ?? fetch)(file.url, { signal: abort.signal, redirect: "error" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const chunks: Buffer[] = [];
      let received = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          alive();
          received += value.length;
          if (received > file.size) throw new Error("larger than the manifest says");
          chunks.push(Buffer.from(value));
          this.status.downloadedBytes += value.length;
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, received);
      inspectFirmwareFile(bytes, file);
      const partial = `${target}.${process.pid}.partial`;
      await fs.promises.writeFile(partial, bytes);
      await fs.promises.rename(partial, target);
      return target;
    } catch (error) {
      this.throwIfCancelled();
      throw this.userError(error, FIRMWARE_TEXT.download, `download ${file.type}`);
    } finally {
      clearTimeout(idleTimer);
    }
  }
}
