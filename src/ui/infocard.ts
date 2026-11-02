import { planetPosition, cometPosition, orbitalPeriodDays, PLANET_ELEMENTS, type PlanetId } from '../astro/orbits';
import { COMETS } from '../astro/bodies';
import type { Body } from '../scene/bodies';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const AU_KM = 149_597_870.7;
const LIGHT_S_PER_AU = 499.004784;
const nf = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

function duration(days: number) {
  const a = Math.abs(days);
  if (a >= 365.25 * 2) return `${nf(a / 365.25, 1)} years`;
  if (a >= 2) return `${nf(a, 1)} days`;
  return `${nf(a * 24, 1)} hours`;
}

function lightTime(au: number) {
  const s = au * LIGHT_S_PER_AU;
  if (s < 90) return `${nf(s, 0)} s`;
  if (s < 5400) return `${nf(s / 60, 1)} min`;
  return `${nf(s / 3600, 1)} h`;
}

function helio(id: string, date: Date) {
  if (id in PLANET_ELEMENTS) return planetPosition(id as PlanetId, date);
  const comet = COMETS.find((c) => c.id === id);
  return comet ? cometPosition(comet.elements, date) : null;
}

export class InfoCard {
  private el = $('info');
  private body: Body | null = null;
  private lastRender = 0;

  constructor(onClose: () => void) {
    $('info-close').addEventListener('click', onClose);
  }

  show(body: Body, simMs: number) {
    this.body = body;
    this.el.hidden = false;
    $('info-name').textContent = body.name;
    $('info-kind').textContent = body.facts?.kind ?? 'Periodic comet';
    $('info-blurb').textContent = body.facts?.blurb ?? body.blurb ?? '';
    this.render(simMs, true);
  }

  hide() {
    this.body = null;
    this.el.hidden = true;
  }

  /** Refresh live figures a few times a second. */
  update(simMs: number) {
    if (!this.body) return;
    const t = performance.now();
    if (t - this.lastRender < 250) return;
    this.lastRender = t;
    this.render(simMs, false);
  }

  private render(simMs: number, _full: boolean) {
    const body = this.body!;
    const date = new Date(simMs);
    const rows: [string, string][] = [];
    const f = body.facts;

    if (body.id === 'sun') {
      const earth = planetPosition('earth', date);
      rows.push(['Radius', `${nf(f!.radiusKm)} km`]);
      rows.push(['From Earth', `${nf(earth.r, 4)} AU`]);
      rows.push(['Light time', lightTime(earth.r)]);
      rows.push(['Rotation', duration(f!.rotationHours / 24)]);
    } else {
      const p = helio(body.id, date);
      const earth = planetPosition('earth', date);
      if (p) {
        rows.push(['From Sun', `${nf(p.r, 3)} AU`]);
        if (body.id !== 'earth') {
          const dE = Math.hypot(p.x - earth.x, p.y - earth.y, p.z - earth.z);
          rows.push(['From Earth', `${nf(dE, 3)} AU`]);
          rows.push(['Light time', lightTime(dE)]);
        } else {
          rows.push(['Distance', `${nf((p.r * AU_KM) / 1e6, 2)} M km`]);
        }
        rows.push(['Longitude', `${nf((p.lon * 180) / Math.PI, 1)}°`]);
      }
      if (body.id in PLANET_ELEMENTS) {
        const a = PLANET_ELEMENTS[body.id as PlanetId].a[0];
        rows.push(['Year', duration(orbitalPeriodDays(a))]);
      } else {
        const c = COMETS.find((x) => x.id === body.id);
        if (c) {
          const a = c.elements.q / (1 - c.elements.e);
          rows.push(['Orbit', duration(orbitalPeriodDays(a))]);
          rows.push(['Perihelion', `${nf(c.elements.q, 3)} AU`]);
        }
      }
      if (f) {
        rows.push(['Day', `${duration(Math.abs(f.rotationHours) / 24)}${f.rotationHours < 0 ? ' (retro)' : ''}`]);
        rows.push(['Radius', `${nf(f.radiusKm)} km`]);
        rows.push(['Axial tilt', `${nf(f.tiltDeg, 1)}°`]);
        if (f.moons !== null) rows.push(['Moons', String(f.moons)]);
      }
    }

    const dl = $('info-stats');
    dl.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
  }
}
