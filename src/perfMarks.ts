/**
 * Where a frame's CPU time goes, for the headset telemetry: `startFrame()`
 * at the top of a frame, then `mark(part)` books the time since the previous
 * mark to `part`. `takeCpuParts()` returns the average ms per frame of each
 * part since it was last called, and starts again.
 */
const parts: Record<string, number> = {};
let frames = 0;
let markAt = 0;

export function startFrame(t = performance.now()) {
  markAt = t;
  frames++;
}

export function mark(part: string) {
  const t = performance.now();
  parts[part] = (parts[part] ?? 0) + (t - markAt);
  markAt = t;
}

export function takeCpuParts() {
  const avg: Record<string, number> = {};
  for (const k in parts) {
    avg[k] = +(parts[k] / Math.max(1, frames)).toFixed(2);
    parts[k] = 0;
  }
  frames = 0;
  return avg;
}
