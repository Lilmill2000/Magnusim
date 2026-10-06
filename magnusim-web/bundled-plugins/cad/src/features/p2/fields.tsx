// Selection fields of P2 panels: faces of one body (stored as references) and
// bodies (stored as ids). A field takes viewport clicks while it is active
// (usePicker); a body field also takes a body row clicked in the tree. The
// panel shows what its fields hold by mirroring them into the shared
// selection (the viewport's highlight).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState, type ReactElement } from 'react';
import { storedBodyName } from '../../doc/features/body-ids';
import { useStateStore } from '../../lib/store';
import { describeFace, placeWords } from '../../naming';
import type { AppServices } from '../../types/app';
import type { BodyId, FeatureId, PersistentRef } from '../../types/doc';
import type { SelectionItem } from '../../types/selection';
import { PickList, type PickRow } from './PickList';
import { usePicker } from './pick';
import { faceIndexIn, pickFace, refLabel, shownFaces, statusLostFace } from './refs';

export interface FaceFieldOptions {
  /** The feature being edited (its own faces cannot be picked for it). */
  feature: FeatureId;
  body: BodyId | '';
  refs: PersistentRef[];
  active: boolean;
  /** One face only: a pick replaces it. */
  single?: boolean;
  /** Only flat faces (press-pull, split by face): the reason for a curved one. */
  planar?: string | null;
  /** Faces of one body only (the reason when a pick is on another), or null when any body will do (split's face). */
  oneBody?: string | null;
  /**
   * Rows say what a face is ("End face of Extrude 1", "Side 2 of Extrude 1") instead of its number
   * on the body, which goes in the tooltip; faces known only by number (an import's) keep "Face 6 of
   * flange" (Shell, P4a review: "Face 6 of Body 1" said nothing).
   */
  describe?: boolean;
  onChange(body: BodyId | '', refs: PersistentRef[]): void;
}

export interface FieldHandle {
  /** The field's list, for the panel. */
  element: (label: string, field: string, onActivate: () => void, hint: string) => ReactElement;
  /** What the viewport highlights for this field. */
  highlight: SelectionItem[];
}

/** Face names that say what the face is (a feature's start, end, side, fillet ...), not only its number. */
const SEMANTIC_FACE = /^F:[^:]+:(start|end|side|fillet|chamfer|inner|cut)(:|#|$)/;

export function useFaceField(services: AppServices, o: FaceFieldOptions): FieldHandle {
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const status = useStateStore(services.doc.state, (s) => s.rebuild.features[o.feature]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(o);
  latest.current = o;
  usePicker(services, {
    id: `p2-faces-${o.feature}`,
    active: o.active,
    kinds: ['face'],
    onPick(p) {
      const cur = latest.current;
      if (p.item.kind !== 'face') return;
      const item = p.item;
      const info = services.doc.state.get().rebuild.bodies.find((b) => b.id === item.body);
      if (!info) return;
      if (cur.oneBody && cur.body && item.body !== cur.body && !cur.single) {
        setError(cur.oneBody);
        return;
      }
      if (cur.planar) {
        const h = services.viewport.get().handle;
        if (h && !h.planeNormal(item)) {
          setError(cur.planar);
          return;
        }
      }
      void pickFace(services, info, item.index, cur.feature).then((r) => {
        const now = latest.current;
        if (!r.ok) {
          setError(r.reason);
          return;
        }
        setError(null);
        if (now.single || (now.body && now.body !== r.body)) {
          now.onChange(r.body, [r.ref]);
          return;
        }
        const has = now.refs.some((x) => x.name === r.ref.name);
        now.onChange(r.body, has ? now.refs.filter((x) => x.name !== r.ref.name) : [...now.refs, r.ref]);
      });
    },
  });
  const info = bodies.find((b) => b.id === o.body);
  // A face is named as Measure names it: its number on the body as shown, and the body ("Face 3 of
  // flange"); where it came from is the tooltip. (Review P2/P3 round 1: Measure said "Face 3 of
  // flange" and Delete faces "Face 7 (Imported 1 (flange.step))", even for a face Delete faces 1 had
  // changed.) The number is the face's number on the body as this panel first saw it, kept while
  // the panel stays open: the live result renumbering the body's faces (or removing them) does not
  // rename a row, and two rows never share a number (L3 review polish 4: each hole Delete faces
  // took was "Face 8" of the healed body at its click, so the list read "Face 8, Face 8, Face 8").
  const firstSeen = useRef(new Map<BodyId, readonly string[]>()).current;
  for (const b of bodies) if (b.names && !firstSeen.has(b.id)) firstSeen.set(b.id, b.names.faces);
  const seenAt = useRef(new Map<string, number>()).current;
  const numbered: (number | undefined)[] = o.refs.map((r) => {
    if (!seenAt.has(r.name) && info) {
      const first = firstSeen.get(info.id);
      let at = first ? faceIndexIn(first, r.name) : -1;
      // A face the body did not have when the panel opened: its number on the body as shown now.
      if (at < 0) at = shownFaces(info, [r])[0] ?? -1;
      if (at >= 0) seenAt.set(r.name, at + 1);
    }
    return seenAt.get(r.name);
  });
  const rows: PickRow[] = o.refs.map((r, i) => {
    const from = refLabel(services, r);
    // Two rows on one number (a face first seen on the body as shown after an earlier pick
    // renumbered it): the number would not tell them apart, so they say where they came from.
    const n = numbered[i] != null && numbered.filter((x) => x === numbered[i]).length === 1 ? numbered[i] : undefined;
    // Not on the body after a rebuild (the feature's error names it, or names a face and this
    // one is not on the body shown): the row says so in red, with what the face was. Review
    // P2/P3 round 3: the row of a Press-pull broken by deleting Combine 1 looked found.
    const missing = statusLostFace(status, from) || (statusLostFace(status, null) && (!info || shownFaces(info, [r]).length === 0));
    if (missing) {
      const body = info?.name ?? storedBodyName(services.doc.state.get().doc, o.body) ?? 'the body';
      return { key: r.name, label: from, title: `Not on ${body} now: ${from}. Remove it and pick the face again, or undo the change that removed it.`, sub: 'not found', missing: true };
    }
    // A face with a place of its own ("+Z face of Enclosure 1"), else its number on the body.
    const place = info ? placeWords(r.name) : null;
    const numberWords = n != null && info ? `Face ${n} of ${info.name}` : null;
    if (o.describe && info && SEMANTIC_FACE.test(r.name)) {
      const words = describeFace(r.name, (id) => services.doc.state.get().doc.features.find((f) => f.id === id)?.name ?? null, info.names?.faces ?? null);
      return { key: r.name, label: words, title: numberWords ? `${words} (${numberWords})` : words, sub: r.signature.type === 'plane' ? 'flat' : r.signature.type };
    }
    const label = place && info ? `${place} of ${info.name}` : numberWords ?? from;
    return { key: r.name, label, title: label === from ? from : `${label}, from ${from}`, sub: r.signature.type === 'plane' ? 'flat' : r.signature.type };
  });
  const highlight: SelectionItem[] = info ? shownFaces(info, o.refs).map((index) => ({ kind: 'face', body: info.id, index })) : [];
  return {
    highlight,
    element: (label, field, onActivate, hint) => (
      <PickList
        field={field}
        label={label}
        rows={rows}
        active={o.active}
        single={o.single}
        onActivate={onActivate}
        error={error}
        hint={hint}
        onRemove={(key) => {
          setError(null);
          const next = o.refs.filter((r) => r.name !== key);
          // With no face left, the next pick may be on any body.
          o.onChange(next.length ? o.body : '', next);
        }}
      />
    ),
  };
}

export interface BodyFieldOptions {
  feature: FeatureId;
  ids: BodyId[];
  active: boolean;
  single?: boolean;
  /** Bodies this field may not take, with the reason ("A body cannot be a target and a tool"). */
  refuse?(id: BodyId): string | null;
  onChange(ids: BodyId[]): void;
  /** What an empty field means, shown in it ("All solid bodies before it (1): Body 1"); default "(none)". */
  empty?: string | null;
}

export function useBodyField(services: AppServices, o: BodyFieldOptions): FieldHandle & { take(items: SelectionItem[]): boolean } {
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(o);
  latest.current = o;
  const add = (id: BodyId) => {
    const cur = latest.current;
    const why = cur.refuse?.(id) ?? null;
    if (why) {
      setError(why);
      return;
    }
    setError(null);
    if (cur.single) cur.onChange(cur.ids[0] === id ? [] : [id]);
    else cur.onChange(cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : [...cur.ids, id]);
  };
  usePicker(services, {
    id: `p2-bodies-${o.feature}`,
    active: o.active,
    kinds: ['body'],
    onPick(p) {
      const item = p.item;
      if (item.kind === 'body' || item.kind === 'face' || item.kind === 'edge' || item.kind === 'vertex') add(item.body);
    },
  });
  const rows: PickRow[] = o.ids.map((id) => {
    const b = bodies.find((x) => x.id === id);
    // A body this feature removed (a Cut's tool, a Join's tool) is not built after it: its name still
    // reads from the Part, a split piece's by the derived-name rule ("flange (2)"; it read "A deleted body").
    // A body that is really missing is the feature's own error ("... is not there at this point").
    return { key: id, label: b?.name ?? storedBodyName(services.doc.state.get().doc, id) ?? 'A deleted body' };
  });
  return {
    highlight: o.ids.filter((id) => bodies.some((b) => b.id === id)).map((id) => ({ kind: 'body', body: id })),
    take(items) {
      // A body row clicked in the tree while this field is active.
      if (!latest.current.active) return false;
      const picked = items.filter((it): it is Extract<SelectionItem, { kind: 'body' }> => it.kind === 'body');
      if (picked.length !== 1) return false;
      add(picked[0].body);
      return true;
    },
    element: (label, field, onActivate, hint) => (
      <PickList
        field={field}
        label={label}
        rows={rows}
        active={o.active}
        single={o.single}
        onActivate={onActivate}
        error={error}
        hint={hint}
        empty={o.empty ?? null}
        onRemove={(key) => {
          setError(null);
          o.onChange(o.ids.filter((x) => x !== key));
        }}
      />
    ),
  };
}
