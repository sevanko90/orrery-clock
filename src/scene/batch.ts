import * as THREE from 'three/webgpu';
import { batchIndirectIndex, int, ivec2, materialMetalness, materialRoughness, materialEmissive, texture, textureLoad, uv, vec4 } from 'three/tsl';
import type { TextureLayers } from './textureLayers';
import { lodChain, registerLod, type LodLevel } from './lod';
import { sphereLevels } from './meshLod';
import { LOD_HYSTERESIS } from '../xr/scrunch';

/** Layer the batched originals move to: kept for their transforms, never drawn themselves. */
export const BATCHED_LAYER = 6;

/** Every mesh currently drawn through a batch (so the detail culler leaves its layers alone). */
export const batchedMeshes = new WeakSet<THREE.Object3D>();

/**
 * How an instance's own material is drawn by its batch:
 * - 'same': the batch uses that very material (the desktop path: one batch per material).
 * - 'std': a shared MeshStandard batch material; colour, roughness, metalness and emissive come per instance.
 * - 'basic': a shared MeshBasic batch material; colour and opacity come per instance.
 */
type Kind = 'same' | 'std' | 'basic';

interface Entry {
  mesh: THREE.Mesh;
  batch: THREE.BatchedMesh;
  group: Group;
  id: number;
  /** The material the instance was batched with (another one on the mesh sends it back to drawing alone). */
  material: THREE.Material;
  transparent: boolean;
  /** Its material's shading class when batched ('' for 'same'), its map, and the material version last checked. */
  shade: string;
  map: THREE.Texture | null;
  version: number;
  /** The material still belongs to its batch's class (rechecked when its version changes). */
  fits: boolean;
  /** Bounding sphere radius in the mesh's own space, for culling small details. */
  radius: number;
  centre: THREE.Vector3;
  /** With LODs: each level's geometry id in the batch and its switch distance; and the level drawn. */
  lods?: { id: number; from: number }[];
  level: number;
  /** Drawing alone for now (its material no longer matches its batch's). */
  out: boolean;
  /** Last per-instance values written (colour + opacity, params), to upload only on change. */
  last: Float32Array;
  /** Drawing alone because the eye is too near for its texture layer (with hysteresis). */
  near: boolean;
}

interface Group {
  batch: THREE.BatchedMesh;
  /** What its members share (for the measuring tools). */
  key: string;
  kind: Kind;
  /** Per-instance roughness, metalness and emissive ('std' only): two RGBA float texels per instance. */
  params: THREE.DataTexture | null;
  /** Upload the colours / params this frame. */
  dirty: boolean;
}

export interface BatcherOptions {
  /** Skip these meshes (left drawn on their own). */
  skip?: (m: THREE.Mesh) => boolean;
  /** Use registered distance LODs (lod.ts) for geometries that have them (VR scrunch only). */
  lod?: boolean;
  /**
   * VR scrunch: batch by shading model instead of by material. Plain
   * MeshStandard materials that differ only in colour, roughness, metalness
   * and emissive share one batch (those values go per instance, so each part
   * shades exactly as before), as do plain MeshBasic ones, opaque or
   * transparent (colour and opacity per instance; the batch sorts its
   * transparent instances back to front).
   */
  uber?: boolean;
  /** No shadow map in use: shadow flags don't split batches. */
  noShadows?: boolean;
  /**
   * Pixels per radian of the view, for handing a globe drawn from a texture
   * layer back to its own map when near (see TextureLayers.aloneWithin).
   */
  pxPerRad?: number;
}

const MAP_KEYS = ['map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'envMap'] as const;
/** Node overrides that make a material its own shader (never shared). */
const NODE_KEYS = ['colorNode', 'opacityNode', 'positionNode', 'normalNode', 'emissiveNode', 'roughnessNode', 'metalnessNode', 'outputNode', 'fragmentNode', 'vertexNode', 'castShadowNode', 'receivedShadowNode', 'maskNode', 'alphaTestNode', 'aoNode', 'envNode', 'mrtNode', 'backdropNode', 'geometryNode', 'depthNode'];

/**
 * The shading class of a material for an uber batch: materials with equal
 * keys draw identically given the per-instance values. Null when it can't
 * share (node materials, custom shaders, unusual types).
 */
export function shadeKey(mat: THREE.Material): { key: string; kind: Kind } | null {
  const m = mat as unknown as Record<string, unknown> & THREE.MeshStandardMaterial;
  if ((m as unknown as { isNodeMaterial?: boolean }).isNodeMaterial) return null;
  const std = m.isMeshStandardMaterial && !(m as unknown as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial;
  const basic = (m as unknown as THREE.MeshBasicMaterial).isMeshBasicMaterial;
  if (!std && !basic) return null;
  for (const k of NODE_KEYS) if (m[k]) return null;
  // Own overrides of the shader setup (sunlit bodies) share only when tagged with what they do.
  const sunlit = (m.userData as { sunlit?: string }).sunlit;
  for (const k of ['setupLightingModel', 'setupEnvironment', 'setupLights', 'setup', 'onBeforeCompile']) {
    if (Object.prototype.hasOwnProperty.call(m, k) && !sunlit) return null;
  }
  if (m.lightsNode && !sunlit) return null;
  if (!basic && m.transparent) return null;
  // A map kept in a layer of a shared array texture (textureLayers.ts) doesn't split batches.
  const layers = (m.userData as { layers?: TextureLayers }).layers;
  const maps = MAP_KEYS.map((k) => (k === 'map' && layers ? `layers:${layers.id}` : ((m[k] as THREE.Texture | null | undefined)?.uuid ?? '-'))).join(',');
  const common = [m.side, m.vertexColors, m.fog, m.wireframe, m.alphaTest, m.transparent, m.blending, m.depthTest, m.depthWrite, m.colorWrite, m.toneMapped, m.premultipliedAlpha, m.dithering, m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits, m.alphaToCoverage, m.blendSrc, m.blendDst, m.blendEquation, maps];
  if (basic) {
    const b = m as unknown as THREE.MeshBasicMaterial;
    // Opaque ones keep their opacity in the key (it isn't per instance there).
    return { key: ['basic', ...common, b.transparent ? '' : b.opacity, b.reflectivity, b.refractionRatio, b.combine, b.aoMapIntensity, b.lightMapIntensity].join('|'), kind: 'basic' };
  }
  return {
    key: ['std', ...common, m.opacity, m.flatShading, m.envMapIntensity, m.normalMapType, m.normalScale.x, m.normalScale.y, m.bumpScale, m.aoMapIntensity, m.lightMapIntensity, m.displacementScale, m.displacementBias, sunlit ?? '', (m.lightsNode as { id?: number } | null)?.id ?? ''].join('|'),
    kind: 'std',
  };
}

/** The shared material for an uber batch, made from one of its members. */
function uberMaterial(src: THREE.Material, kind: Kind, params: THREE.DataTexture | null): THREE.Material {
  if (kind === 'basic') {
    const b = (src as THREE.MeshBasicMaterial).clone();
    b.color.set(1, 1, 1);
    if (b.transparent) b.opacity = 1;
    b.name = `uber-${src.name || 'basic'}`;
    return b;
  }
  // As the renderer would convert it (property by property), then the
  // per-instance values replace the material's own.
  const m = new THREE.MeshStandardNodeMaterial();
  const from = src as unknown as Record<string, unknown>;
  const to = m as unknown as Record<string, unknown>;
  for (const k in from) if (k !== '_listeners' && k !== 'uuid' && k !== 'version') to[k] = from[k];
  (m as { uuid: string }).uuid = THREE.MathUtils.generateUUID();
  m.userData = { ...src.userData };
  // (New objects: the copied ones are the source material's own.)
  m.color = new THREE.Color(1, 1, 1);
  m.roughness = 1;
  m.metalness = 1;
  m.emissive = new THREE.Color(1, 1, 1);
  m.emissiveIntensity = 1;
  const id = int(batchIndirectIndex).mul(2);
  const w = params!.image.width;
  const p0 = textureLoad(params!, ivec2(id.mod(w), id.div(w)));
  const id1 = id.add(1);
  const p1 = textureLoad(params!, ivec2(id1.mod(w), id1.div(w)));
  m.roughnessNode = materialRoughness.mul(p0.x);
  m.metalnessNode = materialMetalness.mul(p0.y);
  m.emissiveNode = materialEmissive.mul(p1.xyz);
  const layers = (src.userData as { layers?: TextureLayers }).layers;
  if (layers) {
    // The surface map from the instance's layer of the shared array (white for none).
    m.map = null;
    m.colorNode = vec4(texture(layers.texture, uv()).depth(int(p0.z)));
  }
  m.name = `uber-${src.name || 'standard'}`;
  m.needsUpdate = true;
  return m;
}

/** Width of the per-instance params texture (two texels per instance). */
const PARAMS_W = 1024;

/**
 * Draws many meshes as a few. Every opaque mesh under the roots is grouped
 * with the others sharing its material (and shadow settings and attribute
 * layout) into one BatchedMesh, drawn in a single call per group. The
 * original meshes stay where they are as invisible handles: the scene's
 * animation code keeps moving and hiding them as before, and each frame
 * `sync()` copies their world matrices and visibility into the batches.
 * Same geometry, same materials, same look; far fewer draw calls, which is
 * what a headset's CPU runs out of.
 *
 * Transparent meshes stay separate (they need sorting against each other),
 * as do invisible pick proxies, multi-material, instanced and skinned meshes.
 * (With `uber`, see BatcherOptions.)
 */
export class Batcher {
  readonly batches: THREE.BatchedMesh[] = [];
  private groups: Group[] = [];
  private entries: Entry[] = [];
  private tmp = new THREE.Vector3();
  private uber: boolean;
  private pxPerRad: number;

  constructor(
    roots: THREE.Object3D | THREE.Object3D[],
    private parent: THREE.Object3D,
    options: BatcherOptions = {},
  ) {
    const skip = options.skip ?? (() => false);
    this.uber = !!options.uber;
    this.pxPerRad = options.pxPerRad ?? 720;
    const groups = new Map<string, { kind: Kind; key: string; meshes: THREE.Mesh[] }>();
    for (const root of Array.isArray(roots) ? roots : [roots]) {
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.BatchedMesh).isBatchedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
        if (Array.isArray(m.material) || batchedMeshes.has(m)) return;
        const mat = m.material as THREE.Material;
        if (!mat.visible || skip(m)) return;
        const shade = this.uber ? shadeKey(mat) : null;
        if (mat.transparent && !shade) return;
        // (Draw groups don't matter with a single material: the whole geometry is drawn.)
        if (Object.keys(m.geometry.morphAttributes).length) return;
        const g = m.geometry;
        const attrs = Object.entries(g.attributes)
          .map(([k, a]) => `${k}:${(a as THREE.BufferAttribute).itemSize}:${(a as THREE.BufferAttribute).normalized}`)
          .sort()
          .join(',');
        const shadow = options.noShadows ? '' : `${m.castShadow}|${m.receiveShadow}`;
        const key = [shade?.key ?? mat.uuid, shadow, m.renderOrder, attrs].join('|');
        const list = groups.get(key);
        if (list) list.meshes.push(m);
        else groups.set(key, { kind: shade?.kind ?? 'same', key, meshes: [m] });
      });
    }

    for (const { kind, key, meshes: list } of groups.values()) {
      if (list.length < 2) continue;
      // Each distinct geometry is stored once; meshes sharing it become instances.
      // A batch is all indexed or all not: give unindexed shapes a plain index when they're mixed.
      const distinct = [...new Set(list.map((m) => m.geometry))];
      const chains = new Map<THREE.BufferGeometry, LodLevel[]>();
      if (options.lod) {
        // Lit spheres (moons) step down in segments as MeshLods would step them alone.
        if (kind === 'std') for (const g of distinct) if (isFullSphere(g) && !lodChain(g)) registerLod(g, () => sphereLevels(g as THREE.SphereGeometry).slice(1).map(({ geometry, error }) => ({ geometry, error })));
        for (const g of distinct) {
          const c = lodChain(g);
          if (c) chains.set(g, c);
        }
      }
      // With LODs, level 0 is the chain's indexed copy of the original.
      const level0 = (g: THREE.BufferGeometry) => chains.get(g)?.[0].geometry ?? g;
      const extra = [...chains.values()].flatMap((c) => c.slice(1).map((l) => l.geometry));
      const all = [...distinct.map(level0), ...extra];
      const anyIndexed = all.some((g) => g.index);
      const asStored = new Map(all.map((g) => [g, anyIndexed && !g.index ? withIndex(g) : g]));
      const geos = [...asStored.values()];
      const vertices = geos.reduce((n, g) => n + g.attributes.position.count, 0);
      const indices = geos.reduce((n, g) => n + (g.index?.count ?? 0), 0);
      const first = list[0];
      const firstMat = first.material as THREE.Material;
      const params =
        kind === 'std'
          ? new THREE.DataTexture(new Float32Array(PARAMS_W * Math.ceil((list.length * 2) / PARAMS_W) * 4), PARAMS_W, Math.ceil((list.length * 2) / PARAMS_W), THREE.RGBAFormat, THREE.FloatType)
          : null;
      const material = kind === 'same' ? firstMat : uberMaterial(firstMat, kind, params);
      const batch = new THREE.BatchedMesh(list.length, vertices, indices || undefined, material);
      batch.castShadow = first.castShadow;
      batch.receiveShadow = first.receiveShadow;
      batch.renderOrder = first.renderOrder;
      batch.name = `batch-${kind === 'same' ? firstMat.name || first.name || 'mesh' : material.name}`;
      // Instances move every frame; the batch's own bounds would be stale, so cull per instance only.
      batch.frustumCulled = false;
      batch.perObjectFrustumCulled = true;
      // Never hit by rays: picking goes to the originals (see raycastLayers()).
      batch.raycast = () => undefined;
      const group: Group = { batch, key, kind, params, dirty: true };
      const stored = new Map<THREE.BufferGeometry, number>();
      for (const [g, s] of asStored) stored.set(g, batch.addGeometry(s));
      const lodIds = new Map([...chains].map(([g, c]) => [g, c.map((l) => ({ id: stored.get(l.geometry)!, from: l.from }))]));
      for (const m of list) {
        const id = batch.addInstance(stored.get(level0(m.geometry))!);
        batch.setMatrixAt(id, m.matrixWorld);
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const s = m.geometry.boundingSphere!;
        const mat = m.material as THREE.Material;
        const e: Entry = { mesh: m, batch, group, id, material: mat, transparent: mat.transparent, shade: kind === 'same' ? '' : shadeKey(mat)!.key, map: (mat as THREE.MeshBasicMaterial).map ?? null, version: mat.version, fits: true, radius: s.radius, centre: s.center.clone(), lods: lodIds.get(m.geometry), level: 0, out: false, last: new Float32Array(kind === 'same' ? 0 : 10).fill(NaN), near: false };
        this.entries.push(e);
        if (kind !== 'same') this.writeInstance(e);
        m.layers.set(BATCHED_LAYER);
        batchedMeshes.add(m);
      }
      this.groups.push(group);
      this.batches.push(batch);
      parent.add(batch);
    }
  }

  /** How many meshes are drawn through batches, and in how many batches. */
  get stats() {
    return { meshes: this.entries.length, batches: this.batches.length };
  }

  /** Copy an uber instance's material values (colour, opacity, params) into its batch, if they changed. */
  private writeInstance(e: Entry) {
    const mat = e.material as THREE.MeshStandardMaterial;
    const l = e.last;
    const c = mat.color;
    const a = e.group.kind === 'basic' && mat.transparent ? mat.opacity : 1;
    if (c.r !== l[0] || c.g !== l[1] || c.b !== l[2] || a !== l[3]) {
      l[0] = c.r;
      l[1] = c.g;
      l[2] = c.b;
      l[3] = a;
      e.batch.setColorAt(e.id, vec4Tmp.set(c.r, c.g, c.b, a));
    }
    const p = e.group.params;
    if (!p) return;
    const ei = mat.emissiveIntensity;
    const em = mat.emissive;
    const layer = Math.max(0, (mat.userData as { layers?: TextureLayers }).layers?.layerOf(mat) ?? 0);
    if (mat.roughness !== l[4] || mat.metalness !== l[5] || em.r * ei !== l[6] || em.g * ei !== l[7] || em.b * ei !== l[8] || layer !== l[9]) {
      l[9] = layer;
      l[4] = mat.roughness;
      l[5] = mat.metalness;
      l[6] = em.r * ei;
      l[7] = em.g * ei;
      l[8] = em.b * ei;
      const d = p.image.data as Float32Array;
      const o = e.id * 8;
      d[o] = l[4];
      d[o + 1] = l[5];
      d[o + 2] = l[9];
      d[o + 4] = l[6];
      d[o + 5] = l[7];
      d[o + 6] = l[8];
      e.group.dirty = true;
    }
  }

  /**
   * Copy the originals' world matrices and visibility into the batches. Call
   * after the scene's world matrices are up to date. With an eye and an angle,
   * also skip instances smaller than that angle from the eye. With `lodEye`,
   * draw each instance that has LODs at the level its distance from there allows.
   */
  sync(eye?: THREE.Vector3, minAngle = 0, lodEye?: THREE.Vector3) {
    const cull = !!eye && minAngle > 0;
    for (const e of this.entries) {
      let visible = true;
      if (this.uber) {
        // A material swapped or turned transparent: draw the original alone until it's back.
        const mat = e.mesh.material as THREE.Material;
        if (e.shade && (mat.version !== e.version || ((mat as THREE.MeshBasicMaterial).map ?? null) !== e.map)) {
          // Changed (a map arrived, say): is it still the same kind of material?
          e.version = mat.version;
          e.map = (mat as THREE.MeshBasicMaterial).map ?? null;
          e.fits = shadeKey(mat)?.key === e.shade;
        }
        // A globe whose map isn't in its layer yet, or that is too near for the layer's detail, draws alone.
        const layers = (mat.userData as { layers?: TextureLayers }).layers;
        if (layers && e.fits && lodEye) {
          const lay = layers.layerOf(mat);
          let near = false;
          if (lay > 0) {
            const el = e.mesh.matrixWorld.elements;
            const sc = Math.sqrt(Math.max(el[0] * el[0] + el[1] * el[1] + el[2] * el[2], el[4] * el[4] + el[5] * el[5] + el[6] * el[6], el[8] * el[8] + el[9] * el[9] + el[10] * el[10]));
            const k = layers.aloneWithin(this.pxPerRad) * e.radius * sc * (e.near ? 1 + LOD_HYSTERESIS : 1 - LOD_HYSTERESIS);
            near = this.tmp.copy(e.centre).applyMatrix4(e.mesh.matrixWorld).distanceTo(lodEye) < k;
          }
          e.near = near || lay < 0;
        }
        const out = mat !== e.material || mat.transparent !== e.transparent || !e.fits || e.near;
        if (out !== e.out) {
          e.out = out;
          e.mesh.layers.set(out ? 0 : BATCHED_LAYER);
          if (out) batchedMeshes.delete(e.mesh);
          else batchedMeshes.add(e.mesh);
        }
        visible = !out && mat.visible;
        if (visible && e.group.kind !== 'same') this.writeInstance(e);
      }
      for (let o: THREE.Object3D | null = e.mesh; visible && o && o !== this.parent; o = o.parent) {
        if (!o.visible) visible = false;
      }
      if (visible && (cull || (lodEye && e.lods))) {
        const m = e.mesh.matrixWorld.elements;
        const scale = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
        const at = this.tmp.copy(e.centre).applyMatrix4(e.mesh.matrixWorld);
        const r = e.radius * scale;
        if (cull) visible = r > at.distanceTo(eye!) * minAngle;
        if (visible && lodEye && e.lods) {
          // Nearest point of the bounds, in the mesh's own units (errors are measured there).
          const d = Math.max(0, at.distanceTo(lodEye) - r) / scale;
          const lods = e.lods;
          let l = e.level;
          while (l + 1 < lods.length && d >= lods[l + 1].from * (1 + LOD_HYSTERESIS)) l++;
          while (l > 0 && d < lods[l].from * (1 - LOD_HYSTERESIS)) l--;
          if (l !== e.level) {
            e.level = l;
            e.batch.setGeometryIdAt(e.id, lods[l].id);
          }
        }
      }
      e.batch.setVisibleAt(e.id, visible);
      if (visible) e.batch.setMatrixAt(e.id, e.mesh.matrixWorld);
    }
    for (const g of this.groups) {
      if (g.dirty && g.params) g.params.needsUpdate = true;
      g.dirty = false;
    }
  }

  /** How many instances are drawn at each LOD level (for the readout and telemetry). */
  lodCounts() {
    const counts: number[] = [];
    for (const e of this.entries) if (e.lods) counts[e.level] = (counts[e.level] ?? 0) + 1;
    return Array.from(counts, (c) => c ?? 0);
  }

  /** Every batched original, its batch and instance id, and the LOD level drawn. */
  instances(): readonly { mesh: THREE.Mesh; batch: THREE.BatchedMesh; id: number; level: number }[] {
    return this.entries;
  }

  /** Is this mesh drawn through a batch? */
  has(mesh: THREE.Object3D) {
    return mesh.layers.isEnabled(BATCHED_LAYER) && !mesh.layers.isEnabled(0);
  }

  /** Put every original back to drawing on its own and drop the batches. */
  dispose() {
    for (const e of this.entries) {
      e.mesh.layers.set(0);
      batchedMeshes.delete(e.mesh);
    }
    for (const g of this.groups) {
      this.parent.remove(g.batch);
      g.batch.dispose();
      if (g.kind !== 'same') (g.batch.material as THREE.Material).dispose();
      g.params?.dispose();
    }
    this.entries = [];
    this.groups = [];
    this.batches.length = 0;
  }
}

const vec4Tmp = new THREE.Vector4();

function isFullSphere(g: THREE.BufferGeometry) {
  if (g.type !== 'SphereGeometry') return false;
  const p = (g as THREE.SphereGeometry).parameters;
  return p.phiLength >= Math.PI * 2 - 1e-6 && p.thetaLength >= Math.PI - 1e-6 && p.widthSegments > 16;
}

/** A copy of an unindexed geometry with a plain 0..n−1 index. */
function withIndex(g: THREE.BufferGeometry) {
  const c = g.clone();
  const n = g.attributes.position.count;
  c.setIndex(Array.from({ length: n }, (_, i) => i));
  return c;
}

/** Make a raycaster also hit batched originals (they sit on their own layer). */
export function raycastLayers(raycaster: THREE.Raycaster) {
  raycaster.layers.enable(BATCHED_LAYER);
  return raycaster;
}
