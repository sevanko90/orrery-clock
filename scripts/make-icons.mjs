// Renders the PNG app icons from public/icon.svg (run after changing the SVG: npm run icons).
// Install prompts and Android/Quest packaging want PNGs; SVG alone isn't enough everywhere.
//  - icon-192.png, icon-512.png: the icon as drawn (rounded corners), purpose "any".
//  - icon-maskable-512.png: square, full-bleed background, purpose "maskable" (the system crops it
//    to its own shape). The artwork already sits inside the 80% safe zone, so only the corners change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const pub = join(import.meta.dirname, '..', 'public');
const svg = readFileSync(join(pub, 'icon.svg'), 'utf8');
const square = svg.replace(/<rect([^>]*?)\s+rx="[^"]*"/, '<rect$1');
if (square === svg) throw new Error('icon.svg: expected a background <rect rx="…"> to square off');

const render = (source, size, file) =>
  sharp(Buffer.from(source), { density: (72 * size) / 64 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(pub, file))
    .then(() => console.log(`wrote public/${file}`));

await Promise.all([render(svg, 192, 'icon-192.png'), render(svg, 512, 'icon-512.png'), render(square, 512, 'icon-maskable-512.png')]);
