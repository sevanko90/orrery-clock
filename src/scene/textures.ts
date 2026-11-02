import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const base = import.meta.env.BASE_URL;

export type TextureTier = '256' | '2k' | '4k';

function url(name: string, tier: TextureTier) {
  return `${base}textures/${name}-${tier}.webp`;
}

function load(name: string, tier: TextureTier, colorSpace: THREE.ColorSpace): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      url(name, tier),
      (t) => {
        t.colorSpace = colorSpace;
        t.anisotropy = 8;
        resolve(t);
      },
      undefined,
      reject,
    );
  });
}

/**
 * Progressive texture: assigns a tiny placeholder immediately, then swaps in
 * the full map. `upgrade()` can later fetch the 4K version (e.g. on focus).
 */
export class ProgressiveTexture {
  private tier: TextureTier | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private name: string,
    private apply: (tex: THREE.Texture) => void,
    private colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
    private has4k = true,
    private hasPlaceholder = true,
  ) {}

  async start(full: TextureTier): Promise<void> {
    if (this.hasPlaceholder) await this.set('256').catch(() => undefined);
    await this.set(full).catch((e) => console.warn(`texture ${this.name}`, e));
  }

  upgrade(): Promise<void> {
    if (!this.has4k || this.tier === '4k') return Promise.resolve();
    this.pending ??= this.set('4k').catch((e) => console.warn(`texture ${this.name} 4k`, e));
    return this.pending;
  }

  private async set(tier: TextureTier) {
    const tex = await load(this.name, tier, this.colorSpace);
    const rank = { '256': 0, '2k': 1, '4k': 2 };
    if (this.tier && rank[this.tier] >= rank[tier]) {
      tex.dispose();
      return;
    }
    this.tier = tier;
    this.apply(tex);
  }
}

export function loadOnce(name: string, tier: TextureTier, colorSpace = THREE.SRGBColorSpace) {
  return load(name, tier, colorSpace);
}
