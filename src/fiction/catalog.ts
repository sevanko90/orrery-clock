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

export const FICTION: FictionEntry[] = [WAR_OF_THE_WORLDS, SPACE_1999, UTOPIA_PLANITIA, WORMHOLE];

/** Start of the dated event at or after `ms`, or the one-off date (null for places). */
export function nextOccurrence(entry: FictionEntry, ms: number): number | null {
  if (entry.id === WAR_OF_THE_WORLDS.id) return wotwOccurrence(ms);
  if (entry.id === SPACE_1999.id) return BREAKAWAY;
  return null;
}
