import * as THREE from 'three/webgpu';

/** One line of a panel. */
export interface PanelRow {
  label: string;
  /** Section heading: drawn as a title, not pressable. */
  heading?: boolean;
  /** Toggle state (drawn as a lamp), or undefined for a plain button. */
  on?: boolean;
  /** Highlighted (e.g. the fiction scene playing). */
  active?: boolean;
  /** A separate eye button at the right (shown or hidden), pressed as part 1; the row itself is part 0. */
  eye?: boolean;
  /** Several buttons side by side in place of one; a press reports which (`part`). */
  buttons?: { label: string; active?: boolean }[];
  /** A notched slider: `stops` positions, the knob at `at`, `caption` above it; a press reports the stop under the ray (`part`). */
  slider?: { stops: number; at: number; caption: string };
}

const W = 512;
/** Tallest the canvas can be (px); a panel is cut to its content. */
const MAX_H = 1800;
const ROW = 64;
const SLIDER_ROW = 96;
const SIDE = 34;
/** Panels fade in and out over this (seconds): seen, not waited for. */
export const FADE_S = 0.4;

/**
 * A VR panel: an engraved brass plate with enamel inlays, worked with the
 * right controller's ray. It has a header of text lines (the first large)
 * and rows: headings, buttons and toggles, rows of side-by-side buttons, and
 * notched sliders. Pointing at a control lights it; the trigger presses it.
 * The plate is as tall as its content and grows upward from its pivot (its
 * bottom edge), so it can sit on a wrist.
 */
export class ControlPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private hover: { row: number; part: number } | null = null;
  private last = '';
  private rows: PanelRow[] = [];
  /** Top of each row and the header's height (canvas px), from the last layout. */
  private tops: number[] = [];
  private used = MAX_H;
  /** Shown amount, easing to `wanted` over FADE_S. */
  private fade = 0;
  private wanted = 0;

  constructor(
    private getRows: () => PanelRow[],
    private onPress: (index: number, part: number) => void,
    private getHeader: () => string[] = () => ['ORRERY'],
    /** Size of a canvas pixel on the plate (metres). */
    px = 0.0002,
  ) {
    this.canvas.width = W;
    this.canvas.height = MAX_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      // (Pivot at the bottom edge: cut to its content, the plate grows upward.)
      new THREE.PlaneGeometry(W * px, MAX_H * px).translate(0, (MAX_H * px) / 2, 0),
      // Drawn over everything (no depth test), in renderOrder: it sits on the
      // controller and z-fought the controller model.
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 26;
    this.mesh.name = 'control-panel';
    this.redraw();
  }

  /** Show or hide (fading). A hidden panel ignores the ray. */
  set shown(on: boolean) {
    this.wanted = on ? 1 : 0;
  }

  get shown() {
    return this.wanted === 1;
  }

  /** Per frame: ease the fade. */
  step(dt: number) {
    this.fade = THREE.MathUtils.clamp(this.fade + (this.wanted ? dt : -dt) / FADE_S, 0, 1);
    this.mesh.material.opacity = this.fade;
    this.mesh.visible = this.fade > 0.001;
  }

  /** Physical width (metres). */
  get width() {
    return this.mesh.geometry.parameters.width;
  }

  /** The control under a ray hit's uv, or null. */
  private controlAt(uv: THREE.Vector2): { row: number; part: number } | null {
    const y = (1 - uv.y) * this.used;
    const x = uv.x * W;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const top = this.tops[i],
        h = rowHeight(r);
      if (y < top || y >= top + h || r.heading) continue;
      if (r.buttons) {
        const part = Math.floor(((x - SIDE) / (W - SIDE * 2)) * r.buttons.length);
        return part >= 0 && part < r.buttons.length ? { row: i, part } : null;
      }
      if (r.slider) {
        const t = (x - SIDE - 20) / (W - (SIDE + 20) * 2);
        return { row: i, part: Math.round(THREE.MathUtils.clamp(t, 0, 1) * (r.slider.stops - 1)) };
      }
      if (r.eye !== undefined && x >= W - SIDE - EYE_W) return { row: i, part: 1 };
      return { row: i, part: 0 };
    }
    return null;
  }

  /** Test a ray: the hit (with distance) if it lands on the panel. Updates the hover light. */
  hit(raycaster: THREE.Raycaster): THREE.Intersection | null {
    if (!this.mesh.parent || !this.wanted) {
      this.setHover(null);
      return null;
    }
    const h = raycaster.intersectObject(this.mesh, false)[0] ?? null;
    this.setHover(h?.uv ? this.controlAt(h.uv) : null);
    return h;
  }

  /** Press whatever control is lit. */
  press() {
    if (this.hover) this.onPress(this.hover.row, this.hover.part);
  }

  private setHover(h: { row: number; part: number } | null) {
    if (h?.row !== this.hover?.row || h?.part !== this.hover?.part) {
      this.hover = h;
      this.redraw();
    }
  }

  /** Redraw if the rows or header changed (call now and then). */
  refresh() {
    this.redraw();
  }

  private redraw() {
    this.rows = this.getRows();
    const header = this.getHeader();
    const key = JSON.stringify([header, this.rows, this.hover]);
    if (key === this.last) return;
    this.last = key;
    const { ctx } = this;
    ctx.clearRect(0, 0, W, MAX_H);

    // Header: the first line large, the rest small.
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    let y = 52;
    header.forEach((line, i) => {
      ctx.fillStyle = '#2a1a08';
      ctx.font = i === 0 ? '600 34px Cinzel, Georgia, serif' : '500 23px "IBM Plex Mono", monospace';
      ctx.fillText(line, W / 2, y, W - 80);
      y += i === 0 ? 40 : 30;
    });
    y += 8;

    this.tops = [];
    this.rows.forEach((r, i) => {
      this.tops.push(y);
      const h = rowHeight(r);
      const lit = this.hover?.row === i ? this.hover.part : -1;
      if (r.heading) {
        ctx.fillStyle = '#2a1a08';
        ctx.font = '600 26px Cinzel, Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText(r.label.toUpperCase(), W / 2, y + h / 2 + 4);
        ctx.fillRect(60, y + h - 8, W - 120, 2);
      } else if (r.buttons) {
        const n = r.buttons.length,
          gap = 8,
          bw = (W - SIDE * 2 - gap * (n - 1)) / n;
        r.buttons.forEach((b, j) => {
          const x = SIDE + j * (bw + gap);
          inlay(ctx, x, y + 6, bw, h - 12, j === lit, !!b.active);
          ctx.fillStyle = j === lit ? '#1e1306' : '#f1dcaa';
          ctx.font = '500 24px Georgia, serif';
          ctx.textAlign = 'center';
          ctx.fillText(b.label, x + bw / 2, y + h / 2, bw - 10);
        });
      } else if (r.slider) {
        const s = r.slider;
        ctx.fillStyle = '#2a1a08';
        ctx.font = '500 24px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText(s.caption, W / 2, y + 22);
        const x0 = SIDE + 20,
          x1 = W - SIDE - 20,
          ty = y + 62;
        // Engraved track with a notch at each stop.
        ctx.fillStyle = '#14243e';
        ctx.beginPath();
        ctx.roundRect(x0 - 12, ty - 9, x1 - x0 + 24, 18, 9);
        ctx.fill();
        ctx.strokeStyle = '#d9b46a';
        ctx.lineWidth = 2;
        ctx.stroke();
        for (let k = 0; k < s.stops; k++) {
          const x = x0 + ((x1 - x0) * k) / (s.stops - 1);
          ctx.fillStyle = k === lit ? '#e8c06a' : 'rgba(241, 220, 170, 0.55)';
          ctx.fillRect(x - 1.5, ty - 6, 3, 12);
        }
        // The knob.
        const kx = x0 + ((x1 - x0) * s.at) / (s.stops - 1);
        ctx.beginPath();
        ctx.arc(kx, ty, 15, 0, Math.PI * 2);
        ctx.fillStyle = '#e8c06a';
        ctx.fill();
        ctx.strokeStyle = '#3a2810';
        ctx.lineWidth = 3;
        ctx.stroke();
        if (lit >= 0 && lit !== s.at) {
          // Where a press would put it.
          const lx = x0 + ((x1 - x0) * lit) / (s.stops - 1);
          ctx.beginPath();
          ctx.arc(lx, ty, 11, 0, Math.PI * 2);
          ctx.strokeStyle = '#e8c06a';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      } else {
        const eyeW = r.eye !== undefined ? EYE_W + 8 : 0;
        inlay(ctx, SIDE, y + 6, W - SIDE * 2 - eyeW, h - 12, lit === 0, !!r.active);
        ctx.fillStyle = lit === 0 ? '#1e1306' : '#f1dcaa';
        ctx.font = '500 25px Georgia, serif';
        ctx.textAlign = 'left';
        ctx.fillText(r.label, 54, y + h / 2, W - 150 - eyeW);
        if (r.eye !== undefined) {
          const ex = W - SIDE - EYE_W;
          inlay(ctx, ex, y + 6, EYE_W, h - 12, lit === 1, false);
          drawEye(ctx, ex + EYE_W / 2, y + h / 2, r.eye, lit === 1 ? '#1e1306' : '#f1dcaa');
        }
        if (r.on !== undefined) {
          // A lamp: lit amber when on.
          ctx.beginPath();
          ctx.arc(W - 70, y + h / 2, 12, 0, Math.PI * 2);
          ctx.fillStyle = r.on ? '#ffb347' : '#3a2a18';
          ctx.fill();
          ctx.strokeStyle = '#d9b46a';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      y += h;
    });

    // The plate, behind everything drawn, cut to the content.
    const used = Math.min(MAX_H, Math.ceil(y + 30));
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 228, 160, 0.6)';
    ctx.beginPath();
    ctx.roundRect(18, 18, W - 36, used - 36, 20);
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#3a2810';
    ctx.beginPath();
    ctx.roundRect(4, 4, W - 8, used - 8, 28);
    ctx.stroke();
    const g = ctx.createLinearGradient(0, 0, W, used);
    g.addColorStop(0, '#6e5224');
    g.addColorStop(0.5, '#a8803c');
    g.addColorStop(1, '#5e4420');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    this.used = used;
    const f = used / MAX_H;
    this.texture.repeat.set(1, f);
    this.texture.offset.set(0, 1 - f);
    this.mesh.scale.y = f;
    this.texture.needsUpdate = true;
  }
}

/** Width of a row's eye button (canvas px). */
const EYE_W = 64;

/** An eye (shown), struck through when hidden. */
function drawEye(ctx: CanvasRenderingContext2D, x: number, y: number, open: boolean, colour: string) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = colour;
  ctx.lineWidth = 2.5;
  ctx.globalAlpha = open ? 1 : 0.6;
  ctx.beginPath();
  ctx.moveTo(x - 17, y);
  ctx.quadraticCurveTo(x, y - 15, x + 17, y);
  ctx.quadraticCurveTo(x, y + 15, x - 17, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  if (!open) {
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 15, y + 13);
    ctx.lineTo(x + 15, y - 13);
    ctx.stroke();
  }
  ctx.restore();
}

function rowHeight(r: PanelRow) {
  return r.slider ? SLIDER_ROW : ROW;
}

/** An enamel inlay: deep blue, lit gold when pointed at, green when active. */
function inlay(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lit: boolean, active: boolean) {
  ctx.fillStyle = lit ? '#e8c06a' : active ? '#1f4a34' : '#14243e';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 14);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#d9b46a';
  ctx.stroke();
}
