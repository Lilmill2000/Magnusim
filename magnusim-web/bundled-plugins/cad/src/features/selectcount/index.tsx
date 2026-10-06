// How much is selected, when it is more than one thing in model mode (P4b
// SELECT): a box selection can take dozens of edges at once, so the dock says
// "Selected · 9 edges" ("2 faces, 4 edges"; bodies, vertices, planes too).
// One item says nothing here: the pick chip names it. A panel's own highlight
// (showForPanel) is not the user's selection and is not counted.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { userSelection } from '../../lib/selection';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { CadModule } from '../../types/modules';
import type { SelectionItem } from '../../types/selection';
import { Chip } from '../../ui/kit';

const WORDS: [SelectionItem['kind'], string, string][] = [
  ['body', 'body', 'bodies'],
  ['face', 'face', 'faces'],
  ['edge', 'edge', 'edges'],
  ['vertex', 'vertex', 'vertices'],
  ['origin', 'plane', 'planes'],
  ['feature', 'feature', 'features'],
];

/** "9 edges", "2 faces, 4 edges" (model kinds only; sketch items are the Sketch panel's). */
export function selectionWords(items: readonly SelectionItem[]): string {
  const parts: string[] = [];
  for (const [kind, one, many] of WORDS) {
    const n = items.filter((i) => i.kind === kind).length;
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(', ');
}

export function SelectionCountChip() {
  const services = useServices();
  const sel = useStateStore(services.selection, (s) => userSelection(s).items);
  const mode = useStateStore(services.mode, (s) => s.mode);
  const model = sel.filter((i) => i.kind !== 'sketch' && i.kind !== 'region');
  if (mode !== 'model' || model.length < 2) return null;
  return (
    <Chip chip="selection" k="Selected">
      <span data-selection-count={model.length}>{selectionWords(model)}</span>
    </Chip>
  );
}

const selectCountModule: CadModule = {
  id: 'selectcount',
  chips: [SelectionCountChip],
};

export default selectCountModule;
