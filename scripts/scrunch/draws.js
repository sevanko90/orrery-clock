// Draw-call census for the VR scrunch (round 2: draw calls are the cost).
// In the page (served by the dev server), from the console or automation:
//   const d = await import('/scripts/scrunch/draws.js');
//   await d.ready();                 // Discworld assembled, clock frozen at the measure date
//   await d.census('rim')            // { draws, scene, bySystem, rows }
//   await d.all()                    // spawn, rim, hub, far
// Every draw the renderer issues in one frame is logged (hooking the
// renderer's per-object draw), and tagged by subsystem. `scene` leaves out
// the desktop-only post passes (bloom, output), which a multiview headset
// frame doesn't have.
const D = () => window.orreryDebug;

export async function ready(ms = 6000) {
  while (!window.orreryDebug) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, ms));
  D().scrunch.freeze(true);
  await D().scrunch.frames(5);
}

export async function census(view, pitch) {
  const d = D();
  const R = d.stage.renderer;
  if (view) d.vr.view(view, pitch);
  await d.scrunch.frames(6);
  const roots = Object.entries({
    movement: d.orrery.mechanism.root,
    orrery: d.orrery.root,
    bodies: d.bodies.root,
    discworld: d.discworld()?.root,
    fiction: d.fiction()?.root,
  }).filter(([, r]) => r);
  const log = [];
  const orig = R._renderObjectDirect;
  R._renderObjectDirect = function (object, material, scene, camera, l, group, cc, passId) {
    let sys = 'other';
    const names = [];
    for (let o = object; o; o = o.parent) {
      const h = roots.find(([, r]) => r === o);
      if (h) {
        sys = h[0];
        break;
      }
      if (o.name && names.length < 2) names.push(o.name);
    }
    log.push(`${sys}|${names.join('<')}|${object.type}:${object.geometry?.type}|${material.name || material.type}${material.transparent ? '·T' : ''}${passId ? '·' + passId : ''}`);
    return orig.apply(this, arguments);
  };
  await d.scrunch.frames(1);
  R._renderObjectDirect = orig;
  const rows = {};
  const bySystem = {};
  let scene = 0;
  for (const l of log) {
    if (/Bloom|Render Pipeline/.test(l)) continue;
    scene++;
    rows[l] = (rows[l] || 0) + 1;
    const s = l.split('|')[0];
    bySystem[s] = (bySystem[s] || 0) + 1;
  }
  const info = R.info.render;
  return { view, draws: log.length, scene, triangles: Math.round(info.triangles), bySystem, rows };
}

export async function all(views = ['spawn', 'rim', 'hub', 'far']) {
  const out = {};
  for (const v of views) out[v] = await census(v);
  return out;
}

/** One line per view: scene draws, triangles, per subsystem. */
export function brief(res) {
  return Object.values(res)
    .map((r) => `${r.view} ${r.scene} draws ${r.triangles} tris  ` + Object.entries(r.bySystem).map(([k, n]) => `${k}:${n}`).join(' '))
    .join('\n');
}

/** Rows (draws per kind of object) collapsed for reading. */
export function rows(r, filter = '') {
  return Object.entries(r.rows)
    .filter(([k]) => k.includes(filter))
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k.replace(/Geometry|Material/g, '')}`)
    .join('\n');
}

/**
 * Repeatable A/B frames (load with ?seed=1 and call straight away): the
 * scene steps 1/60 s a frame and freezes at frame `at` on every load, then
 * each viewpoint is captured to .telemetry/captures/<view>-<tag>.png after
 * the textures have settled. Diff with scripts/scrunch/imgdiff.mjs.
 */
export async function shoot(tag, views = ['spawn', 'rim', 'hub', 'far'], at = 1200, settle = 8000) {
  while (!window.orreryDebug) await new Promise((r) => setTimeout(r, 50));
  const s = D().scrunch;
  if (s.ticks >= at) throw new Error(`too late: frame ${s.ticks}`);
  s.dt = function () {
    this.ticks++;
    if (this.ticks >= at) this.frozen = true;
    return this.frozen ? 0 : this.fixedDt ?? 1 / 60;
  };
  while (!s.frozen) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, settle));
  const out = [];
  for (const v of views) {
    D().vr.view(v);
    await s.frames(8);
    out.push(await s.capture(`${v}-${tag}`));
  }
  return out;
}
