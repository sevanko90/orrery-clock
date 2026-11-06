/**
 * `?seed=N` (debug): make Math.random repeatable, so two page loads (an A/B
 * pair such as ?scrunch=0 and ?scrunch=1) build the same stars, particles and
 * elephant poses and their frames can be diffed pixel for pixel. Imported
 * first, before anything draws a random number.
 *
 * three draws a random number for every object's UUID, so a build that makes
 * more objects (the scrunched one makes LOD geometries) shifts the stream:
 * `reseed(tag)` restarts it before each randomised part of the scene.
 */
const seed = Number(new URLSearchParams(location.search).get('seed'));
let s = seed >>> 0;

/** Restart the seeded stream for a named part of the scene (no-op without ?seed). */
export function reseed(tag: string) {
  if (!(seed > 0)) return;
  let h = seed >>> 0;
  for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193) >>> 0;
  s = h;
}

if (seed > 0) {
  // mulberry32
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
