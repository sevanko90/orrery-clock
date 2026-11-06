// Frame diff for the VR scrunch A/B (run in the app container):
//   node scripts/scrunch/imgdiff.mjs a.png b.png [heat.png] [left,top,width,height]
// Prints PSNR, mean |Δ|, share of pixels changed beyond 8 and 32 levels
// (max channel), and SSIM on luma (8×8 windows, stride 4). Optional heat map
// (|Δ| × 8). Both frames must be the same size.
import sharp from 'sharp';

const [a, b, heatArg, cropArg] = process.argv.slice(2);
const heat = heatArg && heatArg !== '-' ? heatArg : null;
const crop = cropArg ? (([left, top, width, height]) => ({ left, top, width, height }))(cropArg.split(',').map(Number)) : null;
const load = async (p) => {
  let img = sharp(p);
  if (crop) img = img.extract(crop);
  const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
};
const A = await load(a);
const B = await load(b);
if (A.w !== B.w || A.h !== B.h) throw new Error(`size mismatch ${A.w}x${A.h} vs ${B.w}x${B.h}`);
const n = A.w * A.h;
let se = 0, ae = 0, over8 = 0, over32 = 0;
const lumA = new Float32Array(n), lumB = new Float32Array(n);
const hm = heat ? Buffer.alloc(n * 3) : null;
for (let i = 0; i < n; i++) {
  let mx = 0;
  for (let c = 0; c < 3; c++) {
    const d = A.data[i * 3 + c] - B.data[i * 3 + c];
    se += d * d;
    ae += Math.abs(d);
    mx = Math.max(mx, Math.abs(d));
    if (hm) hm[i * 3 + c] = Math.min(255, Math.abs(d) * 8);
  }
  if (mx > 8) over8++;
  if (mx > 32) over32++;
  lumA[i] = 0.299 * A.data[i * 3] + 0.587 * A.data[i * 3 + 1] + 0.114 * A.data[i * 3 + 2];
  lumB[i] = 0.299 * B.data[i * 3] + 0.587 * B.data[i * 3 + 1] + 0.114 * B.data[i * 3 + 2];
}
const mse = se / (n * 3);
const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
let ssim = 0, win = 0;
for (let y = 0; y + 8 <= A.h; y += 4) {
  for (let x = 0; x + 8 <= A.w; x += 4) {
    let ma = 0, mb = 0;
    for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) { const i = (y + j) * A.w + x + k; ma += lumA[i]; mb += lumB[i]; }
    ma /= 64; mb /= 64;
    let va = 0, vb = 0, cov = 0;
    for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) { const i = (y + j) * A.w + x + k; const da = lumA[i] - ma, db = lumB[i] - mb; va += da * da; vb += db * db; cov += da * db; }
    va /= 63; vb /= 63; cov /= 63;
    ssim += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    win++;
  }
}
const out = {
  a, b, crop, size: [A.w, A.h],
  psnr: mse === 0 ? Infinity : +(10 * Math.log10((255 * 255) / mse)).toFixed(2),
  meanAbs: +(ae / (n * 3)).toFixed(4),
  changedOver8: +((over8 / n) * 100).toFixed(4) + '%',
  changedOver32: +((over32 / n) * 100).toFixed(4) + '%',
  ssim: +(ssim / win).toFixed(5),
};
console.log(JSON.stringify(out));
if (hm) await sharp(hm, { raw: { width: A.w, height: A.h, channels: 3 } }).png().toFile(heat);
