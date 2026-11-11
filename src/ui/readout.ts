import { julianDate } from '../astro/time';
import { localSiderealHours, moonPhase, sunTimes } from '../astro/sky';
import { placeFromTimezone, requestPreciseLocation, type Place } from '../astro/location';
import { SPEED_STEPS, type SimClock } from '../sim/clock';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const simFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const hmFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** Year-safe formatting (Intl handles years 1000–2999 fine; guard anyway). */
function fmtSim(d: Date) {
  try {
    return simFmt.format(d);
  } catch {
    return d.toISOString();
  }
}

function hms(hours: number) {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  const s = Math.floor(((hours - h) * 60 - m) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** SVG path for the lit part of the Moon, given phase 0..1. */
function moonPath(phase: number, r = 10) {
  const k = Math.cos(phase * 2 * Math.PI); // 1 new → −1 full
  const waxing = phase < 0.5;
  // Outer limb: right half when waxing, left half when waning.
  const sweepOuter = waxing ? 1 : 0;
  const rx = Math.abs(k) * r;
  // Terminator bulges toward the lit side when gibbous.
  const sweepInner = k > 0 === waxing ? 0 : 1;
  return `M0,${-r} A${r},${r} 0 0 ${sweepOuter} 0,${r} A${rx},${r} 0 0 ${sweepInner} 0,${-r} Z`;
}

export class Readout {
  private place: Place = placeFromTimezone();
  private lastSecond = -1;
  private lastAlmanacKey = '';

  constructor(private clock: SimClock) {
    const toggle = $<HTMLButtonElement>('r-toggle');
    const extras = $('r-extras');
    const collapsed = safeGet('almanac-collapsed') === '1' || innerWidth < 720;
    const setOpen = (open: boolean) => {
      toggle.setAttribute('aria-expanded', String(open));
      extras.hidden = !open;
    };
    setOpen(!collapsed);
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      setOpen(open);
      safeSet('almanac-collapsed', open ? '0' : '1');
    });

    const locate = $<HTMLButtonElement>('r-locate');
    locate.addEventListener('click', async () => {
      locate.disabled = true;
      locate.textContent = 'Locating…';
      try {
        this.place = await requestPreciseLocation();
        locate.hidden = true;
      } catch (e) {
        locate.textContent = 'Location unavailable';
        console.warn(e);
        setTimeout(() => {
          locate.textContent = 'Use my location';
          locate.disabled = false;
        }, 3000);
        return;
      }
      this.lastAlmanacKey = '';
      this.renderAlmanac(new Date(this.clock.nowMs()));
    });

    $('r-moon').innerHTML = '<circle r="10"/><path d=""/>';
  }

  update() {
    const now = new Date();
    const sec = Math.floor(now.getTime() / 1000);
    const live = this.clock.isLive();
    const simMs = this.clock.nowMs();
    const sim = new Date(simMs);

    if (sec !== this.lastSecond) {
      this.lastSecond = sec;
      $('r-time').textContent = timeFmt.format(now);
      $('r-date').textContent = dateFmt.format(now);
    }

    const simEl = $('r-sim');
    simEl.hidden = live;
    if (!live) {
      $('r-sim-date').textContent = fmtSim(sim);
      $('r-sim-speed').textContent = SPEED_STEPS[this.clock.step].label;
    }

    // Almanac reflects the date the orrery is showing.
    this.renderAlmanac(live ? now : sim);
  }

  private renderAlmanac(d: Date) {
    const lst = localSiderealHours(d, this.place.lon);
    $('r-lst').textContent = hms(lst);
    $('r-jd').textContent = julianDate(d).toFixed(4);

    // Moon & sun change slowly: recompute when the minute or place changes.
    const key = `${Math.floor(d.getTime() / 60000)}|${this.place.lat}|${this.place.lon}`;
    if (key === this.lastAlmanacKey) return;
    this.lastAlmanacKey = key;

    const m = moonPhase(d);
    $('r-moon').querySelector('path')!.setAttribute('d', moonPath(m.phase));
    $('r-moon-text').textContent = `${m.name} · ${Math.round(m.illumination * 100)}%`;

    const t = sunTimes(d, this.place.lat, this.place.lon);
    const approx = this.place.approximate ? '≈ ' : '';
    if (t.kind === 'normal') {
      $('r-rise').textContent = approx + hmFmt.format(t.sunrise!);
      $('r-set').textContent = approx + hmFmt.format(t.sunset!);
    } else {
      const label = t.kind === 'polar-day' ? 'Midnight sun' : 'Polar night';
      $('r-rise').textContent = label;
      $('r-set').textContent = '—';
    }
    $('r-place').textContent = this.place.approximate ? `${this.place.label} (from time zone)` : this.place.label;
  }
}

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
