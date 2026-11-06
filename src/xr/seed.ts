/**
 * `?seed=N` (debug): make Math.random repeatable, so two page loads (an A/B
 * pair such as ?scrunch=0 and ?scrunch=1) build the same stars, particles and
 * elephant poses and their frames can be diffed pixel for pixel. Imported
 * first, before anything draws a random number.
 */
const seed = Number(new URLSearchParams(location.search).get('seed'));
if (seed > 0) {
  let s = seed >>> 0;
  // mulberry32
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export {};
