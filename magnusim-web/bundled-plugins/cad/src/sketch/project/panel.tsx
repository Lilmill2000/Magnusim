// The Sketch panel's linked-geometry block (P4b SELECT): the Project tool's
// Silhouette switch, the Intersect tool's bodies and its Intersect button, and
// "References": every link of the sketch with what it follows, how many curves
// it made, and its state at the last rebuild (Lost reference in amber with the
// words; "changed" when a face, silhouette or section now gives other curves),
// each with Break link and Delete.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import './project.css';
import { useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { SketchFeature } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import { Button, Hint } from '../../ui/kit';
import { Switch } from '../../features/p2/panel';
import type { SketchMode } from '../mode';
import { breakLinks } from './curves';
import { sourceDetail, sourceWords } from './source';
import { intersectBodies, projectStateOf, sketchEnv } from './tools';

/** `refs` (ux010, the compact Sketch panel): 'lost' lists only the links that lost what they follow or whose source changed (each with its one line); 'none' only the tool's inputs (the collapsed panel's tool card). */
export function LinksBlock({ mode, feature, draft, refs = 'all' }: { mode: SketchMode; feature: string; draft: SketchFeature; refs?: 'all' | 'lost' | 'none' }) {
  const services = useServices();
  const st = useStateStore(projectStateOf(services));
  const tool = useStateStore(mode.state, (s) => s.tool);
  const out = useStateStore(services.doc.state, (s) => s.rebuild.outputs[feature] as SketchOutput | undefined);
  const bodiesKey = useStateStore(services.doc.state, (s) => JSON.stringify(s.rebuild.bodies.filter((b) => b.visible).map((b) => b.id)));
  const [busy, setBusy] = useState(false);
  const allLinks = draft.links ?? [];
  const env = sketchEnv(services);
  const status = out?.type === 'sketch' ? (out.links ?? {}) : {};
  const shownBodies = JSON.parse(bodiesKey) as string[];
  const links = refs === 'all' ? allLinks : refs === 'none' ? [] : allLinks.filter((l) => status[l.id]?.state === 'lost' || status[l.id]?.state === 'changed');

  const removeLink = (id: string) => {
    const l = links.find((x) => x.id === id);
    if (!l) return;
    mode.select(
      l.entities.filter((r) => draft.entities.some((e) => e.id === r.entity)).map((r) => ({ what: 'entity' as const, id: r.entity })),
      false,
    );
    void mode.deleteSelected();
  };
  const breakLink = (id: string) => {
    const l = links.find((x) => x.id === id);
    if (!l) return;
    const ids = l.entities.map((r) => r.entity);
    void mode.apply('Break link', (cur) => {
      const next = breakLinks(cur, ids);
      return next ? { ok: true, draft: next, optional: [], removed: [] } : { ok: false, reason: 'nothing follows the model' };
    });
  };

  return (
    <>
      {tool === 'project' ? (
        <div className="cad-sk-section" data-sketch-project="1">
          <Switch field="silhouette" label="Silhouette: click a body for its outline" checked={st.silhouette} onChange={(v) => {
            projectStateOf(services).set({ silhouette: v });
            mode.refreshHint();
          }} />
        </div>
      ) : null}
      {tool === 'intersect' ? (
        <div className="cad-sk-section" data-sketch-intersect="1">
          <div className="cad-field-group-title">Intersect</div>
          <div className="cad-sk-selected" data-intersect-bodies="1">
            {st.bodies.length ? st.bodies.map((b) => env.bodyName(b)).join(', ') : `Every shown body (${shownBodies.length})`}
          </div>
          <div className="cad-sk-actions">
            <Button
              variant="secondary"
              data-sketch-action="intersect"
              disabledReason={busy ? 'Intersecting the bodies' : null}
              onClick={() => {
                setBusy(true);
                void intersectBodies(mode, st.bodies.length ? st.bodies : null)
                  .then((words) => {
                    mode.note(words || null);
                    projectStateOf(services).set({ bodies: [] });
                    services.viewport.get().handle?.flash([]);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Intersect
            </Button>
          </div>
        </div>
      ) : null}
      {links.length ? (
        <div className="cad-sk-section" data-sketch-links="1">
          <div className="cad-field-group-title">{refs === 'all' ? 'References' : links.every((l) => status[l.id]?.state === 'lost') ? 'Lost references' : links.every((l) => status[l.id]?.state === 'changed') ? 'Changed references' : 'Lost and changed references'}</div>
          <ul className="cad-sk-links">
            {links.map((l) => {
              const s = status[l.id];
              const state = s?.state ?? 'ok';
              const n = l.entities.filter((r) => draft.entities.some((e) => e.id === r.entity && e.link === l.id)).length;
              const words = sourceWords(l.source, env);
              return (
                <li key={l.id} data-link={l.id} data-link-state={state} data-link-type={l.type} data-link-auto={l.auto ? '1' : '0'} className={`cad-sk-link is-${state}`}>
                  <span className="cad-sk-link-name" title={s?.message ?? [words, sourceDetail(l.source, env)].filter(Boolean).join(', from ')}>
                    <span className={`cad-sk-link-dot is-${l.type}`} aria-hidden="true" />
                    {l.type === 'intersection' ? 'Intersection' : l.source.kind === 'silhouette' ? 'Silhouette' : 'Projected'}: {words.replace(/^Silhouette of |^Section of /, '')} · {n} {n === 1 ? 'curve' : 'curves'}
                  </span>
                  {state !== 'ok' ? (
                    <span className="cad-sk-link-state" data-link-message="1">
                      {state === 'lost' ? 'Lost reference' : 'Changed'}: {s?.message}
                    </span>
                  ) : null}
                  <span className="cad-sk-link-actions">
                    <button type="button" className="cad-sk-link-btn" data-link-break={l.id} onClick={() => breakLink(l.id)}>
                      Break link
                    </button>
                    <button type="button" className="cad-sk-link-btn is-danger" data-link-delete={l.id} onClick={() => removeLink(l.id)}>
                      Delete
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {refs === 'all' ? <Hint>Purple curves follow the model and are re-projected at every rebuild. Break link makes them ordinary geometry.</Hint> : null}
        </div>
      ) : null}
    </>
  );
}
