/**
 * Is WebGL running on a real GPU? Browsers quietly fall back to a software
 * rasteriser (SwiftShader, llvmpipe, Microsoft Basic Render Driver) when
 * hardware acceleration is off or the GPU is blocklisted; the orrery then
 * crawls and looks rough. Two checks, both browser-neutral:
 *  - a context requested with `failIfMajorPerformanceCaveat` is refused when
 *    the browser would have to render in software;
 *  - the unmasked renderer name, where exposed, names the software renderer.
 */
export type GpuStatus = 'hardware' | 'software' | 'none';

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render driver|mesa offscreen/i;

function release(gl: WebGLRenderingContext | WebGL2RenderingContext | null) {
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
}

export function detectGpu(): GpuStatus {
  // Debug override for previewing the warning: ?gpu=software or ?gpu=none
  const forced = new URLSearchParams(location.search).get('gpu');
  if (forced === 'software' || forced === 'none') return forced;

  const fast = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  if (fast) {
    const info = fast.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(fast.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    release(fast);
    return SOFTWARE_RENDERER.test(renderer) ? 'software' : 'hardware';
  }
  const any = document.createElement('canvas').getContext('webgl2');
  release(any);
  return any ? 'software' : 'none';
}

/** How to switch hardware acceleration on, for the browser in use. */
function instructions(): string {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) {
    return 'In Firefox, open Settings → General → Performance, untick “Use recommended performance settings”, tick “Use hardware acceleration when available”, then restart Firefox.';
  }
  if (/Edg\//.test(ua)) {
    return 'In Edge, open Settings → System and performance, turn on “Use graphics acceleration when available”, then restart Edge.';
  }
  if (/Chrome\//.test(ua)) {
    return 'In Chrome, open Settings → System, turn on “Use graphics acceleration when available”, then relaunch Chrome. (Brave, Opera and Vivaldi have the same setting.)';
  }
  if (/Safari\//.test(ua)) {
    return 'Safari always uses the GPU when it can. Check that Low Power Mode is off and that the browser is up to date.';
  }
  return 'Look in your browser’s settings for “hardware acceleration” or “graphics acceleration”, turn it on, and restart the browser.';
}

const DISMISS_KEY = 'gpu-warning-dismissed';

/** Warn (once, unless asked again) when the orrery can't use the GPU. */
export function warnIfNoGpu(status: GpuStatus) {
  if (status === 'hardware') return;
  const forced = new URLSearchParams(location.search).has('gpu');
  try {
    if (!forced && status === 'software' && localStorage.getItem(DISMISS_KEY) === '1') return;
  } catch {
    /* ignore */
  }

  const dialog = document.getElementById('gpu-warning') as HTMLDialogElement;
  const lead = dialog.querySelector('.gpu-lead')!;
  lead.textContent =
    status === 'none'
      ? 'This browser can’t run WebGL, which the orrery needs to draw anything.'
      : 'Your browser is drawing the orrery without the graphics card, so it will be slow and rough.';
  dialog.querySelector('.gpu-how')!.textContent = instructions();
  const dismiss = dialog.querySelector<HTMLButtonElement>('.gpu-dismiss')!;
  dismiss.hidden = status === 'none';
  dismiss.addEventListener('click', () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  });
  dialog.showModal();
}
