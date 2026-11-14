/** Watch firmware updates over Bluetooth (corosFirmwareService.ts); shared with the renderer. */

/** "V 3.2008.0", "W336-3.2008.0" → "3.2008.0". */
export function firmwareVersionOf(text: string | undefined): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "")?.[0];
}

/** The watch's battery must be at least this full to start and to finish an update. */
export const FIRMWARE_MIN_BATTERY_PERCENT = 30;

export interface FirmwareUpdateCheck {
  /** Passed back to start this update. */
  id: string;
  checkedAt: number;
  /** The watch's firmware version, e.g. "3.2008.0". */
  currentVersion: string;
  /** The release to install next; absent when the watch is up to date or `unavailable`. */
  update?: {
    version: string;
    notes?: string;
    /** What goes to the watch, and roughly how long sending it takes: absent while the watch can't say what it has. */
    bytes?: number;
    transferSeconds?: number;
    /** COROS's estimate of how long the watch takes to install it once it restarts. */
    installSeconds?: number;
    /** A newer release that follows this one (COROS steps some watches through an intermediate release). */
    followedBy?: string;
  };
  /** Why the watch can't update right now (charging, an activity, low battery…); fixed on the watch, then retried. */
  blocked?: string;
  /** A newer release that CorosLink can't install: the COROS app can. */
  unavailable?: { version: string };
}

export type FirmwareUpdatePhase =
  | "idle"
  /** Asking the watch what it has. */
  | "preparing"
  | "downloading"
  | "transferring"
  /** Checking the watch can install, then telling it to: no longer cancellable. */
  | "committing"
  /** The watch accepted the update and restarted to install it. */
  | "installing"
  /** The watch came back on the new version. */
  | "complete"
  | "failed"
  | "cancelled";

export interface FirmwareUpdateStatus {
  phase: FirmwareUpdatePhase;
  /** The version being installed, and the one the watch had. */
  version?: string;
  fromVersion?: string;
  downloadedBytes: number;
  downloadBytes: number;
  /** Blocks the watch already held count as sent. */
  sentBytes: number;
  totalBytes: number;
  /** While sending: roughly how long the rest takes, from the speed so far. */
  remainingSeconds?: number;
  /** When the watch accepted the update, and COROS's estimate of how long it takes to install. */
  committedAt?: number;
  installSeconds?: number;
  /** A failure or cancel left some parts of the watch changed: running the update again finishes it. */
  partial?: boolean;
  /** Everything was sent; the next attempt only asks the watch to install. */
  staged?: boolean;
  /** Customer-facing; the details are in the diagnostics log. */
  error?: string;
  /** The failure needs a new check before trying again (the watch or the release changed). */
  checkAgain?: boolean;
}
