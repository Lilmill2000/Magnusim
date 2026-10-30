/**
 * Whether the dock offers drawings (SVG, DXF) as attachments beside pictures and geometry files.
 * On: the CAD Part imports drawings (the person's Import SVG/DXF in a sketch; the Assistant's
 * sketch tool reads an attached one with its import row). While it is off the dock leaves drawings
 * out of its accept list and refuses one like any other file, before anything is uploaded. The
 * server takes drawings either way.
 */
export const DRAWINGS_OFFERED = true;

let offered: boolean = DRAWINGS_OFFERED;

/** What the dock offers now: the shipped setting, or the one a test set. Read at call time. */
export const drawingsOffered = (): boolean => offered;

/** Tests only: run the dock with drawings on or off whatever ships; null goes back to the shipped setting. */
export function setDrawingsOfferedForTests(on: boolean | null): void {
  offered = on ?? DRAWINGS_OFFERED;
}
