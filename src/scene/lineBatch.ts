import * as THREE from 'three/webgpu';

/** Layer the merged originals move to: kept as handles for their animation, never drawn themselves. */
export const LINE_BATCHED_LAYER = 9;

interface Item {
  line: THREE.Line;
  /** First vertex of its segments in the merged buffer, and how many vertices. */
  at: number;
  count: number;
  /** Segment end points in the line's own space (pairs). */
  local: Float32Array;
  /** Last world matrix and colour written (to rewrite only on change). */
  matrix: Float32Array;
  rgba: Float32Array;
  shown: boolean;
  /** Position attribute version the segments were read at. */
  version: number;
  /** Its geometry changed shape: drawn on its own from then on. */
  out: boolean;
}

interface Bucket {
  items: Item[];
  /** Drawn on its first frames even with nothing shown, so its shader is built at once, not on first use. */
  warm: number;
  lines: THREE.LineSegments;
  position: THREE.BufferAttribute;
  color: THREE.BufferAttribute;
}

/**
 * Draws many thin lines as one (VR scrunch): the moons' orbit rings, the
 * comet and Pluto orbits, fiction's flight paths, ~25 lines each its own
 * draw call. Lines sharing a blend state are gathered into one
 * LineSegments in world space with a per-vertex colour and opacity, so a
 * line's own colour and opacity, and its visibility, carry over each frame.
 * Positions are rewritten only for lines that moved. The originals stay in
 * the scene (on a layer nobody draws) so the scene code keeps moving them.
 *
 * The lines are faint and depth-write-free, so drawing them together rather
 * than each sorted on its own changes nothing but the order they blend in
 * where two cross, under a percent of their own faint colour.
 */
export class LineBatch {
  private buckets: Bucket[] = [];

  constructor(
    roots: THREE.Object3D[],
    private parent: THREE.Object3D,
  ) {
    const groups = new Map<string, THREE.Line[]>();
    for (const root of roots) {
      root.traverse((o) => {
        const l = o as THREE.Line;
        if (!l.isLine || l.layers.isEnabled(LINE_BATCHED_LAYER)) return;
        const m = l.material as THREE.LineBasicMaterial;
        if (Array.isArray(l.material) || !m.isLineBasicMaterial || (m as unknown as { isLineDashedMaterial?: boolean }).isLineDashedMaterial) return;
        if ((m as unknown as { isNodeMaterial?: boolean }).isNodeMaterial || m.map || m.vertexColors || !m.transparent || m.depthWrite) return;
        if (l.geometry.attributes.color || l.geometry.morphAttributes.position) return;
        const key = [m.blending, m.depthTest, m.fog, m.toneMapped, m.linewidth, l.renderOrder, m.premultipliedAlpha].join('|');
        const list = groups.get(key);
        if (list) list.push(l);
        else groups.set(key, [l]);
      });
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const items: Item[] = [];
      let total = 0;
      for (const line of list) {
        const local = segments(line);
        items.push({ line, at: total, count: local.length / 3, local, matrix: new Float32Array(16).fill(NaN), rgba: new Float32Array(4).fill(NaN), shown: false, version: (line.geometry.attributes.position as THREE.BufferAttribute).version, out: false });
        total += local.length / 3;
      }
      const position = new THREE.BufferAttribute(new Float32Array(total * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const color = new THREE.BufferAttribute(new Float32Array(total * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', position);
      geo.setAttribute('color', color);
      const m0 = list[0].material as THREE.LineBasicMaterial;
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        depthTest: m0.depthTest,
        blending: m0.blending,
        fog: m0.fog,
        toneMapped: m0.toneMapped,
        premultipliedAlpha: m0.premultipliedAlpha,
      });
      mat.name = 'line-batch';
      const lines = new THREE.LineSegments(geo, mat);
      lines.name = 'line-batch';
      lines.frustumCulled = false;
      lines.renderOrder = list[0].renderOrder;
      lines.raycast = () => undefined;
      for (const it of items) it.line.layers.set(LINE_BATCHED_LAYER);
      parent.add(lines);
      this.buckets.push({ items, lines, position, color, warm: 3 });
    }
  }

  get size() {
    return this.buckets.reduce((n, b) => n + b.items.length, 0);
  }

  get objects(): THREE.Object3D[] {
    return this.buckets.map((b) => b.lines);
  }

  /** Copy the originals' world positions, colours and visibility (after world matrices are up to date). */
  sync() {
    for (const b of this.buckets) {
      let moved = false;
      let tinted = false;
      const pos = b.position.array as Float32Array;
      const col = b.color.array as Float32Array;
      for (const it of b.items) {
        const m = it.line.material as THREE.LineBasicMaterial;
        const ver = (it.line.geometry.attributes.position as THREE.BufferAttribute).version;
        if (ver !== it.version && !it.out) {
          // Its points were rewritten: take them again, or (a different count) let it draw alone.
          it.version = ver;
          const local = segments(it.line);
          if (local.length === it.local.length) {
            it.local = local;
            it.matrix.fill(NaN);
          } else {
            it.out = true;
            it.line.layers.set(0);
          }
        }
        let shown = !it.out && m.visible && m.opacity > 0;
        for (let o: THREE.Object3D | null = it.line; shown && o && o !== this.parent; o = o.parent) if (!o.visible) shown = false;
        const e = it.line.matrixWorld.elements;
        if (shown && !same(it.matrix, e)) {
          it.matrix.set(e);
          const l = it.local;
          for (let i = 0, j = it.at * 3; i < l.length; i += 3, j += 3) {
            const x = l[i],
              y = l[i + 1],
              z = l[i + 2];
            const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
            pos[j] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
            pos[j + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
            pos[j + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
          }
          moved = true;
        }
        const r = m.color.r,
          g = m.color.g,
          bl = m.color.b,
          a = shown ? m.opacity : 0;
        if (r !== it.rgba[0] || g !== it.rgba[1] || bl !== it.rgba[2] || a !== it.rgba[3]) {
          it.rgba.set([r, g, bl, a]);
          for (let i = 0; i < it.count; i++) col.set(it.rgba, (it.at + i) * 4);
          tinted = true;
        }
        it.shown = shown;
      }
      if (moved) b.position.needsUpdate = true;
      if (tinted) b.color.needsUpdate = true;
      b.lines.visible = b.items.some((it) => it.shown) || b.warm-- > 0;
    }
  }

  /** Put the originals back and drop the merged lines. */
  dispose() {
    for (const b of this.buckets) {
      for (const it of b.items) it.line.layers.set(0);
      this.parent.remove(b.lines);
      b.lines.geometry.dispose();
      (b.lines.material as THREE.Material).dispose();
    }
    this.buckets = [];
  }
}

function same(a: Float32Array, b: ArrayLike<number>) {
  for (let i = 0; i < 16; i++) if (a[i] !== Math.fround(b[i])) return false;
  return true;
}

/** A line's segments as end-point pairs in its own space (strips and loops opened out). */
function segments(line: THREE.Line): Float32Array {
  const g = line.geometry;
  const p = g.attributes.position;
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  const at = (i: number) => (idx ? idx.getX(i) : i);
  const start = g.drawRange.start;
  const end = Math.min(n, g.drawRange.start + g.drawRange.count);
  const out: number[] = [];
  const push = (i: number) => out.push(p.getX(at(i)), p.getY(at(i)), p.getZ(at(i)));
  if ((line as THREE.LineSegments).isLineSegments) {
    for (let i = start; i + 1 < end; i += 2) {
      push(i);
      push(i + 1);
    }
  } else {
    for (let i = start; i + 1 < end; i++) {
      push(i);
      push(i + 1);
    }
    if ((line as THREE.LineLoop).isLineLoop && end - start > 2) {
      push(end - 1);
      push(start);
    }
  }
  return new Float32Array(out);
}
