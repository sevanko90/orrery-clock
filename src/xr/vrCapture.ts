import * as THREE from 'three/webgpu';

/**
 * A screenshot from inside VR, for looking at the headset's view from the
 * workstation (telemetry `capture`; dev server only). The headset draws into
 * buffers a page can't read, so this draws the scene again from the left
 * eye's pose and lens into an image of its own, tone-maps it like the
 * screen, and uploads it as a PNG to .telemetry/captures/. It costs a hitch
 * of a frame or two (the first one also compiles shaders for the extra view).
 */
export async function captureEye(renderer: THREE.WebGPURenderer, scene: THREE.Scene, name: string, width = 1280) {
  const eye = (renderer.xr.getCamera() as THREE.ArrayCamera).cameras[0];
  if (!eye) return;
  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = false;
  cam.matrixWorldAutoUpdate = false;
  cam.matrixWorld.copy(eye.matrixWorld);
  cam.matrixWorldInverse.copy(eye.matrixWorldInverse);
  cam.projectionMatrix.copy(eye.projectionMatrix);
  cam.projectionMatrixInverse.copy(eye.projectionMatrixInverse);
  cam.layers.mask = eye.layers.mask;
  const p = eye.projectionMatrix.elements;
  // Width / height of the eye's view, from its lens.
  const aspect = p[5] / p[0];
  const height = Math.round(width / aspect);

  const target = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType });
  const xr = renderer.xr;
  const wasXr = xr.enabled;
  const before = renderer.getRenderTarget();
  try {
    xr.enabled = false;
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
  } finally {
    renderer.setRenderTarget(before);
    xr.enabled = wasXr;
  }
  const raw = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height)) as Uint16Array;
  target.dispose();

  // Half floats, linear: ACES-ish tone map and sRGB encode, like the screen.
  const exposure = renderer.toneMappingExposure ?? 1;
  const px = new Uint8ClampedArray(width * height * 4);
  // (The WebGL backend reads rows bottom-up.)
  const flip = !(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  for (let y = 0; y < height; y++) {
    const src = (flip ? height - 1 - y : y) * width * 4;
    const dst = y * width * 4;
    for (let x = 0; x < width * 4; x += 4) {
      for (let c = 0; c < 3; c++) {
        const v = THREE.DataUtils.fromHalfFloat(raw[src + x + c]) * exposure;
        px[dst + x + c] = 255 * srgb(aces(v));
      }
      px[dst + x + 3] = 255;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(px, width, height), 0, 0);
  await fetch(`/__telemetry/capture?name=${encodeURIComponent(name)}`, { method: 'POST', body: canvas.toDataURL('image/png') });
}

/** Narkowicz's ACES filmic fit. */
function aces(x: number) {
  return THREE.MathUtils.clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1);
}

function srgb(v: number) {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
