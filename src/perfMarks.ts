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

/** Add `ms` to `part` without moving the mark (for time nested inside another part, named "outer>inner"). */
export function book(part: string, ms: number) {
  parts[part] = (parts[part] ?? 0) + ms;
}

/**
 * Whole-frame view, for finding time spent outside our code: the interval
 * between frames (from the frame timestamps), the gap between the end of
 * one frame's work and the start of the next (the browser, the compositor,
 * three's XR setup and waiting on the GPU all land here), long frames, and
 * garbage collections (heap drops).
 */
const intervals: number[] = [];
let lastStamp = 0;
let lastEnd = 0;
let outside = 0;
let outsideN = 0;
let longFrames = 0;
let gcs = 0;
let lastHeap = 0;
type MemPerf = Performance & { memory?: { usedJSHeapSize: number } };

/** At the start of a frame's work, with the frame's timestamp. */
export function frameBegin(stamp: number, t0: number) {
  if (lastStamp && Number.isFinite(stamp) && stamp > lastStamp) intervals.push(stamp - lastStamp);
  if (Number.isFinite(stamp)) lastStamp = stamp;
  if (lastEnd) {
    outside += t0 - lastEnd;
    outsideN++;
  }
}

/** At the end of a frame's work. `budgetMs`: our JS share of the frame. */
export function frameEnd(t0: number, budgetMs = 11) {
  lastEnd = performance.now();
  if (lastEnd - t0 > budgetMs) longFrames++;
  const heap = (performance as MemPerf).memory?.usedJSHeapSize ?? 0;
  if (heap && lastHeap && heap < lastHeap - 512 * 1024) gcs++;
  lastHeap = heap;
}

/** Frame-level stats since the last call, then start again. `targetMs`: the display's frame time. */
export function takeFrameStats(targetMs: number) {
  const s = [...intervals].sort((a, b) => a - b);
  const pct = (q: number) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2) : null);
  const stats = {
    intervalP50: pct(0.5),
    intervalP95: pct(0.95),
    intervalMax: s.length ? +s[s.length - 1].toFixed(1) : null,
    // Frames that took longer than one display refresh (a dropped frame each).
    missed: s.filter((x) => x > targetMs * 1.5).length,
    frames: s.length,
    outsideMs: outsideN ? +(outside / outsideN).toFixed(2) : null,
    longFrames,
    gcs,
    heapMB: lastHeap ? +(lastHeap / 1048576).toFixed(1) : null,
  };
  intervals.length = 0;
  outside = 0;
  outsideN = 0;
  longFrames = 0;
  gcs = 0;
  return stats;
}

/**
 * The heavier probes (three's render split)
 * run only while this is on: telemetry `probe` switches it
 * live, so their own cost can be measured in the same session.
 */
export const probes = { on: false };

/**
 * Split three's render call: the scene-graph walk (the drawing pipeline's
 * `project`, outermost call of its recursion) and the draw loops
 * (`_renderObjects`, outermost call: transmission passes nest it). Booked
 * as "render>project" and "render>draw". Private three internals: if
 * they're renamed this quietly does nothing.
 */
export function probeRenderer(renderer: object) {
  const r = renderer as Record<string, unknown>;
  wrapOutermost(r.drawingPipeline as Record<string, unknown> | undefined, 'project', 'render>project');
  wrapOutermost(r, '_renderObjects', 'render>draw');
}

function wrapOutermost(target: Record<string, unknown> | undefined, method: string, part: string) {
  const fn = target?.[method] as ((...a: unknown[]) => unknown) | undefined;
  if (!target || typeof fn !== 'function') return;
  let depth = 0;
  target[method] = function (this: unknown, ...a: unknown[]) {
    if (!probes.on || depth > 0) return fn.apply(this, a);
    depth++;
    const t = performance.now();
    try {
      return fn.apply(this, a);
    } finally {
      depth--;
      book(part, performance.now() - t);
    }
  };
}
