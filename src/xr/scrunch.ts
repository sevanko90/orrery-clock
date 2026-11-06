/**
 * "Scrunch": the cheaper-to-draw build of the scene for a standalone headset
 * (Quest 3). Gears and plates get distance LODs, the hall is merged into a
 * handful of meshes, and repeated materials are shared, so the headset draws
 * far fewer vertices and objects for (as near as the maths allows) the same
 * picture.
 *
 * `?scrunch=1` forces it on (also on the desktop, to view and measure it),
 * `?scrunch=0` forces it off (also on the headset, for A/B tests). With no
 * flag it is on only for the headset profile, so the desktop render is
 * untouched.
 *
 * `?headset=1` gives a desktop browser the headset quality profile, and
 * `?vrview=1` makes the desktop camera stand in for the VR head (the hall
 * shown, the VR detail culling run from the camera, Quest-like field of
 * view), so both halves of an A/B can be seen side by side on the desktop.
 */
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

/** The URL's choice: true / false, or null to follow the device. */
export const SCRUNCH_FLAG: boolean | null = params.get('scrunch') === '1' ? true : params.get('scrunch') === '0' ? false : null;
export const HEADSET_FLAG = params.get('headset') === '1';
export const VRVIEW_FLAG = params.get('vrview') === '1';

/** Is the scrunched scene in use, for this device? */
export function scrunchOn(headset: boolean): boolean {
  return SCRUNCH_FLAG ?? headset;
}

/**
 * Pixels per radian on a Quest 3 eye buffer: ~2064 px across ~110° of
 * horizontal field, f = w / (2·tan(hfov/2)) ≈ 720. A geometric error `e` at
 * distance `d` shows as e / d × f pixels.
 */
export const QUEST_PX_PER_RAD = 720;

/** Largest geometric error allowed for a level (pixels on the eye buffer). */
export const LOD_PX = 0.5;

/** Distance beyond which an error `e` stays under `px` pixels. */
export function switchDistance(e: number, px = LOD_PX, f = QUEST_PX_PER_RAD) {
  return (e * f) / px;
}

/** Error allowed at distance `d` for `px` pixels. */
export function allowedError(d: number, px = LOD_PX, f = QUEST_PX_PER_RAD) {
  return (d * px) / f;
}

/** Relative hysteresis on LOD switches, so a level doesn't flicker at its boundary. */
export const LOD_HYSTERESIS = 0.06;
