// Vertical layout of the movement inside the table cabinet (world units, y up).
// Pure constants so the offline design script can import them too.

export const PLATE_T = 0.08;
export const GEAR_T = 0.08;
export const PITCH = 0.14;

/** Centre heights of the three movement plates. */
export const BOTTOM_PLATE = 0.3;
/** Layer where the drive arbor's pinion meshes the central drive wheel. */
export const L_DRIVE = BOTTOM_PLATE + PLATE_T / 2 + 0.06 + GEAR_T / 2;
/** Stage-1 layers (central drive arbor → intermediate arbors), one per planet. */
export const stage1Y = (i: number) => L_DRIVE + (i + 1) * PITCH;
export const MIDDLE_PLATE = stage1Y(7) + GEAR_T / 2 + 0.06 + PLATE_T / 2;
/** Stage-2 layers (intermediate arbors → planet tubes), innermost tube lowest. */
export const stage2Y = (k: number) => MIDDLE_PLATE + PLATE_T / 2 + 0.06 + GEAR_T / 2 + k * PITCH;
export const TOP_PLATE = stage2Y(7) + GEAR_T / 2 + 0.06 + PLATE_T / 2;

/** Going train sits on the top plate in three planes, balance above. */
export const TOP_GEAR_T = 0.05;
export const TL1 = TOP_PLATE + PLATE_T / 2 + 0.05;
export const TL2 = TL1 + 0.08;
export const TL3 = TL2 + 0.08;
export const TL4 = TL3 + 0.09;
export const TOP_ARBOR_TOP = TL4 + 0.05;

/** Glass window and walnut table surface. */
export const GLASS_Y = TOP_ARBOR_TOP + 0.08;
export const TABLE_TOP = GLASS_Y + 0.03;

export const PLATE_RADIUS = 6.0;
export const WINDOW_RADIUS = 6.6;
export const CENTRAL_HOLE = 0.85;
export const SUN_POST_R = 0.12;
export const F_ARBOR_R = 0.1;

/** Concentric planet tubes, Mercury innermost. */
export const tubeRadius = (k: number) => 0.2 + k * 0.075;
