import type { PlanetId } from './orbits';

export interface MoonDef {
  id: string;
  name: string;
  parent: PlanetId;
  /** Mean radius, km. */
  radiusKm: number;
  /** Semi-major axis, km. */
  aKm: number;
  /** Sidereal orbital period, days (negative = retrograde). */
  periodDays: number;
  /** Orbital inclination to the parent's equator, degrees. */
  incDeg: number;
  /**
   * Mean longitude at J2000, degrees. Illustrative only (spreads the moons
   * round their orbits); Earth's Moon is placed from its true longitude.
   */
  l0: number;
  /** Has a surface map in public/textures (else drawn in `color`). */
  textured: boolean;
  color?: number;
  /** Map has unimaged (black) regions to fill from the other hemisphere. */
  partialMap?: boolean;
  blurb: string;
}

export const MOONS: MoonDef[] = [
  {
    id: 'moon', name: 'Moon', parent: 'earth', radiusKm: 1737.4, aKm: 384_400, periodDays: 27.321661, incDeg: 5.1, l0: 0, textured: true,
    blurb: 'Always shows us the same face. Its pull raises the tides and slowly lengthens Earth’s day.',
  },
  {
    id: 'phobos', name: 'Phobos', parent: 'mars', radiusKm: 11.1, aKm: 9376, periodDays: 0.31891, incDeg: 1.1, l0: 35, textured: true,
    blurb: 'Circles Mars three times a day and is spiralling inward; in about 50 million years it will break up into a ring.',
  },
  {
    id: 'deimos', name: 'Deimos', parent: 'mars', radiusKm: 6.2, aKm: 23_463, periodDays: 1.26244, incDeg: 0.9, l0: 210, textured: true,
    blurb: 'A lumpy 12 km rock, probably a captured asteroid or debris from an ancient impact on Mars.',
  },
  {
    id: 'io', name: 'Io', parent: 'jupiter', radiusKm: 1821.6, aKm: 421_700, periodDays: 1.769138, incDeg: 0.05, l0: 20, textured: true,
    blurb: 'The most volcanic world known, kneaded by Jupiter’s tides; its eruptions reach 400 km high.',
  },
  {
    id: 'europa', name: 'Europa', parent: 'jupiter', radiusKm: 1560.8, aKm: 671_034, periodDays: 3.551181, incDeg: 0.47, l0: 150, textured: true,
    blurb: 'A cracked ice shell over a salty ocean holding more water than all of Earth’s seas.',
  },
  {
    id: 'ganymede', name: 'Ganymede', parent: 'jupiter', radiusKm: 2634.1, aKm: 1_070_412, periodDays: 7.154553, incDeg: 0.2, l0: 260, textured: true,
    blurb: 'The largest moon in the Solar System, bigger than Mercury, and the only one with its own magnetic field.',
  },
  {
    id: 'callisto', name: 'Callisto', parent: 'jupiter', radiusKm: 2410.3, aKm: 1_882_709, periodDays: 16.689018, incDeg: 0.19, l0: 80, textured: true,
    blurb: 'The most heavily cratered surface known: ancient ice, barely changed in four billion years.',
  },
  {
    id: 'mimas', name: 'Mimas', parent: 'saturn', radiusKm: 198.2, aKm: 185_539, periodDays: 0.942422, incDeg: 1.57, l0: 300, textured: true,
    blurb: 'Its giant crater Herschel spans a third of its width. Its pull clears the Cassini Division in the rings.',
  },
  {
    id: 'enceladus', name: 'Enceladus', parent: 'saturn', radiusKm: 252.1, aKm: 237_948, periodDays: 1.370218, incDeg: 0.02, l0: 45, textured: true,
    blurb: 'Geysers at its south pole spray ocean water into space, feeding Saturn’s E ring.',
  },
  {
    id: 'tethys', name: 'Tethys', parent: 'saturn', radiusKm: 531.1, aKm: 294_619, periodDays: 1.887802, incDeg: 1.12, l0: 170, textured: true,
    blurb: 'Almost pure water ice, scarred by the 2,000 km canyon Ithaca Chasma.',
  },
  {
    id: 'dione', name: 'Dione', parent: 'saturn', radiusKm: 561.4, aKm: 377_396, periodDays: 2.736915, incDeg: 0.02, l0: 230, textured: true,
    blurb: 'Bright ice cliffs streak its trailing side. It shares its orbit with two tiny Trojan moons.',
  },
  {
    id: 'rhea', name: 'Rhea', parent: 'saturn', radiusKm: 763.8, aKm: 527_108, periodDays: 4.518212, incDeg: 0.35, l0: 100, textured: true,
    blurb: 'Saturn’s second-largest moon: a cold, cratered ball of ice and rock.',
  },
  {
    id: 'titan', name: 'Titan', parent: 'saturn', radiusKm: 2574.7, aKm: 1_221_870, periodDays: 15.945421, incDeg: 0.35, l0: 330, textured: false, color: 0xd9a24e,
    blurb: 'Wrapped in an orange haze thicker than Earth’s air, with rain and lakes of liquid methane.',
  },
  {
    id: 'iapetus', name: 'Iapetus', parent: 'saturn', radiusKm: 734.5, aKm: 3_560_820, periodDays: 79.3215, incDeg: 15.5, l0: 190, textured: true,
    blurb: 'Two-toned: one hemisphere dark as coal, the other bright as snow, with a ridge round its equator.',
  },
  {
    id: 'miranda', name: 'Miranda', parent: 'uranus', radiusKm: 235.8, aKm: 129_390, periodDays: 1.413479, incDeg: 4.3, l0: 60, textured: true, partialMap: true,
    blurb: 'A patchwork of terrains with Verona Rupes, a cliff perhaps 20 km tall.',
  },
  {
    id: 'ariel', name: 'Ariel', parent: 'uranus', radiusKm: 578.9, aKm: 191_020, periodDays: 2.520379, incDeg: 0.26, l0: 200, textured: true, partialMap: true,
    blurb: 'The brightest of Uranus’s moons, its young surface cut by long rift valleys.',
  },
  {
    id: 'umbriel', name: 'Umbriel', parent: 'uranus', radiusKm: 584.7, aKm: 266_000, periodDays: 4.144177, incDeg: 0.13, l0: 320, textured: true, partialMap: true,
    blurb: 'The darkest of Uranus’s large moons, with a mysterious bright ring on its crater Wunda.',
  },
  {
    id: 'titania', name: 'Titania', parent: 'uranus', radiusKm: 788.4, aKm: 435_910, periodDays: 8.705872, incDeg: 0.34, l0: 110, textured: true, partialMap: true,
    blurb: 'Uranus’s largest moon, split by fault canyons up to 1,500 km long.',
  },
  {
    id: 'oberon', name: 'Oberon', parent: 'uranus', radiusKm: 761.4, aKm: 583_520, periodDays: 13.463239, incDeg: 0.06, l0: 250, textured: true, partialMap: true,
    blurb: 'The outermost large moon of Uranus: old, cratered and dark-floored.',
  },
  {
    id: 'triton', name: 'Triton', parent: 'neptune', radiusKm: 1353.4, aKm: 354_759, periodDays: -5.876854, incDeg: 23, l0: 140, textured: true, partialMap: true,
    blurb: 'Orbits backwards, so it was probably captured from the Kuiper belt. Nitrogen geysers streak its frozen surface.',
  },
  {
    id: 'charon', name: 'Charon', parent: 'pluto', radiusKm: 606, aKm: 19_591, periodDays: 6.38723, incDeg: 0.0, l0: 0, textured: true, partialMap: true,
    blurb: 'Half Pluto’s size. The two are locked face to face, each always showing the other the same side.',
  },
];
