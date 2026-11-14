import { AlertCircle, Check, CircleSlash, Cpu, Download, Info, Loader2, Lock, RefreshCw, Watch } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatNumber, t, useLanguage } from "../i18n";
import type { CorosLinkApi } from "../coroslink-api";
import { ipcErrorText } from "../ipcErrorText";
import { formatBytes } from "../media/libraryUtils";
import { firmwareVersionOf, type FirmwareUpdateCheck, type FirmwareUpdatePhase, type FirmwareUpdateStatus } from "../../electron/corosFirmwareTypes";
import { NOT_AVAILABLE_ON_WATCH, watchSupports } from "../../electron/localSync/watchSyncModels";
import type { WatchModelId } from "../../electron/watchModels";
import "./settingsPanel.css";
import "./watchSystemSettings.css";
import "./watchFirmwareSettings.css";

/** Phases while CorosLink is still working on the update. */
const RUNNING: ReadonlySet<FirmwareUpdatePhase> = new Set(["preparing", "downloading", "transferring", "committing"]);
/** The service's message for a check that has to be made again (corosFirmwareProtocol.ts FIRMWARE_TEXT.checkAgain). */
const CHECK_AGAIN = "Check for updates, then try again.";
const USB_ADAPTER = "Firmware updates need this computer's Bluetooth, not the USB adapter.";

const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

function percentOf(done: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(done / total, 1)) : 0;
}

interface WatchLinkState { connected: boolean; version?: string; model?: WatchModelId; usbAdapter: boolean }

/** COROS's notes: "- " lines become a list, other lines paragraphs. */
function ReleaseNotes({ text }: { text: string }) {
  const blocks: Array<{ list: boolean; lines: string[] }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-•*]\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (item && last?.list) last.lines.push(item[1]!);
    else blocks.push({ list: Boolean(item), lines: [item ? item[1]! : line] });
  }
  return (
    <div className="watch-firmware-notes">
      {blocks.map((block, index) => block.list
        ? <ul key={index}>{block.lines.map((line, row) => <li key={row}>{line}</li>)}</ul>
        : block.lines.map((line, row) => <p key={`${index}-${row}`}>{line}</p>))}
    </div>
  );
}

/** Checks for a firmware update and installs it over Bluetooth (electron/corosFirmwareService.ts). */
export function WatchFirmwareSettings({ api, onSignIn }: { api: CorosLinkApi; onSignIn?: () => void }) {
  useLanguage();
  const [check, setCheck] = useState<FirmwareUpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [status, setStatus] = useState<FirmwareUpdateStatus | null>(null);
  const [link, setLink] = useState<WatchLinkState>({ connected: false, usbAdapter: false });
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);
  // English source text: translated when shown, so a language change updates it.
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const resultRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const outcomeRef = useRef<HTMLElement | null>(null);

  const phase = status?.phase ?? "idle";
  const running = RUNNING.has(phase);
  // The update's progress, quickly while it runs; the watch and the COROS sign-in, to show what applies.
  useEffect(() => {
    let live = true;
    const poll = () => {
      setNow(Date.now());
      void api.getWatchFirmwareStatus().then(next => { if (live) setStatus(next); }).catch(() => undefined);
      void api.getCorosNativeBleStatus().then(state => {
        if (!live) return;
        const connected = Boolean(state?.connected && state.systemBind === "authenticated");
        const version = connected ? firmwareVersionOf(state.firmwareRevision) ?? firmwareVersionOf(state.softwareRevision) : undefined;
        setLink({ connected, version, model: connected ? state.watchModel : undefined, usbAdapter: state?.backend === "usb" });
      }).catch(() => undefined);
      void api.getCorosWatchfaceStatus().then(value => { if (live) setSignedIn(value.authenticated); }).catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, running ? 500 : 3000);
    return () => { live = false; clearInterval(timer); };
  }, [api, running]);

  // Focus follows the update: Cancel once it starts, the outcome once it ends.
  const previousPhase = useRef<FirmwareUpdatePhase>("idle");
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (!RUNNING.has(before) && RUNNING.has(phase)) setTimeout(() => cancelRef.current?.focus(), 0);
    if (RUNNING.has(before) && !RUNNING.has(phase)) {
      setTimeout(() => outcomeRef.current?.focus(), 0);
      // An update that needs a new check drops the offer; one that can be retried keeps it.
      if (phase === "installing" || status?.checkAgain) setCheck(null);
    }
  }, [phase, status?.checkAgain]);

  const runCheck = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const result = await api.checkWatchFirmware();
      setCheck(result);
      setFollowUp(result.update?.followedBy);
      setStatus(await api.getWatchFirmwareStatus());
      setTimeout(() => resultRef.current?.focus(), 0);
    } catch (caught) {
      setCheck(null);
      setError(ipcErrorText(caught));
      setTimeout(() => outcomeRef.current?.focus(), 0);
    } finally {
      setChecking(false);
    }
  }, [api, checking]);

  const install = async () => {
    if (!check || confirming) return;
    setConfirming(true);
    setError(null);
    try {
      // Resolves once the update has started, or null when the confirmation was declined.
      const started = await api.installWatchFirmware(check.id);
      if (started) setStatus(started);
    } catch (caught) {
      const message = ipcErrorText(caught);
      if (message === CHECK_AGAIN) setCheck(null);
      setError(message);
    } finally {
      setConfirming(false);
    }
  };

  const reconnect = async () => {
    setReconnecting(true);
    setError(null);
    try {
      await api.connectCorosNativeBle();
      setStatus(await api.getWatchFirmwareStatus());
    } catch (caught) {
      setError(ipcErrorText(caught));
    } finally {
      setReconnecting(false);
    }
  };

  const unsupported = link.connected && link.model !== undefined && !watchSupports("firmware", link.model);
  const installing = phase === "installing";
  const update = check?.update;
  const inPlaceNote = status?.partial ? t("Some features on your watch may not work until the update is finished.") : null;

  const progress = () => {
    if (!status || !running) return null;
    const indeterminate = phase === "preparing" || phase === "committing";
    const value = phase === "downloading" ? percentOf(status.downloadedBytes, status.downloadBytes)
      : phase === "transferring" ? percentOf(status.sentBytes, status.totalBytes) : 0;
    const label = phase === "downloading" ? t("Step 1 of 2 · Downloading the update…")
      : phase === "transferring" ? t("Step 2 of 2 · Sending the update to your watch…")
        : phase === "committing" ? t("Finishing on your watch…") : t("Getting your watch ready…");
    return (
      <div className="map-install-progress watch-firmware-progress">
        <div className="map-install-progress-heading">
          <strong>{label}</strong>
          {indeterminate ? null : <span>{formatNumber(value, { style: "percent" })}</span>}
        </div>
        <div className={`map-download-progress-track${indeterminate ? " is-indeterminate" : ""}`} role="progressbar" aria-label={label}
          aria-valuemin={indeterminate ? undefined : 0} aria-valuemax={indeterminate ? undefined : 100} aria-valuenow={indeterminate ? undefined : Math.round(value * 100)}>
          <span style={indeterminate ? undefined : { width: `${Math.max(2, value * 100)}%` }} />
        </div>
        {phase === "transferring" ? (
          <small>
            {t("{{sent}} of {{total}}", { sent: formatBytes(status.sentBytes), total: formatBytes(status.totalBytes) })}
            {status.remainingSeconds ? <> · {t("About {{value0}} min left", { value0: minutes(status.remainingSeconds) })}</> : null}
          </small>
        ) : null}
        <div className="map-install-progress-actions">
          <p>{phase === "committing" ? t("This can take up to a minute. Keep your watch nearby.") : t("Keep your watch nearby and off its charger until the transfer ends.")}</p>
          {phase === "committing" ? null : (
            <button ref={cancelRef} type="button" className="secondary-button map-install-cancel" onClick={() => void api.cancelWatchFirmware().catch(() => undefined)}>
              {t("Cancel")}
            </button>
          )}
        </div>
      </div>
    );
  };

  /** What the last update did, when there's something to say. */
  const outcome = () => {
    if (!status || running) return null;
    if (installing) {
      const finishAt = (status.committedAt ?? 0) + (status.installSeconds ?? 0) * 1000;
      return (
        <div className="watch-firmware-installing">
          <p className="watch-firmware-note" ref={node => { outcomeRef.current = node; }} tabIndex={-1}>
            <Watch size={15} aria-hidden="true" />
            {now < finishAt
              ? t("Your watch is restarting to install firmware {{version}}. This takes about {{value0}} min.", { version: status.version ?? "", value0: minutes((finishAt - now) / 1000) })
              : t("Reconnect your watch to see whether the update worked.")}
          </p>
          {now >= finishAt ? (
            <button type="button" className="secondary-button" disabled={reconnecting} onClick={() => void reconnect()}>
              {reconnecting ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              {t("Reconnect watch")}
            </button>
          ) : null}
        </div>
      );
    }
    if (phase === "complete") {
      return (
        <p className="watch-firmware-note is-done" ref={node => { outcomeRef.current = node; }} tabIndex={-1}>
          <Check size={15} aria-hidden="true" />
          {t("Your watch is updated to firmware {{version}}.", { version: status.version ?? "" })}
          {followUp ? <> {t("Another update is available. Check for updates to install it.")}</> : null}
        </p>
      );
    }
    if (phase === "cancelled") {
      return (
        <p className="watch-firmware-note" ref={node => { outcomeRef.current = node; }} tabIndex={-1}>
          <CircleSlash size={15} aria-hidden="true" />
          {status.partial ? t("Update stopped. Select Update watch to finish it. Until then, some features on your watch may not work.")
            : t("Update cancelled. Your watch keeps its current firmware.")}
        </p>
      );
    }
    if (phase === "failed" && status.error && !error) {
      return (
        <p className="settings-error" ref={node => { outcomeRef.current = node; }} tabIndex={-1}>
          <AlertCircle size={14} aria-hidden="true" />
          <span>{t(status.error)}{inPlaceNote ? <> {inPlaceNote}</> : null}</span>
        </p>
      );
    }
    return null;
  };

  // One live region, always present, says what changed.
  const announcement = running ? "" : error ? t(error) : installing ? "" : phase === "complete" ? t("Your watch is updated to firmware {{version}}.", { version: status?.version ?? "" })
    : check?.unavailable ? t("Version {{version}} is available. Install it with the COROS app.", { version: check.unavailable.version })
      : update ? t("Version {{version}} is available.", { version: update.version })
        : check ? t("Your watch has the latest firmware.") : "";

  const requirement = unsupported ? (
    <p className="watch-panel-empty"><Lock size={16} aria-hidden="true" /> {t(NOT_AVAILABLE_ON_WATCH)}</p>
  ) : link.connected && link.usbAdapter ? (
    <p className="watch-panel-empty"><Lock size={16} aria-hidden="true" /> {t(USB_ADAPTER)}</p>
  ) : signedIn === false && !running && !installing ? (
    <div className="watch-panel-empty watch-firmware-signin">
      <Info size={16} aria-hidden="true" />
      <span>{t("Sign in to COROS in Watch Faces to check for firmware updates.")}</span>
      {onSignIn ? <button type="button" className="secondary-button" onClick={onSignIn}>{t("Open Watch Faces")}</button> : null}
    </div>
  ) : null;

  return (
    <div className="panel settings-units-panel settings-panel watch-firmware">
      <div className="settings-units-heading">
        <span className="settings-units-icon" aria-hidden="true"><Cpu size={22} /></span>
        <div>
          <p className="eyebrow">{t("Watch")}</p>
          <h2>{t("Watch firmware")}</h2>
          <p>{t("Install COROS firmware updates over Bluetooth.")}</p>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <div className="watch-firmware-current">
        <dl>
          <dt>{t("Installed version")}</dt>
          <dd className={link.version ? undefined : "is-muted"}>{link.version ?? t("Not connected")}</dd>
        </dl>
        {requirement || installing ? null : (
          <button type="button" className="secondary-button" aria-disabled={checking || running || confirming} onClick={() => { if (!running && !confirming) void runCheck(); }}>
            {checking ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            {t("Check for updates")}
          </button>
        )}
      </div>

      {requirement}
      {progress()}
      {outcome()}

      {check && !update && !check.unavailable && !running && !installing && !error ? (
        <p className="watch-firmware-note is-done" ref={node => { resultRef.current = node; }} tabIndex={-1}>
          <Check size={15} aria-hidden="true" />{t("Your watch has the latest firmware.")}
        </p>
      ) : null}

      {check?.unavailable && !running && !installing ? (
        <p className="watch-firmware-note" ref={node => { resultRef.current = node; }} tabIndex={-1}>
          <Info size={15} aria-hidden="true" />
          {t("Version {{version}} is available. Install it with the COROS app.", { version: check.unavailable.version })}
        </p>
      ) : null}

      {update && !running && !installing ? (
        <section className="watch-firmware-release" aria-labelledby="watch-firmware-release-title">
          <h3 id="watch-firmware-release-title" ref={node => { resultRef.current = node; }} tabIndex={-1}>
            {t("Version {{version}} is available.", { version: update.version })}
          </h3>
          {update.followedBy ? <p className="watch-panel-meta">{t("Version {{version}} follows after this one.", { version: update.followedBy })}</p> : null}
          {update.bytes ? (
            <p className="watch-panel-meta">
              {t("Update size: {{value0}}", { value0: formatBytes(update.bytes) })}
              {update.transferSeconds ? <> · {t("About {{value0}} min to send", { value0: minutes(update.transferSeconds) })}</> : null}
            </p>
          ) : null}
          {update.notes ? <ReleaseNotes text={update.notes} /> : null}
          {check?.blocked ? (
            <p className="watch-firmware-note"><Info size={15} aria-hidden="true" />{t(check.blocked)}</p>
          ) : null}
          {error ? <p className="settings-error" ref={node => { outcomeRef.current = node; }} tabIndex={-1}><AlertCircle size={14} aria-hidden="true" /><span>{t(error)}</span></p> : null}
          <div className="watch-firmware-actions">
            {check?.blocked ? (
              <button type="button" className="primary-button" aria-disabled={checking} onClick={() => void runCheck()}>
                <RefreshCw size={15} aria-hidden="true" />{t("Try again")}
              </button>
            ) : (
              <button type="button" className="primary-button" aria-disabled={checking || confirming} onClick={() => void install()}>
                <Download size={15} aria-hidden="true" />{t("Update watch")}
              </button>
            )}
          </div>
        </section>
      ) : null}

      {error && !(update && !running && !installing) ? (
        <p className="settings-error" ref={node => { outcomeRef.current = node; }} tabIndex={-1}><AlertCircle size={14} aria-hidden="true" /><span>{t(error)}</span></p>
      ) : null}
    </div>
  );
}
