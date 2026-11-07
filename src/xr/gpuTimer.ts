/**
 * GPU time of each frame's render, for the headset telemetry: a WebGL 2
 * TIME_ELAPSED query around the render, read back a few frames later (they
 * never stall). Needs EXT_disjoint_timer_query_webgl2; null where missing
 * (or on the WebGPU backend). Runs only while `probes.on` (its read-backs
 * are synchronous calls to the GPU process, so it may cost time itself).
 */
import { probes } from '../perfMarks';

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export class GpuTimer {
  private ext: TimerExt | null = null;
  private pending: WebGLQuery[] = [];
  private free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private sum = 0;
  private n = 0;

  constructor(private gl: WebGL2RenderingContext | null) {
    this.ext = (gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null;
  }

  get available() {
    return !!this.ext;
  }

  begin() {
    const gl = this.gl;
    if (!probes.on || !gl || !this.ext || this.active || this.pending.length > 8) return;
    this.active = this.free.pop() ?? gl.createQuery();
    if (this.active) gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active);
  }

  end() {
    const gl = this.gl;
    if (!gl || !this.ext || !this.active) return;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    // Collect whatever has finished, oldest first.
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!disjoint) {
        this.sum += ns / 1e6;
        this.n++;
      }
      this.free.push(this.pending.shift()!);
    }
  }

  /** Average GPU ms per frame since the last call, or null if none measured. */
  take(): number | null {
    if (!this.n) return null;
    const ms = +(this.sum / this.n).toFixed(2);
    this.sum = 0;
    this.n = 0;
    return ms;
  }
}
