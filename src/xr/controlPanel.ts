import * as THREE from 'three/webgpu';

/** One line of the panel: a heading (not pressable) or a control. */
export interface PanelRow {
  label: string;
  /** Section heading: drawn as a title, not pressable. */
  heading?: boolean;
  /** Toggle state (drawn as a lamp), or undefined for a plain button. */
  on?: boolean;
  /** Highlighted (e.g. the fiction scene playing). */
  active?: boolean;
}

/**
 * The VR control box: a small engraved brass plate with enamel inlays, worn
 * above the left wrist and worked with the right controller's ray. Rows come
 * from the app (moons toggle, the fiction catalogue, return); pointing at a
 * row lights it, the trigger presses it.
 */
export class ControlPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private hover = -1;
  private last = '';
  private rows: PanelRow[] = [];
  private static W = 512;
  private static H = 1000;
  private static TOP = 70;
  private static ROW = 64;

  constructor(
    private getRows: () => PanelRow[],
    private onPress: (index: number) => void,
    /** Physical height (metres). */
    height = 0.2,
  ) {
    this.canvas.width = ControlPanel.W;
    this.canvas.height = ControlPanel.H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const w = (height * ControlPanel.W) / ControlPanel.H;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, height),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false }),
    );
    this.mesh.renderOrder = 26;
    this.mesh.name = 'control-panel';
    this.redraw();
  }

  /** Row under a ray hit's uv, or -1. */
  private rowAt(uv: THREE.Vector2) {
    const y = (1 - uv.y) * ControlPanel.H - ControlPanel.TOP;
    const i = Math.floor(y / ControlPanel.ROW);
    return i >= 0 && i < this.rows.length && !this.rows[i].heading ? i : -1;
  }

  /** Test a ray: the hit (with distance) if it lands on the panel. Updates the hover light. */
  hit(raycaster: THREE.Raycaster): THREE.Intersection | null {
    if (!this.mesh.parent || !this.mesh.visible) {
      this.setHover(-1);
      return null;
    }
    const h = raycaster.intersectObject(this.mesh, false)[0] ?? null;
    this.setHover(h?.uv ? this.rowAt(h.uv) : -1);
    return h;
  }

  /** Press whatever row is lit. */
  press() {
    if (this.hover >= 0) this.onPress(this.hover);
  }

  private setHover(i: number) {
    if (i !== this.hover) {
      this.hover = i;
      this.redraw();
    }
  }

  /** Redraw if the rows changed (call now and then). */
  refresh() {
    this.redraw();
  }

  private redraw() {
    this.rows = this.getRows();
    const key = JSON.stringify([this.rows, this.hover]);
    if (key === this.last) return;
    this.last = key;
    const { ctx } = this;
    const W = ControlPanel.W,
      H = ControlPanel.H,
      ROW = ControlPanel.ROW,
      TOP = ControlPanel.TOP;
    ctx.clearRect(0, 0, W, H);
    // Brass plate with a darker engraved border.
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#6e5224');
    g.addColorStop(0.5, '#a8803c');
    g.addColorStop(1, '#5e4420');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(4, 4, W - 8, H - 8, 28);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#3a2810';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 228, 160, 0.6)';
    ctx.beginPath();
    ctx.roundRect(18, 18, W - 36, H - 36, 20);
    ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#2a1a08';
    ctx.font = '600 34px Cinzel, Georgia, serif';
    ctx.fillText('ORRERY', W / 2, TOP / 2 + 8);
    this.rows.forEach((r, i) => {
      const y = TOP + i * ROW;
      if (r.heading) {
        ctx.fillStyle = '#2a1a08';
        ctx.font = '600 26px Cinzel, Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText(r.label.toUpperCase(), W / 2, y + ROW / 2 + 4);
        ctx.fillRect(60, y + ROW - 8, W - 120, 2);
        return;
      }
      // Enamel inlay: deep blue, lit gold when pointed at, green when active.
      const lit = i === this.hover;
      ctx.fillStyle = lit ? '#e8c06a' : r.active ? '#1f4a34' : '#14243e';
      ctx.beginPath();
      ctx.roundRect(34, y + 6, W - 68, ROW - 12, 14);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#d9b46a';
      ctx.stroke();
      ctx.fillStyle = lit ? '#1e1306' : '#f1dcaa';
      ctx.font = '500 25px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.fillText(r.label, 54, y + ROW / 2, W - 150);
      if (r.on !== undefined) {
        // A lamp: lit amber when on.
        ctx.beginPath();
        ctx.arc(W - 70, y + ROW / 2, 12, 0, Math.PI * 2);
        ctx.fillStyle = r.on ? '#ffb347' : '#3a2a18';
        ctx.fill();
        ctx.strokeStyle = '#d9b46a';
        ctx.stroke();
      }
    });
    this.texture.needsUpdate = true;
  }
}
