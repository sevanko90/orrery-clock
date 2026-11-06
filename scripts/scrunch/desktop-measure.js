// Desktop A/B measurement for the VR scrunch: paste into the browser console
// (or run through browser automation) on each of
//   http://localhost:5181/?webgl=1&headset=1&vrview=1&seed=1&scrunch=0
//   http://localhost:5181/?webgl=1&headset=1&vrview=1&seed=1&scrunch=1
// within ~5 s of the page loading (seeded runs act on fixed frame numbers).
// Plain-HTTP dev server for this: docker compose run -d --rm --name orrery-check
//   -p 5181:5181 -e HTTPS=0 app npx vite --port 5181 --host 0.0.0.0
// Frames land in .telemetry/captures/; diff them with
//   docker compose exec app node scripts/scrunch/imgdiff.mjs a.png b.png [heat.png] [l,t,w,h]
// Load each URL twice to get the noise floor (same build vs itself).
(async () => {
  while (!window.orreryDebug) await new Promise((r) => setTimeout(r, 100));
  const s = orreryDebug.scrunch;
  const tag = `s${s.on ? 1 : 0}${location.search.includes('b=1') ? 'b' : ''}`;
  await s.setup('marker1');
  await new Promise((r) => setTimeout(r, 3000)); // textures settle
  await s.capture(`m1-${tag}`);
  const m1 = s.inventory();
  s.pose('marker2');
  await s.frames(10);
  await s.capture(`m2-${tag}`);
  const m2 = s.inventory();
  const pick = (i) => ({ total: i.total, bySystem: i.bySystem, renderer: i.renderer, lod: i.lod, pxPerRad: i.pxPerRad });
  console.log(JSON.stringify({ tag, marker1: pick(m1), marker2: pick(m2) }));
  return { tag, marker1: pick(m1), marker2: pick(m2) };
})();
