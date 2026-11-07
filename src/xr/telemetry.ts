/**
 * Headset telemetry (dev server only): samples and markers go to the dev
 * server's log, and commands come back from it. See scripts/telemetry-plugin.ts.
 */

/** What the workstation can ask a running session to do. */
export type Command =
  | { type: 'teleport'; x: number; y: number; z: number; yawDeg?: number }
  | { type: 'scale'; metresPerUnit: number }
  | { type: 'mode'; mode: 'fiction' | 'discworld' | 'moons' | 'hangar' | 'markers'; on: boolean }
  | { type: 'date'; iso: string }
  | { type: 'speed'; step: number }
  | { type: 'cull'; angle: number }
  | { type: 'note'; text: string }
  | { type: 'view'; name: string }
  | { type: 'fiction'; id: string }
  | { type: 'return' }
  /** Force an object (found by name in the scene) hidden, or let it be again: live cost-by-elimination. */
  | { type: 'hide'; name: string; on: boolean }
  /** Log the scene's named groups (two levels), to know what can be hidden. */
  | { type: 'list' }
  /** Heavier probes (GPU timer, three's render split) on or off. */
  | { type: 'probe'; on: boolean }
  /** The drum's glass shown (the desktop's) or hidden (VR default). */
  | { type: 'glass'; on: boolean };

export class Telemetry {
  readonly enabled = import.meta.env.DEV;
  private queue: object[] = [];
  private since = -1;
  private flushAt = 0;
  private pollAt = 0;
  private busy = false;

  constructor(private onCommand: (c: Command) => void) {}

  /** Queue an entry (sent in batches). */
  send(entry: object) {
    if (this.enabled) this.queue.push(entry);
  }

  /** Send one entry straight away (for start-up progress and errors, before the frame loop runs). */
  sendNow(entry: object) {
    if (!this.enabled) return;
    fetch('/__telemetry', { method: 'POST', body: JSON.stringify({ ...entry, ua: navigator.userAgent }), headers: { 'Content-Type': 'application/json' } }).catch(
      () => undefined,
    );
  }

  /** Call every frame; batches out entries and polls for commands. */
  tick(now: number) {
    if (!this.enabled) return;
    if (now >= this.flushAt && this.queue.length) {
      this.flushAt = now + 2000;
      const batch = this.queue;
      this.queue = [];
      fetch('/__telemetry', { method: 'POST', body: JSON.stringify(batch), headers: { 'Content-Type': 'application/json' } }).catch(
        () => undefined,
      );
    }
    if (now >= this.pollAt && !this.busy) {
      this.pollAt = now + 2000;
      this.busy = true;
      // The first poll only learns where the command file ends, so old commands don't replay.
      fetch(`/__telemetry/commands?since=${Math.max(0, this.since)}`)
        .then((r) => r.json())
        .then((r: { next: number; commands: Command[] }) => {
          if (this.since >= 0) r.commands.forEach((c) => this.onCommand(c));
          this.since = r.next;
        })
        .catch(() => undefined)
        .finally(() => (this.busy = false));
    }
  }
}
