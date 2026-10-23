/**
 * import_file (Core host tools spec 4.11, 13): a geometry file as a new geometry of the
 * project open in this window, the way + Add geometry adds one (never mode=replace: that
 * removes every geometry). The file is either one the person attached in the dock (by its
 * attachment_id, streamed from the attachment store as the raw upload) or a path the person
 * typed in this turn's own message, character for character: a path from anywhere else
 * (a file, a page, a tool result, an app on this PC) is refused, as the import route reads
 * any path it is given. A browser can't open its file picker for the model.
 */
import { basename, extname } from 'node:path';
import type { ToolCtx, ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import {
  conversationOf,
  emitSync,
  fail,
  failed,
  hostTool,
  isRecord,
  num,
  objectSchema,
  offeredIn,
  okDone,
  promptOf,
  quoted,
  S,
  str,
  text,
  via,
  writableProject,
  type HostToolDeps,
  type HostToolDef,
} from './common.ts';

export const GEOMETRY_EXTS = ['.step', '.stp', '.iges', '.igs', '.brep', '.brp', '.stl', '.obj', '.ply'];
const MESH_EXTS = ['.stl', '.obj', '.ply'];
/** The length units of the units dialog, as the import (and /api/prefs) take them. */
export const LENGTH_UNITS: Readonly<Record<string, string>> = Object.freeze({ mm: 'MM', cm: 'CM', m: 'M', in: 'INCH' });
const NEEDS_FILE_HINT = 'Ask the person to attach it with the paper-clip in the Assistant panel, or to use + Add geometry. A browser can\'t open its file picker for you.';

/** Whether `path` appears in the person's own message exactly as given. */
export function typedInPrompt(prompt: string | null, path: string): boolean {
  return !!prompt && !!path && prompt.includes(path);
}

export function importFileTool(d: HostToolDeps): HostToolDef {
  const contexts = ['workbench'] as const;
  return hostTool({
    name: 'import_file',
    title: 'Import a geometry file',
    description:
      'Adds a geometry file to the project open here: a file the person attached (attachment_id) or a path the person typed in this message (path). STL/OBJ/PLY need length_unit. Unused fields: "".',
    schema: objectSchema({
      project_id: S.id('"" = this window\'s project'),
      attachment_id: S.text(40, 'a file the person attached in the dock; "" when path'),
      path: S.text(1024, 'only a path the person typed in this message; "" otherwise'),
      as: S.enum(['geometry']),
      length_unit: S.enum(['', 'mm', 'cm', 'm', 'in'], 'STL/OBJ/PLY need one (the units dialog); "" for STEP/IGES/BREP'),
    }),
    risk: 'compute',
    projectData: true,
    priority: 56,
    stallMs: 120_000,
    contexts,
    available: offeredIn(contexts, (ctx: ToolCtx) => (ctx.projectId ? true : 'No project is open in this window.')),
    projectOf: (_input, ctx) => ctx.projectId,
    describe: (input) => ({
      line: `Import ${str(input.attachment_id) ? 'the attached file' : cleanText(basename(str(input.path)), 120)}`,
      detail: [
        { label: 'File', value: str(input.attachment_id) ? `attachment ${cleanText(str(input.attachment_id), 40)}` : cleanText(basename(str(input.path)), 120) },
        ...(str(input.length_unit) ? [{ label: 'Units', value: str(input.length_unit) }] : []),
      ],
    }),
    gateText: (input) => ({
      title: `Allow the Assistant to import ${str(input.attachment_id) ? 'the attached file' : quoted(basename(str(input.path)))}?`,
      copy: 'Adds it to this project as a new geometry and makes its preview.',
    }),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const attachment = str(input.attachment_id).trim();
      const path = str(input.path);
      const unit = str(input.length_unit);
      try {
        const project = await writableProject(input, rt.ctx, d.hostCall, rt);
        if (!attachment && !path.trim()) return fail('needs_file', 'No file to import.', NEEDS_FILE_HINT);
        let name = '';
        let r: Record<string, unknown>;
        const o = via(rt, 'import_file');
        if (attachment) {
          const opened = d.attachments ? await d.attachments.open(attachment, conversationOf(rt.ctx)) : null;
          if (!opened) return fail('not_found', 'No such attached file in this conversation.', NEEDS_FILE_HINT);
          name = opened.name;
          const ext = extname(name).toLowerCase();
          if (!GEOMETRY_EXTS.includes(ext)) return fail('invalid_input', 'Only STEP, IGES, BREP, STL, OBJ and PLY files are geometry.');
          if (MESH_EXTS.includes(ext) && !unit) {
            (opened.stream as { destroy?: () => void }).destroy?.();
            return fail('invalid_input', `${cleanText(name, 80)} is a mesh file: say its length unit (mm, cm, m or in).`, 'Ask the person which unit the file is in.');
          }
          rt.progress(null, `Importing ${cleanText(name, 80)}`);
          r = (await d.hostCall(
            'geometry.import_raw',
            { project_id: project, filename: name, length_unit: unit ? LENGTH_UNITS[unit] : '', raw: { stream: opened.stream, bytes: opened.bytes, type: 'application/octet-stream' } },
            o,
          )) as Record<string, unknown>;
        } else {
          // Only a path the person typed in this turn's own message (an app on this PC or a
          // coding agent has none).
          if (!typedInPrompt(promptOf(rt.ctx), path)) return fail('path_not_typed', 'Only a path the person typed in their message can be imported.', NEEDS_FILE_HINT);
          const ext = extname(path).toLowerCase();
          if (!GEOMETRY_EXTS.includes(ext)) return fail('invalid_input', 'Only STEP, IGES, BREP, STL, OBJ and PLY files are geometry.');
          const st = d.statFile ? await d.statFile(path) : null;
          if (!st || !st.file) return fail('not_found', 'There is no file at that path.', 'Ask the person to check the path, or to attach the file.');
          if (MESH_EXTS.includes(ext) && !unit) return fail('invalid_input', 'That is a mesh file: say its length unit (mm, cm, m or in).', 'Ask the person which unit the file is in.');
          name = basename(path);
          rt.progress(null, `Importing ${cleanText(name, 80)}`);
          r = (await d.hostCall('geometry.import_path', { project_id: project, step_path: path, length_unit: unit ? LENGTH_UNITS[unit] : '' }, { ...o, prompt: promptOf(rt.ctx) })) as Record<string, unknown>;
        }
        const added = isRecord(r.added) ? r.added : {};
        const shown = isRecord(r.geometry) ? r.geometry : {};
        const id = str(added.id);
        emitSync(d, rt, { project_id: project, simulation_id: null, kinds: ['geometry', 'active', 'tree'], ids: { geometry: [id] }, revs: {}, active: { geometry: id }, tool: 'import_file' });
        return okDone({
          done: `Imported ${quoted(name)} as geometry ${quoted(added.name)}; it is now shown.`,
          ids: { geometry: id },
          hint: "read_setup {what:'faces'} lists its faces; study_edit {action:'create'} makes a study on it.",
          detail: {
            name: text(added.name),
            representation: text(added.representation, 20),
            bodies: Array.isArray(shown.bodies) ? shown.bodies.length : num(added.n_solids),
            faces: num(added.n_faces),
          },
        });
      } catch (err) {
        return failed(err);
      }
    },
  });
}
