/**
 * Simulated time. `speed` is simulated seconds per real second:
 * 1 = real time, 0 = paused, negative = running backwards.
 */
export const SPEED_STEPS: { speed: number; label: string }[] = [
  { speed: -31_557_600, label: '−1 yr/s' },
  { speed: -2_629_800, label: '−1 mo/s' },
  { speed: -604_800, label: '−1 wk/s' },
  { speed: -86_400, label: '−1 day/s' },
  { speed: -3600, label: '−1 hr/s' },
  { speed: -60, label: '−1 min/s' },
  { speed: -1, label: '−1×' },
  { speed: 0, label: 'paused' },
  { speed: 1, label: 'real time' },
  { speed: 60, label: '1 min/s' },
  { speed: 3600, label: '1 hr/s' },
  { speed: 86_400, label: '1 day/s' },
  { speed: 604_800, label: '1 wk/s' },
  { speed: 2_629_800, label: '1 mo/s' },
  { speed: 31_557_600, label: '1 yr/s' },
];
export const REAL_TIME_STEP = SPEED_STEPS.findIndex((s) => s.speed === 1);

// The orbital elements are tuned for 1800–2050 but degrade gracefully;
// keep scrubbing within a range where the result still looks right.
export const MIN_TIME = Date.UTC(1000, 0, 1);
export const MAX_TIME = Date.UTC(3000, 0, 1);

type Listener = () => void;

export class SimClock {
  private anchorSim = Date.now();
  private anchorReal = performance.now();
  private stepIndex = REAL_TIME_STEP;
  private listeners = new Set<Listener>();
  /** Increments whenever simulated time is set discontinuously. */
  jumps = 0;

  get speed(): number {
    return SPEED_STEPS[this.stepIndex].speed;
  }

  get step(): number {
    return this.stepIndex;
  }

  /** Current simulated time, ms since epoch. */
  nowMs(): number {
    const t = this.anchorSim + (performance.now() - this.anchorReal) * this.speed;
    if (t < MIN_TIME || t > MAX_TIME) {
      const clamped = Math.min(MAX_TIME, Math.max(MIN_TIME, t));
      this.reanchor(clamped);
      this.jumps++;
      this.stepIndex = SPEED_STEPS.findIndex((s) => s.speed === 0);
      this.emit();
      return clamped;
    }
    return t;
  }

  /** True when showing the present moment at real-time speed. */
  isLive(): boolean {
    return this.speed === 1 && Math.abs(this.nowMs() - Date.now()) < 2000;
  }

  setStep(index: number): void {
    const i = Math.max(0, Math.min(SPEED_STEPS.length - 1, index));
    if (i === this.stepIndex) return;
    this.reanchor(this.nowMs());
    this.stepIndex = i;
    this.emit();
  }

  togglePause(): void {
    const paused = this.speed === 0;
    this.setStep(paused ? REAL_TIME_STEP : SPEED_STEPS.findIndex((s) => s.speed === 0));
  }

  jumpTo(ms: number): void {
    this.reanchor(Math.min(MAX_TIME, Math.max(MIN_TIME, ms)));
    this.jumps++;
    this.emit();
  }

  resetToNow(): void {
    this.reanchor(Date.now());
    this.jumps++;
    this.stepIndex = REAL_TIME_STEP;
    this.emit();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private reanchor(simMs: number): void {
    this.anchorSim = simMs;
    this.anchorReal = performance.now();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
