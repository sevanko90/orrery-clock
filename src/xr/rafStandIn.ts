/**
 * three's WebGL backend polls for the GPU with window.requestAnimationFrame, which the
 * Quest Browser doesn't run during a VR session (only the session's own loop).
 */
/** Replace window.requestAnimationFrame with a short timer; returns the undo (safe to call twice). */
export function standInFrameTimer() {
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 4);
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    window.requestAnimationFrame = raf;
  };
}
