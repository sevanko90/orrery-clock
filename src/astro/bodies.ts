import type { CometElements, PlanetId } from './orbits';

export interface BodyFacts {
  id: string;
  name: string;
  kind: string;
  /** Mean radius, km. */
  radiusKm: number;
  /** Sidereal rotation period in hours (negative = retrograde). */
  rotationHours: number;
  /** Axial tilt, degrees. */
  tiltDeg: number;
  moons: number | null;
  blurb: string;
}

export const SUN_FACTS: BodyFacts = {
  id: 'sun',
  name: 'Sun',
  kind: 'G-type main-sequence star',
  radiusKm: 695_700,
  rotationHours: 609.12,
  tiltDeg: 7.25,
  moons: null,
  blurb: 'Holds 99.86% of the Solar System’s mass. Its light takes about 8 min 20 s to reach Earth.',
};

export const PLANET_FACTS: Record<PlanetId, BodyFacts> = {
  mercury: {
    id: 'mercury',
    name: 'Mercury',
    kind: 'Terrestrial planet',
    radiusKm: 2439.7,
    rotationHours: 1407.6,
    tiltDeg: 0.03,
    moons: 0,
    blurb: 'The swiftest planet. Its day (sunrise to sunrise) lasts two of its years.',
  },
  venus: {
    id: 'venus',
    name: 'Venus',
    kind: 'Terrestrial planet',
    radiusKm: 6051.8,
    rotationHours: -5832.5,
    tiltDeg: 177.4,
    moons: 0,
    blurb: 'Spins backwards beneath a crushing CO₂ sky hot enough to melt lead.',
  },
  earth: {
    id: 'earth',
    name: 'Earth',
    kind: 'Terrestrial planet',
    radiusKm: 6371,
    rotationHours: 23.934,
    tiltDeg: 23.44,
    moons: 1,
    blurb: 'You are here. The only world known to keep clocks.',
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    kind: 'Terrestrial planet',
    radiusKm: 3389.5,
    rotationHours: 24.623,
    tiltDeg: 25.19,
    moons: 2,
    blurb: 'Home of Olympus Mons, the tallest volcano known — about 2.5× the height of Everest.',
  },
  jupiter: {
    id: 'jupiter',
    name: 'Jupiter',
    kind: 'Gas giant',
    radiusKm: 69_911,
    rotationHours: 9.925,
    tiltDeg: 3.13,
    moons: 95,
    blurb: 'More than twice the mass of all other planets combined. The Great Red Spot is a storm wider than Earth.',
  },
  saturn: {
    id: 'saturn',
    name: 'Saturn',
    kind: 'Gas giant',
    radiusKm: 58_232,
    rotationHours: 10.656,
    tiltDeg: 26.73,
    moons: 146,
    blurb: 'Its rings span 280,000 km yet are mostly only about ten metres thick.',
  },
  uranus: {
    id: 'uranus',
    name: 'Uranus',
    kind: 'Ice giant',
    radiusKm: 25_362,
    rotationHours: -17.24,
    tiltDeg: 97.77,
    moons: 28,
    blurb: 'Rolls around the Sun on its side; each pole gets 42 years of daylight.',
  },
  neptune: {
    id: 'neptune',
    name: 'Neptune',
    kind: 'Ice giant',
    radiusKm: 24_622,
    rotationHours: 16.11,
    tiltDeg: 28.32,
    moons: 16,
    blurb: 'Found by mathematics before telescope, in 1846. Winds reach 2,000 km/h.',
  },
  pluto: {
    id: 'pluto',
    name: 'Pluto',
    kind: 'Dwarf planet',
    radiusKm: 1188.3,
    rotationHours: -153.29,
    tiltDeg: 122.53,
    moons: 5,
    blurb: 'Its eccentric orbit sometimes brings it closer to the Sun than Neptune. Its heart is a glacier of nitrogen ice.',
  },
};

export interface CometDef {
  id: string;
  name: string;
  elements: CometElements;
  blurb: string;
}

export const COMETS: CometDef[] = [
  {
    id: 'halley',
    name: '1P/Halley',
    // Perihelion 1986 Feb 9.46 TT.
    elements: { q: 0.5871, e: 0.96714, i: 162.26, node: 58.42, argPeri: 111.33, perihelionJD: 2446470.96 },
    blurb: 'The famous periodic comet, orbiting backwards every ~76 years. Next perihelion in 2061.',
  },
  {
    id: 'encke',
    name: '2P/Encke',
    // Perihelion 2023 Oct 22.
    elements: { q: 0.3393, e: 0.8471, i: 11.35, node: 334.19, argPeri: 187.13, perihelionJD: 2460239.5 },
    blurb: 'Shortest-period bright comet known: once every 3.3 years. Parent of the Taurid meteors.',
  },
];
