// What the one face, edge or point picked in the view is, by its persistent name,
// in the status dock: "Face · Fillet (Fillet 1)", "Edge · End · Side 2 (Extrude 1)",
// "Point · Corner of End, Side 1 and Side 2 (Extrude 1)". Proposal §7 P4a: clicking
// the middle of an edge a fillet replaced shows "Face · Fillet (Fillet 1)". Nothing
// shows with nothing, or several things, picked.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import { kernelLookup } from '../../naming';
import { faceShortWords, splitEdgeName, splitVertexName } from '../../naming/edges';
import { edgeName, splitMerged, vertexName } from '../../naming/names';
import type { CadModule } from '../../types/modules';
import { Chip } from '../../ui/kit';

/** "Fillet (Fillet 1)", "Side 2 (Extrude 1)"; parts of a merged face joined by " + ". */
export function faceWordsWithOwner(name: string, faceNames: readonly string[], featureName: (id: string) => string | null): string {
  const parts = splitMerged(name).map((p) => {
    const w = faceShortWords(p, faceNames);
    return `${w.words} (${w.owner ? (featureName(w.owner) ?? 'a deleted feature') : 'a body'})`;
  });
  return [...new Set(parts)].join(' + ');
}

/** Faces of an edge or a vertex in words: "End · Side 2 (Extrude 1)", one owner said once when they share it. */
function partsWords(parts: readonly string[], faceNames: readonly string[], featureName: (id: string) => string | null, sep: string): string {
  const w = parts.map((p) => faceShortWords(p, faceNames));
  const owner = (id: string | null) => (id ? (featureName(id) ?? 'a deleted feature') : 'a body');
  if (w.every((x) => x.owner === w[0].owner)) return `${w.map((x) => x.words).join(sep)} (${owner(w[0].owner)})`;
  return w.map((x) => `${x.words} (${owner(x.owner)})`).join(sep);
}

export function PickInfoChip() {
  const services = useServices();
  const sel = useStateStore(services.selection, (s) => s.items);
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const features = useStateStore(services.doc.state, (s) => s.doc.features);
  const [text, setText] = useState<string | null>(null);
  const one = sel.length === 1 && (sel[0].kind === 'face' || sel[0].kind === 'edge' || sel[0].kind === 'vertex') ? sel[0] : null;
  const info = one ? bodies.find((b) => b.id === one.body) : undefined;
  const key = one ? `${one.kind}:${one.body}:${one.index}:${info?.shape ?? ''}` : '';
  useEffect(() => {
    let live = true;
    setText(null);
    if (!one || !info?.names) return;
    const names = info.names.faces;
    const fname = (id: string) => features.find((f) => f.id === id)?.name ?? null;
    if (one.kind === 'face') {
      const n = names[one.index];
      if (n) setText(`Face · ${faceWordsWithOwner(n, names, fname)}`);
      return;
    }
    const lookup = kernelLookup(services.kernel);
    void (async () => {
      try {
        if (one.kind === 'edge') {
          const [e] = await lookup.edges!(info.shape, [one.index]);
          const f = e ? [...new Set(e.faces)] : [];
          if (!f.length || !names[f[0]]) return;
          const parts = splitEdgeName(edgeName(names[f[0]], names[f.length > 1 ? f[1] : f[0]])) ?? [];
          if (live) setText(`Edge · ${partsWords(parts, names, fname, ' · ')}`);
        } else {
          const [v] = await lookup.vertices!(info.shape, [one.index]);
          const fs = (v?.faces ?? []).map((i) => names[i]);
          if (!fs.length || fs.some((x) => !x)) return;
          const parts = splitVertexName(vertexName([...new Set(fs)])) ?? [];
          if (live) setText(`Point · ${partsWords(parts, names, fname, ', ')}`);
        }
      } catch {
        /* a kernel restart: nothing to say */
      }
    })();
    return () => {
      live = false;
    };
  }, [key, features]);
  if (!text) return null;
  return (
    <Chip chip="pick" k="Picked">
      <span data-pick-info="1">{text}</span>
    </Chip>
  );
}

const pickInfoModule: CadModule = {
  id: 'pickinfo',
  chips: [PickInfoChip],
};

export default pickInfoModule;
