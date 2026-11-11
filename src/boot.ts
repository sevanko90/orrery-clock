/**
 * Start-up reporting, imported first thing by main.ts: failures shown on the page
 * (not a silent black canvas), progress to the dev server's telemetry log, and
 * a watchdog for a start-up that never finishes.
 */
import { Telemetry } from './xr/telemetry';

// Start-up progress to the dev server's telemetry log, so a page stuck on the
// veil (on a headset, with no console to hand) says how far it got.
export const boot = new Telemetry(() => undefined);
boot.sendNow({ kind: 'boot', stage: 'start', url: location.href });

// Surface failures on the page rather than leaving a silent black canvas.
export function showFatal(msg: string) {
  let el = document.getElementById('fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
  }
  el.textContent = `The orrery couldn't start: ${msg}`;
  document.getElementById('veil')?.classList.add('gone');
}
addEventListener('error', (e) => {
  showFatal(e.message || String(e.error));
  boot.sendNow({ kind: 'error', message: e.message, stack: String(e.error?.stack ?? '').slice(0, 2000) });
});
addEventListener('unhandledrejection', (e) => {
  showFatal(String(e.reason?.message ?? e.reason));
  boot.sendNow({ kind: 'error', message: String(e.reason?.message ?? e.reason), stack: String(e.reason?.stack ?? '').slice(0, 2000) });
});

const bootStall = setTimeout(() => {
  boot.sendNow({ kind: 'boot', stage: 'stalled' });
  showFatal('start-up stalled (the graphics device never came up). Try closing the tab and opening the page again.');
}, 20_000);

/** Start-up finished: stop the stall watchdog and say so. */
export function bootDone() {
  clearTimeout(bootStall);
  boot.sendNow({ kind: 'boot', stage: 'running' });
}
