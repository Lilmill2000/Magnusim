// Why the browser gave the tunnel no GPU, and exactly where to turn it on. The usual cause is
// the browser's graphics acceleration switched off: WebGPU then offers no adapter, and WebGL
// falls back to a software renderer (SwiftShader, Microsoft Basic Render Driver, llvmpipe).
// SPDX-License-Identifier: GPL-3.0-or-later

export interface GpuHelp {
  title: string;
  body: string;
  /** What was found: graphics acceleration off, or a GPU the browser will not use for WebGPU. */
  cause: 'acceleration-off' | 'no-adapter';
}

const SOFTWARE_RENDERER = /swiftshader|basic render driver|llvmpipe|software/i;

/** The browser, from its user agent (Edge says "Edg/", Opera "OPR/"; Chrome last). */
export function browserOf(ua: string): 'edge' | 'chrome' | 'firefox' | 'opera' | 'other' {
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'other';
}

const RUN_BAT = 'Or start Magnusim with run.bat: it opens in its own window with graphics acceleration on.';

/**
 * The words for a browser that offers WebGPU but gave no adapter. `renderer` is WebGL's
 * renderer string (unmasked where the browser gives it), or null without WebGL.
 */
export function gpuHelp(ua: string, renderer: string | null): GpuHelp {
  const off = renderer == null || SOFTWARE_RENDERER.test(renderer);
  if (!off) {
    return {
      cause: 'no-adapter',
      title: 'This wind tunnel needs WebGPU',
      body: `The browser draws with the GPU (${renderer}) but offers it no WebGPU: the GPU or its driver may be on the browser's block list. Update the graphics driver, and check the WebGPU line on the browser's GPU page (${browserOf(ua) === 'edge' ? 'edge://gpu' : 'chrome://gpu'}). ${RUN_BAT}`,
    };
  }
  const where: Record<ReturnType<typeof browserOf>, string> = {
    edge: 'In Microsoft Edge: Settings → System and performance (edge://settings/system), turn on "Use graphics acceleration when available", then restart Edge.',
    chrome: 'In Chrome: Settings → System (chrome://settings/system), turn on "Use graphics acceleration when available", then Relaunch.',
    opera: 'In Opera: Settings → Browser → System (opera://settings/system), turn on "Use graphics acceleration when available", then restart Opera.',
    firefox: 'In Firefox: Settings → General → Performance, untick "Use recommended performance settings", tick "Use hardware acceleration when available", then restart Firefox.',
    other: 'Turn on the browser’s graphics (hardware) acceleration in its settings, then restart it.',
  };
  return {
    cause: 'acceleration-off',
    title: 'Graphics acceleration is turned off in this browser',
    body: `So it gives pages no GPU, and the wind tunnel solves the flow on the GPU. ${where[browserOf(ua)]} ${RUN_BAT}`,
  };
}

/** WebGL's renderer string here (unmasked where allowed), or null without WebGL. */
export function webglRenderer(): string | null {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return null;
  }
}
