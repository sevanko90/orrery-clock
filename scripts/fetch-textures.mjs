// Downloads planet textures from Wikimedia Commons and writes web-ready
// WebP variants (256px placeholder, 2K, and 4K where the source allows) to
// public/textures/. Raw downloads are cached in .texture-cache/ (gitignored).
//
// Run inside the dev container:  npm run textures
// Only some of them:              npm run textures -- moon io europa

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.texture-cache');
const OUT = path.join(ROOT, 'public', 'textures');
const UA = 'orrery-clock-texture-fetch/0.1 (static hobby site build script)';

/** name -> Commons file title, plus per-texture options */
const TEXTURES = {
  sun: { file: 'Solarsystemscope texture 8k sun.jpg' },
  mercury: { file: 'Solarsystemscope texture 8k mercury.jpg' },
  venus: { file: 'Solarsystemscope texture 4k venus atmosphere.jpg' },
  earth: { file: 'Solarsystemscope texture 8k earth daymap.jpg' },
  'earth-clouds': { file: 'Solarsystemscope texture 2k earth clouds.jpg', grey: true, quality: 55 },
  mars: { file: 'Solarsystemscope texture 8k mars.jpg' },
  jupiter: { file: 'Solarsystemscope texture 8k jupiter.jpg' },
  saturn: { file: 'Solarsystemscope texture 8k saturn.jpg' },
  'saturn-ring': { file: 'Solarsystemscope texture 8k saturn ring alpha.png', strip: true },
  uranus: { file: 'Solarsystemscope texture 2k uranus.jpg' },
  neptune: { file: 'Solarsystemscope texture 2k neptune.jpg' },
  pluto: { file: 'Pluto color mapmosaic.jpg' },
  stars: { file: 'Solarsystemscope texture 2k stars milky way.jpg' },

  // Moons: small on screen, so a 256px placeholder and a 1K map are plenty.
  moon: { file: 'Solarsystemscope texture 8k moon.jpg', moon: true },
  phobos: { file: 'Phobos map by Askaniy.png', moon: true },
  deimos: { file: 'Deimos map by Askaniy.png', moon: true },
  io: { file: 'Io map projection PIA00319.jpg', moon: true },
  europa: { file: 'Europa Voyager GalileoSSI global mosaic.jpg', moon: true },
  ganymede: { file: 'Ganymede map by Askaniy.png', moon: true },
  callisto: { file: 'Callisto map by Askaniy.png', moon: true },
  mimas: { file: 'Mimas Color Map.jpg', moon: true },
  enceladus: { file: 'Enceladus Color Map.jpg', moon: true },
  tethys: { file: 'Tethys Color Map.jpg', moon: true },
  dione: { file: 'Dione Color Map.jpg', moon: true },
  rhea: { file: 'Rhea Color Map.jpg', moon: true },
  iapetus: { file: 'Iapetus Color Map.jpg', moon: true },
  miranda: { file: 'Miranda map JPL USGS.jpg', moon: true },
  ariel: { file: 'Ariel map JPL USGS.jpg', moon: true },
  umbriel: { file: 'Umbriel map JPL USGS.jpg', moon: true },
  titania: { file: 'Titania map JPL USGS.jpg', moon: true },
  oberon: { file: 'Oberon map JPL USGS.jpg', moon: true },
  triton: { file: 'Triton map no grid.jpg', moon: true },
  charon: { file: 'Charon map iau1803c.jpg', moon: true },
  // Fiction mode: Ceres Station. Solar System Scope's artist's impression.
  ceres: { file: 'Solarsystemscope texture 4k ceres fictional.jpg', moon: true },
};

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function commonsInfo(title) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    titles: `File:${title}`,
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    format: 'json',
  }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Commons API ${res.status} for ${title}`);
  const json = await res.json();
  const page = Object.values(json.query.pages)[0];
  const info = page.imageinfo?.[0];
  if (!info) throw new Error(`No imageinfo for ${title}`);
  const meta = info.extmetadata ?? {};
  const strip = (s) => (s ?? '').replace(/<[^>]+>/g, '').trim();
  return {
    url: info.url.split('?')[0],
    width: info.width,
    descriptionUrl: info.descriptionurl,
    license: strip(meta.LicenseShortName?.value),
    artist: strip(meta.Artist?.value),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, dest) {
  if (await exists(dest)) return readFile(dest);
  // Be polite to Wikimedia: space requests out and honour Retry-After on 429.
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2000);
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 15 * (attempt + 1);
      console.log(`rate limited, waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Download ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    return buf;
  }
  throw new Error(`Gave up after repeated 429s for ${url}`);
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });
  // Named textures only (others keep their existing credits entry).
  const only = process.argv.slice(2);
  const creditsPath = path.join(OUT, 'credits.json');
  const previous = only.length && (await exists(creditsPath)) ? JSON.parse(await readFile(creditsPath, 'utf8')) : [];
  const fresh = new Map();

  for (const [name, opt] of Object.entries(TEXTURES)) {
    if (only.length && !only.includes(name)) continue;
    const info = await commonsInfo(opt.file);
    const raw = await download(info.url, path.join(CACHE, path.basename(info.url)));
    fresh.set(name, { name, title: opt.file, ...info });

    // Saturn's ring is a 1-pixel-meaningful radial strip: keep the alpha
    // channel and only scale the long axis.
    const sizes = opt.strip
      ? [{ suffix: '2k', width: 2048, height: 64 }]
      : opt.moon
        ? [
            { suffix: '256', width: 256 },
            { suffix: '1k', width: 1024 },
          ]
        : [{ suffix: '256', width: 256 }, { suffix: '2k', width: 2048 }, ...(info.width >= 4096 ? [{ suffix: '4k', width: 4096 }] : [])];

    for (const s of sizes) {
      let img = sharp(raw).resize({
        width: s.width,
        height: s.height ?? s.width / 2,
        fit: 'fill',
        kernel: 'lanczos3',
      });
      if (opt.grey) img = img.greyscale();
      const quality = opt.quality ?? { 256: 60, '1k': 78, '2k': 76, '4k': 72 }[s.suffix];
      const out = path.join(OUT, `${name}-${s.suffix}.webp`);
      await img.webp({ quality, alphaQuality: 90, effort: 6 }).toFile(out);
      console.log('wrote', path.relative(ROOT, out));
    }
  }

  // Keep credits in TEXTURES order, whether or not each was refetched this run.
  const old = new Map(previous.map((c) => [c.name, c]));
  const credits = Object.keys(TEXTURES)
    .map((name) => fresh.get(name) ?? old.get(name))
    .filter(Boolean);
  await writeFile(creditsPath, JSON.stringify(credits, null, 2) + '\n');
  console.log('wrote public/textures/credits.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
