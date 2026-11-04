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

export const FICTION: FictionEntry[] = [WAR_OF_THE_WORLDS, UTOPIA_PLANITIA];

/** Start of the dated event at or after `ms` (null for places). */
export function nextOccurrence(entry: FictionEntry, ms: number): number | null {
  if (entry.id === 'wotw') return wotwOccurrence(ms);
  return null;
}
