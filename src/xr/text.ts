import * as THREE from 'three/webgpu';

/**
 * A small engraved brass-and-ink plate of text, drawn to a canvas. Used for
 * hover labels and the wrist readout until the full 3D UI arrives.
 */
export class TextPlate {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private last = '';
  /** Width / height of the plate. */
  readonly aspect: number;

  constructor(
    private width = 512,
    private height = 160,
  ) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.aspect = width / height;
  }

  /** Redraw with a title line and optional smaller lines (no-op if unchanged). */
  set(title: string, lines: string[] = []) {
    const key = [title, ...lines].join('\n');
    if (key === this.last) return;
    this.last = key;
    const { ctx, width: w, height: h } = this;
    ctx.clearRect(0, 0, w, h);
    const r = 22;
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, r);
    ctx.fillStyle = 'rgba(14, 10, 6, 0.82)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(214, 170, 92, 0.9)';
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const n = lines.length;
    const titleSize = n ? Math.min(54, h * 0.32) : Math.min(64, h * 0.42);
    const lineSize = Math.min(34, (h * 0.5) / Math.max(1, n));
    const titleY = n ? h * 0.12 + titleSize * 0.6 : h / 2;
    ctx.fillStyle = '#f3dca6';
    ctx.font = `600 ${titleSize}px Cinzel, Georgia, serif`;
    ctx.fillText(title, w / 2, titleY, w - 40);
    ctx.fillStyle = '#cdbb98';
    ctx.font = `500 ${lineSize}px "IBM Plex Mono", monospace`;
    lines.forEach((l, i) => ctx.fillText(l, w / 2, titleY + titleSize * 0.7 + lineSize * (i + 0.75), w - 40));
    this.texture.needsUpdate = true;
  }

  clear() {
    this.last = '';
  }
}

/** A camera-facing label: a sprite carrying a TextPlate, always drawn on top. */
export class Label {
  readonly plate: TextPlate;
  readonly sprite: THREE.Sprite;

  constructor(width = 512, height = 160) {
    this.plate = new TextPlate(width, height);
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.plate.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.sprite.renderOrder = 20;
    this.sprite.visible = false;
  }

  /** Place at `at` (world), sized to keep the same angular size from `eye`, nudged up by `lift` heights. */
  place(at: THREE.Vector3, eye: THREE.Vector3, angular: number, lift = 0.8) {
    const h = at.distanceTo(eye) * angular;
    this.sprite.scale.set(h * this.plate.aspect, h, 1);
    this.sprite.position.copy(at);
    this.sprite.position.y += h * lift;
  }
}
