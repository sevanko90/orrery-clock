/**
 * Fiction mode: events and places from science fiction, set in the real
 * Solar System. Dated events play out on the simulated timeline; places are
 * always on show while the mode is on. Blurbs are our own summaries.
 */

const DAY = 86_400_000;

export interface FictionEntry {
  id: string;
  title: string;
  /** Source work, author / franchise and year. */
  source: string;
  blurb: string;
  /** Dated events recur or happen on set dates; places are always shown. */
  kind: 'event' | 'place';
  /** Dated events: how long one showing lasts, from its start. */
  durationMs?: number;
  /** Dated events: how far before the start a replay begins (default 6 h). */
  leadMs?: number;
  /** Dated events: replay speed, simulated seconds per second (default a day a second). */
  playSpeed?: number;
  /**
   * Recurring events: how often they come round (ms). An event that would
   * come round more often than once a minute of the viewer's time at the
   * clock's speed is skipped (see MIN_REAL_GAP_S); a replay always plays.
   */
  periodMs?: number;
  /** Entries sharing a group are listed together under its name in the catalogue. */
  group?: string;
}

// ---- The War of the Worlds -----------------------------------------------------

/** Ten nights of firing, one cylinder a night. */
export const WOTW_SHOTS = 10;
/** Artistic licence: the novel never says how long the crossing takes. */
export const WOTW_FLIGHT_DAYS = 20;
/** Length of one year's show, from the first flash to the last landing (plus the dust settling). */
export const WOTW_SPAN_MS = (WOTW_SHOTS - 1 + WOTW_FLIGHT_DAYS + 1.5) * DAY;

/** Local midnight starting 12 August of the given year: the first flash. */
export function wotwStart(year: number): number {
  return new Date(year, 7, 12, 0, 0, 0).getTime();
}

/** The show running at `ms`, or the next one to come. */
export function wotwOccurrence(ms: number): number {
  const year = new Date(ms).getFullYear();
  const start = wotwStart(year);
  return ms <= start + WOTW_SPAN_MS ? start : wotwStart(year + 1);
}

export const WAR_OF_THE_WORLDS: FictionEntry = {
  id: 'wotw',
  periodMs: 365.2425 * DAY,
  title: 'The War of the Worlds',
  source: 'H. G. Wells · 1898',
  kind: 'event',
  durationMs: WOTW_SPAN_MS,
  blurb:
    'Near midnight on the twelfth of August, astronomers see jets of luminous green gas burst from Mars, one a night for ten nights. ' +
    'Each is a vast gun firing a cylinder at Earth; the cylinders fall on the Surrey commons, and the Martians climb out. ' +
    'Here the volley repeats every August. (The novel never says how long the crossing takes; the orrery allows twenty days.)',
};

// ---- Utopia Planitia -------------------------------------------------------------

/** Longitude (°E) of Utopia Planitia, the shipyard's station above Mars. */
export const UTOPIA_LONGITUDE = 118;

export const UTOPIA_PLANITIA: FictionEntry = {
  id: 'utopia',
  title: 'Utopia Planitia Fleet Yards',
  source: 'Star Trek',
  kind: 'place',
  blurb:
    'Starfleet’s great shipyard, building starships in orbit above the Utopia Planitia plain on Mars. ' +
    'On this orrery a brass drydock keeps station over the plain, a hull taking shape inside its frame.',
};

// ---- Space: 1999 -------------------------------------------------------------------

/** The waste dumps go up on 13 September 1999 (the hour is ours). */
export const BREAKAWAY = Date.UTC(1999, 8, 13, 21, 0);
/** From the blast until the Moon is lost to sight. */
export const BREAKAWAY_DAYS = 1.25;

export const SPACE_1999: FictionEntry = {
  id: 'space1999',
  title: 'Breakaway',
  source: 'Space: 1999 · 1975',
  kind: 'event',
  durationMs: BREAKAWAY_DAYS * DAY,
  leadMs: 2 * 3_600_000,
  playSpeed: 3600,
  blurb:
    'On 13 September 1999 the nuclear waste stored on the Moon explodes. The blast tears the Moon out of Earth orbit ' +
    'and flings it off into deep space, carrying the 311 people of Moonbase Alpha with it. ' +
    'Here the Moon is back in its orbit once the scene has played.',
};

// ---- Interstellar ---------------------------------------------------------------------

export const WORMHOLE: FictionEntry = {
  id: 'wormhole',
  title: 'The Wormhole',
  source: 'Interstellar · 2014',
  kind: 'place',
  blurb:
    'A wormhole that appears near Saturn, placed there, it seems, by someone who wants humanity to survive. ' +
    'It looks like a sphere in space, showing a distorted view of another galaxy; the Endurance flies through it in search of a new home.',
};

// ---- The Hitchhiker's Guide to the Galaxy ----------------------------------------------

const HOUR = 3_600_000;
/** The demolition's timetable, in hours from the fleet's arrival (Thursday 08:00 local). */
export const VOGON = {
  /** Ships in formation over Earth; the announcement begins. */
  inPlace: 1.5,
  /** Demolition beams lock on. */
  beams: 1.75,
  /** 10:00: Earth goes. */
  demolish: 2,
  /** The fleet leaves (15 minutes after) and the bypass opens. */
  depart: 2.25,
  /** Earth restored, ready for next week. */
  end: 4,
};

/** Thursday 08:00 local of the week containing `ms` (weeks run Thursday to Wednesday). */
function thursdayArrival(ms: number): number {
  const d = new Date(ms);
  const back = (d.getDay() - 4 + 7) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 8, 0, 0).getTime();
}

/** The demolition running at `ms`, or the next one (fleet arrival time). */
export function vogonOccurrence(ms: number): number {
  const start = thursdayArrival(ms);
  if (ms <= start + VOGON.end * HOUR) return start;
  const next = new Date(start);
  next.setDate(next.getDate() + 7);
  return next.getTime();
}

export const VOGON_DEMOLITION: FictionEntry = {
  id: 'vogons',
  periodMs: 7 * DAY,
  title: 'The Demolition of Earth',
  source: 'The Hitchhiker’s Guide to the Galaxy · Douglas Adams',
  kind: 'event',
  durationMs: VOGON.end * HOUR,
  leadMs: 0.25 * HOUR,
  playSpeed: 600,
  blurb:
    'One Thursday a Vogon constructor fleet arrives over Earth, announces that the planet is in the way of a new ' +
    'hyperspace express route, and demolishes it. The plans had been on display at the local planning office in ' +
    'Alpha Centauri for fifty years, so nobody has any grounds for complaint. Here it happens every Thursday at ten, ' +
    'and Earth is back by lunchtime.',
};

// ---- Project Hail Mary -----------------------------------------------------------------

export const PETROVA_LINE: FictionEntry = {
  id: 'petrova',
  title: 'The Petrova Line',
  source: 'Project Hail Mary · Andy Weir',
  kind: 'place',
  blurb:
    'Astrophage: single-celled life that feeds on starlight, migrating from the surface of the Sun to Venus to breed, ' +
    'and back again. The stream shows up as a faint infrared line between the two, and the Sun is slowly growing dimmer for it.',
};

// ---- The Expanse ------------------------------------------------------------------------

const EXPANSE = 'The Expanse';
const EXPANSE_SOURCE = 'The Expanse · James S. A. Corey';

/** Real orbits for Ceres and Eros (JPL Small-Body Database, epoch JD 2461200.5). */
export const CERES_ORBIT = { q: 2.55, e: 0.0797, i: 10.6, node: 80.2, argPeri: 73.3, perihelionJD: 2461599.841 };
export const EROS_ORBIT = { q: 1.13, e: 0.223, i: 10.8, node: 304, argPeri: 179, perihelionJD: 2461088.813 };
/** Tycho Station keeps to the Belt; where in it is our choice. */
export const TYCHO_ORBIT = { a: 2.6, i: 3, lonAtJ2000: 140 };
/** The Ring sits still, beyond the orbit of Uranus. */
export const RING_GATE_AT = { au: 24, lonDeg: 200 };

export const CERES_STATION: FictionEntry = {
  id: 'ceres',
  title: 'Ceres Station',
  source: EXPANSE_SOURCE,
  kind: 'place',
  group: EXPANSE,
  blurb:
    'The dwarf planet Ceres, spun up for gravity and tunnelled out into the Belt’s great port: millions of Belters, ' +
    'docks crowded with ships, and an economy running on water and ice. It follows Ceres’s real orbit here.',
};

export const EROS: FictionEntry = {
  id: 'eros',
  title: 'Eros',
  source: EXPANSE_SOURCE,
  kind: 'place',
  group: EXPANSE,
  blurb:
    'A near-Earth asteroid with a station full of people, until the protomolecule is let loose on them. ' +
    'Then the asteroid itself starts to change, glowing with something that is not human. It follows Eros’s real orbit here.',
};

export const TYCHO_STATION: FictionEntry = {
  id: 'tycho',
  title: 'Tycho Station',
  source: EXPANSE_SOURCE,
  kind: 'place',
  group: EXPANSE,
  blurb:
    'A vast construction platform out in the Belt, home of Tycho Manufacturing, whose yards built the generation ship Nauvoo. ' +
    'A spinning habitat ring around a central sphere, its booms always holding some hull under construction.',
};

export const RING_GATE: FictionEntry = {
  id: 'ring',
  title: 'The Ring Gate',
  source: EXPANSE_SOURCE,
  kind: 'place',
  group: EXPANSE,
  blurb:
    'An alien ring, built from what the protomolecule made of Venus, that flew out and stopped beyond the orbit of Uranus. ' +
    'Through it lies the slow zone, and beyond that over a thousand more gates to other stars.',
};

export const FICTION: FictionEntry[] = [
  WAR_OF_THE_WORLDS,
  SPACE_1999,
  VOGON_DEMOLITION,
  UTOPIA_PLANITIA,
  WORMHOLE,
  PETROVA_LINE,
  CERES_STATION,
  EROS,
  TYCHO_STATION,
  RING_GATE,
];

/**
 * Fewest real seconds between showings of a recurring event: at a clock speed
 * that would bring it round more often (the Demolition every 7 s at a day a
 * second), it's skipped as noise. Each event's own period sets where it
 * drops out, so no event needs special handling.
 */
export const MIN_REAL_GAP_S = 60;

/** Would a recurring event come round too often to show at `speed` (sim seconds per second)? */
export function tooFrequent(entry: FictionEntry, speed: number) {
  return !!entry.periodMs && speed !== 0 && entry.periodMs / 1000 / Math.abs(speed) < MIN_REAL_GAP_S;
}

/** Start of the dated event at or after `ms`, or the one-off date (null for places). */
export function nextOccurrence(entry: FictionEntry, ms: number): number | null {
  if (entry.id === WAR_OF_THE_WORLDS.id) return wotwOccurrence(ms);
  if (entry.id === SPACE_1999.id) return BREAKAWAY;
  if (entry.id === VOGON_DEMOLITION.id) return vogonOccurrence(ms);
  return null;
}
