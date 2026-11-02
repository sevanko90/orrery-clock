import * as THREE from 'three';

/** Small deterministic value-noise helper for procedural textures. */
function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = Float32Array.from({ length: 256 }, () => rand());
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    const xf = x - xi,
      yf = y - yi;
    const h = (i: number, j: number) => grad[perm[(perm[(xi + i) & 255] + yi + j) & 255]];
    const u = fade(xf),
      v = fade(yf);
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(h(0, 0), h(1, 0), u),
      THREE.MathUtils.lerp(h(0, 1), h(1, 1), u),
      v,
    );
  };
}

/** Procedural walnut planks: colour + roughness maps. */
function woodTextures(size: number) {
  const noise = makeNoise(7);
  const color = document.createElement('canvas');
  const rough = document.createElement('canvas');
  color.width = color.height = rough.width = rough.height = size;
  const cctx = color.getContext('2d')!;
  const rctx = rough.getContext('2d')!;
  const cimg = cctx.createImageData(size, size);
  const rimg = rctx.createImageData(size, size);
  const planks = 6;
  const dark = new THREE.Color('#2b1408');
  const mid = new THREE.Color('#6b3a1a');
  const light = new THREE.Color('#a8662f');
  const c = new THREE.Color();

  for (let y = 0; y < size; y++) {
    const plank = Math.floor((y / size) * planks);
    const plankOffset = plank * 37.3;
    const inPlank = ((y / size) * planks) % 1;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const warp = noise(u * 3 + plankOffset, inPlank * 2) * 2.5;
      const grain = Math.sin((inPlank * 4 + warp + noise(u * 20, y * 0.02 + plankOffset) * 0.6) * Math.PI * 2);
      const fine = noise(u * 120, y * 0.25) * 0.18;
      const tone = noise(u * 1.5 + plankOffset, plank) * 0.5;
      let t = 0.5 + 0.28 * grain + fine - 0.15 + tone * 0.4;
      t = THREE.MathUtils.clamp(t, 0, 1);
      c.copy(dark).lerp(mid, Math.min(1, t * 1.6)).lerp(light, Math.max(0, t - 0.6) * 1.2);
      // Plank seams.
      const seam = inPlank < 0.006 || inPlank > 0.994 ? 0.35 : 1;
      const i = (y * size + x) * 4;
      cimg.data[i] = c.r * 255 * seam;
      cimg.data[i + 1] = c.g * 255 * seam;
      cimg.data[i + 2] = c.b * 255 * seam;
      cimg.data[i + 3] = 255;
      const r = 170 + (1 - t) * 50 + (seam < 1 ? 30 : 0);
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = r;
      rimg.data[i + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(rough);
  for (const t of [map, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { map, roughnessMap };
}

/** Faint brushed/worn variation for metals. */
function brushedTexture(size: number) {
  const noise = makeNoise(11);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 0.55 + noise(x * 0.6, y * 0.02) * 0.25 + noise(x * 0.02, y * 0.02) * 0.2;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export interface Materials {
  brass: THREE.MeshStandardMaterial;
  brassDark: THREE.MeshStandardMaterial;
  copper: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  woodEdge: THREE.MeshStandardMaterial;
  felt: THREE.MeshStandardMaterial;
}

export function createMaterials(lowQuality: boolean): Materials {
  const wood = woodTextures(lowQuality ? 512 : 1024);
  const brushed = brushedTexture(256);

  const metal = (color: string, roughness: number) =>
    new THREE.MeshStandardMaterial({
      color,
      metalness: 1,
      roughness,
      roughnessMap: brushed,
    });

  const woodMat = new THREE.MeshStandardMaterial({
    map: wood.map,
    roughnessMap: wood.roughnessMap,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  wood.map.repeat.set(2, 2);
  wood.roughnessMap.repeat.set(2, 2);

  const edgeMap = wood.map.clone();
  edgeMap.repeat.set(10, 0.15);
  edgeMap.needsUpdate = true;

  return {
    brass: metal('#d4a94f', 0.32),
    brassDark: metal('#9b7434', 0.58),
    copper: metal('#c0784a', 0.36),
    steel: metal('#9aa3ab', 0.28),
    // Aged, frosted gilt for the movement plates so bright gears stand out.
    plate: metal('#6b5128', 0.62),
    wood: woodMat,
    woodEdge: new THREE.MeshStandardMaterial({ map: edgeMap, roughness: 0.6, metalness: 0, envMapIntensity: 0.4 }),
    felt: new THREE.MeshStandardMaterial({ color: '#14100c', roughness: 1, metalness: 0 }),
  };
}
