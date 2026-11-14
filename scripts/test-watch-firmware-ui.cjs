// Watch firmware (Settings → Watch firmware): check, offer, the confirmation, progress through an
// update, finishing on the watch, installing and reconnecting, cancel (with parts written in place),
// failures, up to date, blocked, only-the-COROS-app, signed out, an unsupported watch, focus, French
// and a narrow window. Screenshots for review when COROSLINK_SHOTS names a directory.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(os.tmpdir(), `coroslink-watch-firmware-${process.pid}`));
app.on('window-all-closed', () => {});
async function main() {
  await app.whenReady();
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  let vite, win;
  const watchdog = setTimeout(() => { console.error('Watch firmware UI timed out'); app.exit(1); }, 240000);
  const shots = process.env.COROSLINK_SHOTS;
  try {
    vite = await createServer({ root: path.resolve(__dirname, '..'), configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error', define: { global: 'globalThis' } });
    await vite.listen();
    win = new BrowserWindow({ show: false, width: 1000, height: 800 });
    const errors = [];
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const js = code => win.webContents.executeJavaScript(code, true);
    const pause = ms => new Promise(r => setTimeout(r, ms));
    async function until(code) {
      const end = Date.now() + 10000;
      while (Date.now() < end) { if (await js(code)) return; await pause(50); }
      throw new Error(`Timed out: ${code} — ${await js(`JSON.stringify({ text: document.querySelector('.watch-firmware')?.innerText, firmware: window.firmware })`)}`);
    }
    const shoot = async name => {
      if (!shots) return;
      await pause(250);
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, `firmware-${name}.png`), (await win.webContents.capturePage()).toPNG());
    };
    const base = `http://127.0.0.1:${vite.httpServer.address().port}/scripts/fixtures/watch-firmware.html`;
    const open = async (query = '') => {
      await win.loadURL(`${base}${query ? `?${query}` : ''}`);
      await until(`document.querySelector('.watch-firmware-current dd')?.textContent.includes('3.')`);
    };
    const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const button = label => `Array.from(document.querySelectorAll('.watch-firmware button')).find(button => button.textContent.includes(${JSON.stringify(label)}))`;
    const click = label => js(`${button(label)}.click(); void 0`);
    const noOverflow = async label => {
      assert.equal(await js(`document.documentElement.scrollWidth <= innerWidth`), true, `no sideways scrolling (${label})`);
      const wide = await js(`Array.from(document.querySelectorAll('.watch-firmware *')).filter(el => el.getBoundingClientRect().right > el.closest('.watch-firmware').getBoundingClientRect().right + 0.5).map(el => el.className || el.tagName).slice(0, 5)`);
      assert.deepEqual(wide, [], `nothing sticks out of the panel (${label})`);
    };
    const status = () => text('.watch-firmware [role=status]');

    // An update, start to finish.
    await open();
    assert.equal(await text('.watch-firmware h2'), 'Watch firmware');
    assert.equal(await text('.watch-firmware-current dt'), 'Installed version');
    assert.equal(await text('.watch-firmware-current dd'), '3.2008.0', 'the version the watch reports');
    await js(`${button('Check for updates')}.focus(); void 0`);
    await click('Check for updates');
    await until(`document.querySelector('.watch-firmware-release') !== null`);
    assert.equal(await text('.watch-firmware-release h3'), 'Version 3.3000.0 is available.');
    assert.equal(await js(`document.activeElement?.id`), 'watch-firmware-release-title', 'focus moves to the result');
    assert.equal(await status(), 'Version 3.3000.0 is available.', 'announced');
    assert.match(await text('.watch-firmware-release .watch-panel-meta'), /^Update size: 59 MB · About 52 min to send$/);
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('.watch-firmware-notes li')).map(li => li.textContent)`),
      ['Emoji support (partial).', 'Global map support.', 'Lap Torque data item added for cycling.'], 'COROS\'s dash lines become a list');
    assert.equal(await text('.watch-firmware-notes p'), 'Thanks for training with COROS.');
    await shoot('available');
    await click('Update watch');
    await until(`window.installs.length === 1`);
    // While the native confirmation is open, nothing says the update started.
    assert.equal(await js(`document.querySelector('.watch-firmware-release') !== null && document.querySelector('.watch-firmware-progress') === null`), true);
    await until(`document.querySelector('.watch-firmware-progress strong')?.textContent === 'Getting your watch ready…'`);
    assert.equal(await js(`document.querySelector('.watch-firmware-release')`), null, 'the offer gives way to the progress');
    assert.equal(await js(`document.querySelector('[role=progressbar]').hasAttribute('aria-valuenow')`), false, 'indeterminate while preparing');
    await until(`document.activeElement?.textContent === 'Cancel'`);
    await js(`window.step({ phase: 'downloading', downloadBytes: 1000, downloadedBytes: 250 }); void 0`);
    await until(`document.querySelector('.watch-firmware-progress strong')?.textContent === 'Step 1 of 2 · Downloading the update…'`);
    assert.equal(await text('.watch-firmware-progress .map-install-progress-heading span'), '25%');
    await js(`window.step({ phase: 'transferring', totalBytes: 4096 * 10, sentBytes: 4096 * 4, remainingSeconds: 600 }); void 0`);
    await until(`document.querySelector('.watch-firmware-progress strong')?.textContent === 'Step 2 of 2 · Sending the update to your watch…'`);
    assert.equal(await js(`document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')`), '40');
    assert.equal(await text('.watch-firmware-progress small'), '16 KB of 40 KB · About 10 min left');
    assert.equal(await text('.watch-firmware-progress .map-install-progress-actions p'), 'Keep your watch nearby and off its charger until the transfer ends.');
    assert.equal(await js(`${button('Check for updates')}.getAttribute('aria-disabled')`), 'true', 'no second check while it runs');
    await shoot('sending');
    // On the light theme the shared track was white on white: this pane's is drawn from the text colour.
    await js(`document.documentElement.dataset.theme = 'paper'; void 0`);
    await pause(100);
    assert.notEqual(await js(`getComputedStyle(document.querySelector('.watch-firmware-progress .map-download-progress-track')).backgroundColor`), 'rgba(255, 255, 255, 0.08)');
    await shoot('sending-paper');
    await js(`delete document.documentElement.dataset.theme; void 0`);
    await js(`window.step({ phase: 'committing', sentBytes: 4096 * 10 }); void 0`);
    await until(`document.querySelector('.watch-firmware-progress strong')?.textContent === 'Finishing on your watch…'`);
    assert.equal(await js(`${button('Cancel')}`), undefined, 'nothing to cancel once the watch is told to install');
    assert.equal(await text('.watch-firmware-progress .map-install-progress-actions p'), 'This can take up to a minute. Keep your watch nearby.');
    await shoot('finishing');
    await js(`window.step({ phase: 'installing', committedAt: Date.now(), installSeconds: 240 }); void 0`);
    await until(`document.querySelector('.watch-firmware-installing')?.textContent.includes('restarting to install firmware 3.3000.0. This takes about 4 min.')`);
    assert.equal(await js(`${button('Check for updates')}`), undefined, 'no check while it installs');
    assert.equal(await js(`${button('Reconnect watch')}`), undefined, 'reconnecting comes once it should be done');
    await shoot('installing');
    await js(`window.step({ committedAt: Date.now() - 300000 }); void 0`);
    await until(`${button('Reconnect watch')} !== undefined`);
    assert.equal(await text('.watch-firmware-installing p'), 'Reconnect your watch to see whether the update worked.');
    await click('Reconnect watch');
    await until(`document.querySelector('.watch-firmware-note.is-done')?.textContent.startsWith('Your watch is updated to firmware 3.3000.0.')`);
    await until(`document.querySelector('.watch-firmware-current dd')?.textContent === '3.3000.0'`);
    await noOverflow('wide');

    // Cancel: before anything was written in place, and after.
    await open();
    await click('Check for updates');
    await until(`document.querySelector('.watch-firmware-release') !== null`);
    await click('Update watch');
    await until(`document.querySelector('.watch-firmware-progress .map-install-cancel') !== null`);
    await js(`document.querySelector('.watch-firmware-progress .map-install-cancel').click(); void 0`);
    await until(`document.querySelector('.watch-firmware-note')?.textContent === 'Update cancelled. Your watch keeps its current firmware.'`);
    assert.equal(await js(`window.cancels`), 1);
    assert.equal(await js(`${button('Update watch')} !== undefined`), true, 'the offer stays: trying again resumes');
    await click('Update watch');
    await until(`document.querySelector('.watch-firmware-progress') !== null`);
    await js(`window.step({ phase: 'cancelled', partial: true }); void 0`);
    await until(`document.querySelector('.watch-firmware-note')?.textContent.startsWith('Update stopped. Select Update watch to finish it.')`);

    // The confirmation declined: nothing changes.
    await open('case=declined');
    await click('Check for updates');
    await until(`document.querySelector('.watch-firmware-release') !== null`);
    await click('Update watch');
    await until(`window.installs.length === 1`);
    await pause(700);
    assert.equal(await js(`document.querySelector('.watch-firmware-release') !== null && document.querySelector('.watch-firmware-progress') === null`), true);

    // A failure that can be retried keeps the offer; one that needs a new check drops it.
    await open();
    await click('Check for updates');
    await until(`document.querySelector('.watch-firmware-release') !== null`);
    await click('Update watch');
    await until(`document.querySelector('.watch-firmware-progress') !== null`);
    await js(`window.step({ phase: 'failed', error: 'The connection to your watch dropped. Keep it nearby, then select Update watch to continue.', partial: true }); void 0`);
    await until(`document.querySelector('.watch-firmware .settings-error')?.textContent.startsWith('The connection to your watch dropped.')`);
    assert.match(await text('.watch-firmware .settings-error'), /Some features on your watch may not work until the update is finished\.$/);
    assert.equal(await js(`${button('Update watch')} !== undefined`), true);
    assert.equal(await js(`document.querySelectorAll('.watch-firmware .settings-error').length`), 1, 'the error is shown once');
    await click('Update watch');
    await until(`document.querySelector('.watch-firmware-progress') !== null`);
    await js(`window.step({ phase: 'failed', error: 'The connected watch changed. Check for updates, then try again.', checkAgain: true }); void 0`);
    await until(`document.querySelector('.watch-firmware .settings-error')?.textContent === 'The connected watch changed. Check for updates, then try again.'`);
    assert.equal(await js(`document.querySelector('.watch-firmware-release')`), null, 'a new check comes first');

    // An install pending from before CorosLink restarted, and a watch that came back without it.
    await open('case=installing');
    await until(`document.querySelector('.watch-firmware-installing') !== null`);
    await js(`window.reconnectTo = '3.2008.0'; window.step({ committedAt: Date.now() - 600000 }); void 0`);
    await until(`${button('Reconnect watch')} !== undefined`);
    await click('Reconnect watch');
    await until(`document.querySelector('.watch-firmware .settings-error')?.textContent === 'Your watch restarted without installing the update. Check for updates, then try again.'`);

    // Up to date, blocked, only the COROS app, signed out, an unsupported watch.
    await open('case=current');
    await click('Check for updates');
    await until(`document.querySelector('.watch-firmware-note.is-done')?.textContent === 'Your watch has the latest firmware.'`);
    assert.equal(await status(), 'Your watch has the latest firmware.');
    await open('case=blocked');
    await click('Check for updates');
    await until(`document.querySelector('.watch-firmware-release .watch-firmware-note') !== null`);
    assert.equal(await text('.watch-firmware-release .watch-firmware-note'), 'Unplug the charging cable from your watch, then try again.');
    assert.equal(await js(`Array.from(document.querySelectorAll('.watch-firmware-release button')).map(button => button.textContent).join()`), 'Try again', 'nothing to start until it can');
    await shoot('blocked');
    await open('case=unavailable');
    await click('Check for updates');
    await until(`document.querySelector('.watch-firmware-note')?.textContent === 'Version 3.3000.0 is available. Install it with the COROS app.'`);
    await open('case=signedout');
    await until(`document.querySelector('.watch-firmware-signin') !== null`);
    assert.equal(await text('.watch-firmware-signin span'), 'Sign in to COROS in Watch Faces to check for firmware updates.');
    assert.equal(await js(`${button('Check for updates')}`), undefined);
    await click('Open Watch Faces');
    assert.equal(await js(`window.signIns`), 1);
    await shoot('signed-out');
    await open('case=unsupported');
    await until(`document.querySelector('.watch-panel-empty')?.textContent.trim() === 'Not available on this watch.'`);
    assert.equal(await js(`${button('Check for updates')}`), undefined);

    // French, narrow.
    win.setContentSize(420, 800);
    await open('lang=fr');
    assert.equal(await text('.watch-firmware h2'), 'Micrologiciel de la montre');
    assert.equal(await text('.watch-firmware-current dt'), 'Version installée');
    await click('Rechercher les mises à jour');
    await until(`document.querySelector('.watch-firmware-release') !== null`);
    assert.equal(await text('.watch-firmware-release h3'), 'La version 3.3000.0 est disponible.');
    assert.match(await text('.watch-firmware-release .watch-panel-meta'), /^Taille de la mise à jour : /);
    await noOverflow('narrow French');
    await shoot('narrow-fr');
    assert.deepEqual(errors, [], 'no console errors');
    console.log('Watch firmware: check, focus and announcement, offer and notes, confirmation without progress, download and send progress, finishing without Cancel, installing and reconnecting, cancel (in place too), retry and new-check failures, pending install, up to date, blocked, COROS app only, signed out, unsupported watch, French and narrow layout passed.');
  } finally { clearTimeout(watchdog); win?.destroy(); await vite?.close(); }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
