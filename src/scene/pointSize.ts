/**
 * Shared uniforms for every distance-sized particle shader (rimfall, dust,
 * comet tails, astrophage). Their sizes are tuned for the desktop camera; in
 * VR the eye buffers, field of view and world scale all differ, and the
 * player can stand right inside a cloud of them, where unclamped points
 * balloon to fill the view (and the GPU's fill rate). VR sets `uPointView`
 * to rescale and `uPointMax` to cap them.
 *
 * Spread into a ShaderMaterial's uniforms (the objects are shared, so one
 * write updates every material) and size points with `pointSize(...)`.
 */
export const POINT_UNIFORMS = {
  uPointView: { value: 1 },
  uPointMax: { value: 4096 },
};

/** GLSL declaration to put in a vertex shader using POINT_UNIFORMS. */
export const POINT_GLSL = 'uniform float uPointView, uPointMax;';

/** GLSL expression: a desktop-tuned point size, adjusted for the current view. */
export const pointSize = (expr: string) => `min((${expr}) * uPointView, uPointMax)`;
