import { createRoot } from 'react-dom/client';
import { WatchFirmwareSettings } from '../../src/settings/WatchFirmwareSettings';
import '../../src/i18n/allCatalogs';
import { setLanguage } from '../../src/i18n';
import type { CorosLinkApi } from '../../src/coroslink-api';
import type { FirmwareUpdateCheck, FirmwareUpdateStatus } from '../../electron/corosFirmwareTypes';
import '../../src/styles.css';
import '../../src/desktop.css';

// A PACE 4 on 3.2008.0 with 3.3000.0 on offer. The query picks other cases: case=current (up to date),
// blocked (on its charger), unavailable (only the COROS app can install it), signedout, unsupported (a PACE Pro),
// declined (the confirmation is declined), installing (an install pending from before); lang=fr|zh-CN.
// window.step(patch) moves an update on; window.reconnectTo(version) is what reconnecting finds.
const query = new URLSearchParams(location.search);
if (query.get('lang')) setLanguage(query.get('lang') as 'fr' | 'zh-CN');
const kind = query.get('case') ?? 'update';
const idle: FirmwareUpdateStatus = { phase: 'idle', downloadedBytes: 0, downloadBytes: 0, sentBytes: 0, totalBytes: 0 };
const state = window as unknown as { firmware: FirmwareUpdateStatus; installs: string[]; cancels: number; connects: number; signIns: number; version: string;
  step: (patch: Partial<FirmwareUpdateStatus>) => void; reconnectTo: string };
state.firmware = kind === 'installing'
  ? { ...idle, phase: 'installing', version: '3.3000.0', fromVersion: '3.2008.0', committedAt: Date.now() - 30_000, installSeconds: 240 }
  : idle;
state.installs = []; state.cancels = 0; state.connects = 0; state.signIns = 0;
state.version = kind === 'current' ? 'V 3.3000.0' : 'V 3.2008.0';
state.reconnectTo = '3.3000.0';
state.step = patch => { state.firmware = { ...state.firmware, ...patch }; };
const notes = '- Emoji support (partial).\n- Global map support.\n- Lap Torque data item added for cycling.\nThanks for training with COROS.';
const offer = (patch: Partial<FirmwareUpdateCheck> = {}): FirmwareUpdateCheck => ({ id: 'check-1', checkedAt: Date.now(), currentVersion: '3.2008.0',
  update: { version: '3.3000.0', notes, bytes: 62_300_000, transferSeconds: 3120, installSeconds: 240 }, ...patch });
const api = {
  getCorosNativeBleStatus: async () => ({ connected: true, systemBind: 'authenticated', firmwareRevision: state.version, backend: 'system',
    watchModel: kind === 'unsupported' ? 'pace-pro' : 'pace-4' }),
  getCorosWatchfaceStatus: async () => ({ authenticated: kind !== 'signedout' }),
  getWatchFirmwareStatus: async () => state.firmware,
  checkWatchFirmware: async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (kind === 'current') return { id: 'check-0', checkedAt: Date.now(), currentVersion: '3.3000.0' };
    if (kind === 'unavailable') return { id: 'check-2', checkedAt: Date.now(), currentVersion: '3.2008.0', unavailable: { version: '3.3000.0' } };
    if (kind === 'blocked') return offer({ update: { version: '3.3000.0', notes }, blocked: 'Unplug the charging cable from your watch, then try again.' });
    return offer();
  },
  // The native confirmation stays open a moment; the update then starts and reports through the status.
  installWatchFirmware: async (id: string) => {
    state.installs.push(id);
    await new Promise(resolve => setTimeout(resolve, 400));
    if (kind === 'declined') return null;
    state.firmware = { ...idle, phase: 'preparing', version: '3.3000.0', fromVersion: '3.2008.0' };
    return state.firmware;
  },
  cancelWatchFirmware: async () => { state.cancels += 1; state.step({ phase: 'cancelled' }); },
  connectCorosNativeBle: async () => {
    state.connects += 1;
    state.version = `V ${state.reconnectTo}`;
    state.firmware = { ...state.firmware, phase: state.reconnectTo === '3.3000.0' ? 'complete' : 'failed',
      ...(state.reconnectTo === '3.3000.0' ? {} : { error: 'Your watch restarted without installing the update. Check for updates, then try again.', checkAgain: true }) };
    return { connected: true };
  }
} as unknown as CorosLinkApi;

createRoot(document.getElementById('root')!).render(
  <div className="app">
    <div className="app-body">
      <main className="content">
        <section className="settings-view">
          <WatchFirmwareSettings api={api} onSignIn={() => { state.signIns += 1; }} />
        </section>
      </main>
    </div>
  </div>
);
