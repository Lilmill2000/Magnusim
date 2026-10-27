// @ts-check
/**
 * Which app this server is: Magnusim, or the CAD edition (Magnusim CAD: the project
 * screen, CAD and the Assistant, with no simulation, WSL or Python).
 *
 * MAGNUSIM_EDITION=cad selects the CAD edition; anything else, or nothing, is Magnusim.
 * The CAD edition's own server entry sets it before anything reads it, and the page
 * learns it from that server (src/app/edition.ts), never from its URL.
 */

/** @typedef {'magnusim' | 'cad'} Edition */

/** @returns {Edition} */
export function edition() {
  return String(process.env.MAGNUSIM_EDITION || '').trim().toLowerCase() === 'cad' ? 'cad' : 'magnusim';
}

export function isCadEdition() {
  return edition() === 'cad';
}
