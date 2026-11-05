/**
 * Everything human-sized in VR, in one place.
 *
 * The orrery keeps its own units. In VR the *player* is scaled instead: the
 * rig carrying the headset and controllers is shrunk by 1 / metresPerUnit,
 * so one real metre covers that many fewer orrery units. Lights, shadows,
 * glows and every scene's maths stay exactly as on the desktop; only the
 * things sized to a person (walking pace, labels, the pointer) are listed here.
 */
export const XR = {
  /** Default world scale: real metres per orrery unit. The orrery's widest arm reach is ~34 units. */
  metresPerUnit: 1.5,
  /** Range the in-headset scale control can reach. */
  minMetresPerUnit: 0.02,
  maxMetresPerUnit: 6,

  /** The cabinet's underside hovers this high above the hangar floor (orrery units). */
  hoverGap: 3,
  /** Hangar half-width beyond the table's edge, and roof clearance above the planets (orrery units). */
  hangarMargin: 9,
  roofClearance: 8,

  /** Walking pace on the floor (m/s): human, whatever the scale. */
  walkSpeed: 2,
  /** Jetpack top speed (m/s) at the default scale; grows with the square root of the scale. */
  flySpeed: 7,
  /** Jetpack acceleration at full trigger (m/s²). */
  thrust: 9,
  /** Vertical speed on the right stick (m/s, at the default scale). */
  liftSpeed: 3,
  /** Airborne drag (per second): with nothing pressed the jetpack settles into a hover. */
  drag: 1.6,
  /** Snap turn step, and the stick deflection that fires it. */
  snapTurnDeg: 30,
  stickDeadzone: 0.15,

  /** Pointer ray length when it hits nothing (m). */
  rayLength: 40,
  /** Labels keep this angular size: world height per unit of viewing distance. */
  labelAngular: 0.05,

  /** Comfort vignette: speed (m/s) where it starts, and at full strength. */
  vignetteFrom: 0.6,
  vignetteFull: 5,
  vignetteMax: 0.78,

  /** Largest a particle may draw (px per eye): standing inside the rimfall must not fill the view. */
  maxPointPx: 64,
  /** Meshes smaller than this from the eye (radians across their bounding radius) aren't drawn. */
  detailCullAngle: 0.0035,
} as const;

/** Jetpack speeds scale partly with the world, so big hangars stay crossable. */
export function speedScale(metresPerUnit: number) {
  return Math.sqrt(metresPerUnit / XR.metresPerUnit);
}
