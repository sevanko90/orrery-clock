import * as THREE from 'three/webgpu';

/**
 * VR scrunch: the planets' and moons' surface maps as layers of one array
 * texture, so every globe can be drawn by one batch (each instance reads its
 * own layer) instead of one draw call each.
 *
 * Each tracked material gets a layer; whenever its map changes (the
 * progressive loader swapping in a sharper tier) the map is drawn into the
 * layer, scaled to the layer size. Layer 0 is white, for globes without a
 * map. The layer is coarser than a globe's own map close up, so the batch
 * hands a globe back to its own material (and map) when it is near enough
 * for the difference to reach a pixel: see `aloneWithin`.
 */
export class TextureLayers {
  readonly texture: THREE.DataArrayTexture;
  readonly id = THREE.MathUtils.generateUUID();
  private layers = new Map<THREE.Material, { layer: number; map: THREE.Texture | null; copied: boolean }>();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly capacity: number,
  ) {
    const data = new Uint8Array(width * height * 4 * capacity);
    data.fill(255, 0, width * height * 4);
    this.texture = new THREE.DataArrayTexture(data, width, height, capacity);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = 8;
    this.texture.needsUpdate = true;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  /** Give a material a layer (if there is room); false if full. */
  track(mat: THREE.Material): boolean {
    if (this.layers.has(mat)) return true;
    const layer = this.layers.size + 1;
    if (layer >= this.capacity) return false;
    this.layers.set(mat, { layer, map: null, copied: false });
    mat.userData.layers = this;
    return true;
  }

  /** The layer a material reads (0, white, until its map is in). */
  layerOf(mat: THREE.Material): number {
    const l = this.layers.get(mat);
    const map = (mat as THREE.MeshStandardMaterial).map;
    if (!l || !map) return 0;
    return l.copied && l.map === map ? l.layer : -1;
  }

  /** Copy maps that changed into their layers (call once a frame; cheap when nothing changed). */
  update() {
    let changed = false;
    for (const [mat, l] of this.layers) {
      const map = (mat as THREE.MeshStandardMaterial).map;
      if (map === l.map) continue;
      const img = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
      if (map && !img?.width) continue; // not loaded yet
      l.map = map;
      l.copied = false;
      if (!map) continue;
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.drawImage(img!, 0, 0, this.width, this.height);
      const px = this.ctx.getImageData(0, 0, this.width, this.height).data;
      const size = this.width * this.height * 4;
      // Canvas rows run top down, texture rows bottom up (as the maps are uploaded, flipY).
      const data = this.texture.image.data as Uint8Array;
      const row = this.width * 4;
      const base = l.layer * size;
      const flip = map.flipY;
      for (let y = 0; y < this.height; y++) {
        const src = (flip ? this.height - 1 - y : y) * row;
        data.set(px.subarray(src, src + row), base + y * row);
      }
      this.texture.addLayerUpdate(l.layer);
      l.copied = true;
      changed = true;
    }
    if (changed) this.texture.needsUpdate = true;
  }

  /** Bytes held (CPU copy; the GPU holds as much again plus a third for mipmaps). */
  get bytes() {
    return this.width * this.height * 4 * this.capacity;
  }

  /**
   * Distance (in globe radii, from its centre) inside which a globe drawn
   * from a layer shows coarser detail than its own map would: the layer's
   * texel at the globe's centre, 2πr / width, grows past a pixel, d / f.
   */
  aloneWithin(pxPerRad: number) {
    return (2 * Math.PI * pxPerRad) / this.width;
  }
}
