import * as THREE from 'three/webgpu';
import type { CardContent } from '../ui/infocard';
import { FADE_S } from './controlPanel';

/**
 * The info card in VR: what the desktop card shows (name, kind, blurb, live
 * figures) on an engraved brass-and-ink panel, like the wrist box. It opens
 * in front of the player, a little below eye level, and stays put in the
 * player's space (it's parented to the rig, so it travels with them). Point
 * at the close mark and pull the trigger to dismiss it.
 */
export class InfoPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private content: (() => CardContent) | null = null;
  private last = '';
  private closeLit = false;
  private refreshAt = 0;
  /** Shown amount, easing to `wanted` over FADE_S. */
  private fade = 0;
  private wanted = 0;
  /** Canvas height in use (px): the card is cut to its content. */
  private used = 1024;
  private static W = 768;
  private static H = 1024;
  /** The close mark: centre and radius (canvas px). */
  private static CLOSE = { x: 768 - 70, y: 70, r: 34 };

  /** @param height physical height (metres) */
  constructor(height = 0.44) {
    this.canvas.width = InfoPanel.W;
    this.canvas.height = InfoPanel.H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      // (Pivot at the top edge: the card is cut to its content from the bottom.)
      new THREE.PlaneGeometry((height * InfoPanel.W) / InfoPanel.H, height).translate(0, -height / 2, 0),
      // Over everything, like the wrist box: it's the thing being read.
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 27;
    this.mesh.name = 'info-panel';
    this.mesh.visible = false;
  }

  get open() {
    return this.wanted === 1;
  }

  /**
   * Open showing `content` (called again a few times a second for live
   * figures), in front of `camera` within `rig` (whose units are metres).
   */
  show(content: () => CardContent, rig: THREE.Object3D, camera: THREE.Camera) {
    this.content = content;
    this.last = '';
    if (this.mesh.parent !== rig) rig.add(this.mesh);
    // Camera pose in the rig's space (metres): ahead on the horizontal, a little low.
    const head = camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    this.mesh.position.copy(head).addScaledVector(fwd, 0.85);
    this.mesh.position.y = head.y + 0.1;
    this.mesh.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    // Tilted back a touch, like a lectern.
    this.mesh.rotateX(-0.15);
    this.wanted = 1;
    this.mesh.visible = true;
    this.redraw();
  }

  /** Fade away (the content stays until it has). */
  hide() {
    this.wanted = 0;
    this.closeLit = false;
  }

  /** Per frame: ease the fade, and refresh the live figures four times a second. */
  update(dt: number) {
    this.fade = THREE.MathUtils.clamp(this.fade + (this.wanted ? dt : -dt) / FADE_S, 0, 1);
    this.mesh.material.opacity = this.fade;
    this.mesh.visible = this.fade > 0.001;
    if (!this.mesh.visible) this.content = null;
    if (!this.open) return;
    const t = performance.now();
    if (t < this.refreshAt) return;
    this.refreshAt = t + 250;
    this.redraw();
  }

  /** Test a ray: the hit if it lands on the card (and whether it's on the close mark). */
  hit(raycaster: THREE.Raycaster): { hit: THREE.Intersection; close: boolean } | null {
    if (!this.open) return null;
    const h = raycaster.intersectObject(this.mesh, false)[0];
    const close = !!h?.uv && this.onClose(h.uv);
    if (close !== this.closeLit) {
      this.closeLit = close;
      this.last = '';
      this.redraw();
    }
    return h ? { hit: h, close } : null;
  }

  private onClose(uv: THREE.Vector2) {
    const { x, y, r } = InfoPanel.CLOSE;
    return Math.hypot(uv.x * InfoPanel.W - x, (1 - uv.y) * this.used - y) < r * 1.4;
  }

  private redraw() {
    if (!this.content) return;
    const c = this.content();
    const key = JSON.stringify([c, this.closeLit]);
    if (key === this.last) return;
    this.last = key;
    const { ctx } = this;
    const W = InfoPanel.W,
      H = InfoPanel.H,
      pad = 56;
    ctx.clearRect(0, 0, W, H);

    // Close mark.
    const { x: cx, y: cy, r: cr } = InfoPanel.CLOSE;
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.fillStyle = this.closeLit ? '#e8c06a' : '#3a2810';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#d6aa5c';
    ctx.stroke();
    ctx.strokeStyle = this.closeLit ? '#2a1a08' : '#f3dca6';
    ctx.lineWidth = 5;
    ctx.beginPath();
    const k = cr * 0.42;
    ctx.moveTo(cx - k, cy - k);
    ctx.lineTo(cx + k, cy + k);
    ctx.moveTo(cx + k, cy - k);
    ctx.lineTo(cx - k, cy + k);
    ctx.stroke();

    let y = pad + 40;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f3dca6';
    ctx.font = '600 56px Cinzel, Georgia, serif';
    ctx.fillText(c.name, pad, y, W - pad * 2 - 80);
    y += 46;
    ctx.fillStyle = '#d6aa5c';
    ctx.font = 'italic 32px Georgia, serif';
    ctx.fillText(c.kind, pad, y, W - pad * 2);
    y += 24;
    ctx.fillStyle = 'rgba(214, 170, 92, 0.5)';
    ctx.fillRect(pad, y, W - pad * 2, 2);
    y += 52;

    // The figures, two columns.
    ctx.font = '500 30px "IBM Plex Mono", monospace';
    for (const [k2, v] of c.rows) {
      ctx.fillStyle = '#a8977a';
      ctx.textAlign = 'left';
      ctx.fillText(k2, pad, y, W * 0.4);
      ctx.fillStyle = '#f0e2c4';
      ctx.textAlign = 'right';
      ctx.fillText(v, W - pad, y, W * 0.5);
      y += 44;
    }
    ctx.textAlign = 'left';
    y += 18;

    // The blurb, wrapped, as much as fits.
    if (c.blurb) {
      ctx.fillStyle = 'rgba(214, 170, 92, 0.5)';
      ctx.fillRect(pad, y - 26, W - pad * 2, 2);
      y += 20;
      ctx.fillStyle = '#d9cbb0';
      ctx.font = '30px Georgia, serif';
      const lineH = 40;
      for (const line of wrap(ctx, c.blurb, W - pad * 2)) {
        if (y > H - pad) break;
        ctx.fillText(line, pad, y);
        y += lineH;
      }
    }

    // The card is as tall as its content: draw the plate behind it, and show only that much of the canvas.
    const used = Math.min(H, Math.ceil(y - 10 + pad * 0.6));
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 220, 150, 0.45)';
    ctx.beginPath();
    ctx.roundRect(24, 24, W - 48, used - 48, 24);
    ctx.stroke();
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#b8893e';
    ctx.beginPath();
    ctx.roundRect(6, 6, W - 12, used - 12, 34);
    ctx.stroke();
    ctx.fillStyle = 'rgba(16, 11, 6, 0.92)';
    ctx.fill();
    ctx.restore();
    this.used = used;
    const f = used / H;
    this.texture.repeat.set(1, f);
    this.texture.offset.set(0, 1 - f);
    // Shrink from the top edge down, so the card's top stays where it opened.
    this.mesh.scale.y = f;
    this.texture.needsUpdate = true;
  }
}

/** Break `text` into lines no wider than `width` in the context's current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
