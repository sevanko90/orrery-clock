import * as THREE from 'three/webgpu';
import { PLANE_Y } from '../layout';

export const DAY = 86_400_000;
export const DEG = Math.PI / 180;
export const SUN = new THREE.Vector3(0, PLANE_Y, 0);
export const UP = new THREE.Vector3(0, 1, 0);
export const MARTIAN_GREEN = new THREE.Color(0x7dff8a);

/** Soft white dot; sprites tint it with their material colour. */
let dotTexture: THREE.Texture | null = null;
function softDot() {
  if (dotTexture) return dotTexture;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  dotTexture = new THREE.CanvasTexture(c);
  dotTexture.colorSpace = THREE.SRGBColorSpace;
  return dotTexture;
}

export function glow(color: THREE.ColorRepresentation, opacity = 1) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: softDot(),
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  s.renderOrder = 4;
  return s;
}

export function pickProxy(radius: number) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
}

export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Apex at the origin, opening along −y to a rim of radius 1 at y = −1. */
export const CONE = new THREE.ConeGeometry(1, 1, 32, 1, true).translate(0, -0.5, 0);
export const DOWN = new THREE.Vector3(0, -1, 0);

let softPanel: THREE.CanvasTexture | null = null;
/** A rounded panel with soft edges, as an alpha map (white opaque, fading to black at the rim). */
export function softPanelTexture() {
  if (softPanel) return softPanel;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 104;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.filter = 'blur(10px)';
  g.fillStyle = '#fff';
  g.beginPath();
  g.roundRect(22, 22, c.width - 44, c.height - 44, 18);
  g.fill();
  softPanel = new THREE.CanvasTexture(c);
  return softPanel;
}
