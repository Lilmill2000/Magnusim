// Every shader module the tunnel makes, for the start-up compile check: a shader that does
// not compile on this GPU stops the page with its message instead of drawing nothing.
// SPDX-License-Identifier: GPL-3.0-or-later
import * as dye from './dye';
import { allShaders } from './kernels';
import * as particles from './particles';
import * as streamlines from './streamlines';

export function everyShader(): { label: string; code: string }[] {
  return [
    ...allShaders(),
    { label: 'particles advect', code: particles.advectShader() },
    { label: 'particles draw', code: particles.drawShader() },
    { label: 'trail fade', code: particles.fadeShader },
    { label: 'rake lines', code: particles.lineShader() },
    { label: 'dye advect', code: dye.advectShader() },
    { label: 'dye correct', code: dye.correctShader() },
    { label: 'dye inject', code: dye.injectShader() },
    { label: 'streamlines trace', code: streamlines.traceShader },
    { label: 'streamlines draw', code: streamlines.drawShader },
  ];
}

/** Compile every shader; the first error's message, or null when all compile. */
export async function shaderErrors(device: GPUDevice): Promise<string | null> {
  for (const s of everyShader()) {
    const info = await device.createShaderModule({ code: s.code, label: s.label }).getCompilationInfo();
    const err = info.messages.find((m) => m.type === 'error');
    if (err) return `${s.label} shader, line ${err.lineNum}: ${err.message}`;
  }
  return null;
}
