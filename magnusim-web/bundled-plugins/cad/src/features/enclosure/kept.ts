// An Enclosure in Magnusim CAD (Daniel 2026-10-29: hide every project and simulation item there).
// The desktop edition's welcome says projectLinks false: no projects, no simulation, so no CFD
// PREP and no Enclosure command (index.ts registers none). A Part made in Magnusim can still hold
// an Enclosure: there it keeps building its body and stays in the tree (rename, suppress, move,
// delete, as any feature), but nobody changes its inputs: its panel shows it read-only with
// KEPT_WORDS (EnclosurePanel.tsx), and the Assistant's edit_feature refuses its values with the
// same words; get_model gives it no inputs to resend. In Magnusim (projectLinks true or absent)
// nothing changes.
// Owner: SD pass (src/features/enclosure/).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../../lib/bridge';

/** What the person reads in a kept Enclosure's panel, and the Assistant in edit_feature's refusal. */
export const KEPT_WORDS = 'An Enclosure is changed in Magnusim. Here it stays as it is, with its body: suppress or delete it to take the body away.';

/** Whether this feature is an Enclosure that Magnusim CAD keeps as it is (its inputs unchanged). */
export function enclosureKept(services: { bridge: Pick<Bridge, 'projectLinks'> }, f: { type: string }): boolean {
  return f.type === 'enclosure' && !services.bridge.projectLinks();
}
