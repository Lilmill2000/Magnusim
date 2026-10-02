import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstFreeStudyName, newPluginStudy, shownStudyTitles, takenStudyTitles, type CreateAnswer, type NewStudyHost } from './studyName';

afterEach(() => {
  document.body.replaceChildren();
});

// The workbench "+ New" runs in: the user is on project "proj" until moveTo, the
// prompt answers `name`, and create makes a study of a kind with a workspace.
function workbench(name: unknown = 'Part 2', answer: CreateAnswer = { json: { ok: true, study: { id: 'st-9', workspace: 'part' } } }) {
  let where = 'proj #/p/proj';
  const host = {
    shownTitles: vi.fn((): unknown[] => ['Part 1', ' part 2 ']),
    promptName: vi.fn(async (_opts: unknown): Promise<unknown> => name),
    create: vi.fn(async (_body: unknown): Promise<CreateAnswer> => answer),
    notice: vi.fn(async (_title: string, _copy: string): Promise<unknown> => undefined),
    sync: vi.fn(),
    where: () => where,
    open: vi.fn(),
  } satisfies NewStudyHost;
  return { host, moveTo: (to: string) => (where = to) };
}

describe('"+ New <kind>" for a plugin study', () => {
  it('asks for a name, creates the study and opens it in its workspace', async () => {
    const { host } = workbench();
    await newPluginStudy({ kind: 'part', title: 'Part', titles: ['Part 1'] }, host);
    expect(host.promptName).toHaveBeenCalledWith({ title: 'New Part', label: 'Name', value: 'Part 2', yes: 'Create' });
    expect(host.create).toHaveBeenCalledWith({ kind: 'part', title: 'Part 2' });
    expect(host.notice).not.toHaveBeenCalled();
    expect(host.sync).toHaveBeenCalledTimes(1);
    expect(host.open).toHaveBeenCalledWith('part', 'st-9');
  });

  it('only adds the row for a kind without a workspace', async () => {
    const { host } = workbench('Run 1', { json: { ok: true, study: { id: 'st-9', workspace: '' } } });
    await newPluginStudy({ kind: 'run', title: 'Run', titles: [] }, host);
    expect(host.create).toHaveBeenCalledWith({ kind: 'run', title: 'Run 1' });
    expect(host.sync).toHaveBeenCalledTimes(1);
    expect(host.open).not.toHaveBeenCalled();
  });

  it("offers the first free name among the titles sent, else among the plugin's rows shown", async () => {
    const sent = workbench();
    await newPluginStudy({ kind: 'part', title: 'Part', titles: [] }, sent.host);
    expect(sent.host.shownTitles).not.toHaveBeenCalled();
    expect(sent.host.promptName.mock.calls[0][0]).toMatchObject({ value: 'Part 1' });
    // The Workspaces menu sends no titles.
    const menu = workbench();
    await newPluginStudy({ kind: 'part', title: 'Part', open: true }, menu.host);
    expect(menu.host.shownTitles).toHaveBeenCalledTimes(1);
    expect(menu.host.promptName.mock.calls[0][0]).toMatchObject({ value: 'Part 3' });
  });

  it('trims the name, and creates nothing on Cancel or a blank name', async () => {
    for (const name of [null, '', '   ']) {
      const { host } = workbench(name);
      await newPluginStudy({ kind: 'part', title: 'Part', titles: [] }, host);
      expect(host.create).not.toHaveBeenCalled();
      expect(host.sync).not.toHaveBeenCalled();
      expect(host.open).not.toHaveBeenCalled();
    }
    const { host } = workbench('  Gear  ');
    await newPluginStudy({ kind: 'part', title: 'Part', titles: [] }, host);
    expect(host.create).toHaveBeenCalledWith({ kind: 'part', title: 'Gear' });
  });

  it('says why when the study is not created, and opens nothing', async () => {
    const refused = workbench('Part 1', { json: { ok: false, error: 'The disk is full' } });
    await newPluginStudy({ kind: 'part', title: 'Part', titles: [] }, refused.host);
    expect(refused.host.notice).toHaveBeenCalledWith('Could not create the study', 'The disk is full');
    expect(refused.host.sync).toHaveBeenCalledTimes(1);
    expect(refused.host.open).not.toHaveBeenCalled();
    const silent = workbench('Part 1', { json: null });
    await newPluginStudy({ kind: 'part', title: 'Part', titles: [] }, silent.host);
    expect(silent.host.notice).toHaveBeenCalledWith('Could not create the study', 'The study was not created.');
    expect(silent.host.open).not.toHaveBeenCalled();
  });

  it('adds the row but opens nothing when the user went elsewhere while it was named or made', async () => {
    // Another study opened (or Back pressed) while the name was asked.
    const named = workbench();
    named.host.promptName.mockImplementation(async () => {
      named.moveTo('proj #/p/proj/ws/cad/part/st-1');
      return 'Part 2';
    });
    await newPluginStudy({ kind: 'part', title: 'Part', titles: [] }, named.host);
    expect(named.host.create).toHaveBeenCalled();
    expect(named.host.sync).toHaveBeenCalledTimes(1);
    expect(named.host.open).not.toHaveBeenCalled();
    // Another project opened while the study was made.
    const made = workbench();
    made.host.create.mockImplementation(async () => {
      made.moveTo('other #/p/other');
      return { json: { ok: true, study: { id: 'st-9', workspace: 'part' } } };
    });
    await newPluginStudy({ kind: 'part', title: 'Part', titles: [] }, made.host);
    expect(made.host.sync).toHaveBeenCalledTimes(1);
    expect(made.host.open).not.toHaveBeenCalled();
  });
});

describe('the name a new plugin study is offered', () => {
  it('is "<Kind> 1" when the project has none', () => {
    expect(firstFreeStudyName('Part', [])).toBe('Part 1');
  });

  it('skips the numbers already taken and takes the first gap', () => {
    expect(firstFreeStudyName('Part', ['Part 1', 'Part 2'])).toBe('Part 3');
    expect(firstFreeStudyName('Part', ['Part 1', 'Part 3'])).toBe('Part 2');
    expect(firstFreeStudyName('Part', ['Part 2'])).toBe('Part 1');
  });

  it('compares titles trimmed and ignoring case', () => {
    expect(firstFreeStudyName('Part', [' part 1 ', 'PART 2'])).toBe('Part 3');
    expect(firstFreeStudyName(' Demo analysis ', ['demo analysis 1'])).toBe('Demo analysis 2');
  });

  it('counts only exact "<Kind> N" titles', () => {
    expect(firstFreeStudyName('Part', ['Bracket', 'Part 1 copy', 'Part1'])).toBe('Part 1');
  });

  it('falls back to "Study" without a kind title', () => {
    expect(firstFreeStudyName('', ['Study 1'])).toBe('Study 2');
  });
});

describe('the study titles the STUDIES section shows', () => {
  it("reads the plugin's rows only", () => {
    document.body.innerHTML = `
      <ul data-plugin-studies-tree="1">
        <li data-plugin-study="a" data-plugin="cad"><div class="tree-row"><span class="tl">Part 1</span></div></li>
        <li data-plugin-study="b" data-plugin="other"><div class="tree-row"><span class="tl">Part 2</span></div></li>
        <li data-plugin-study="c" data-plugin="cad"><div class="tree-row"><span class="tl">Bracket</span></div></li>
      </ul>`;
    expect(shownStudyTitles('cad')).toEqual(['Part 1', 'Bracket']);
    expect(shownStudyTitles('none')).toEqual([]);
  });
});

// gate:l1-menus: a start action's study (API 1.4) is named without a prompt, with a
// name free across every plugin's studies and the project's geometries.
describe('a study made without asking (ask: false)', () => {
  it('takes the first free name and makes it, with no prompt', async () => {
    const { host } = workbench();
    await newPluginStudy({ kind: 'demo', title: 'Demo', titles: ['Demo 1'] }, host, { ask: false });
    expect(host.promptName).not.toHaveBeenCalled();
    expect(host.create).toHaveBeenCalledWith({ kind: 'demo', title: 'Demo 2' });
    expect(host.open).toHaveBeenCalledWith('part', 'st-9');
  });

  it("counts another plugin's studies and the geometry names as taken", () => {
    const taken = takenStudyTitles({
      plugin_studies: [{ title: 'Demo 1' }, { title: 'Wing' }],
      geometries: [{ name: 'Demo 2' }, { name: '' }],
    });
    expect(taken).toEqual(['Demo 1', 'Wing', 'Demo 2']);
    expect(firstFreeStudyName('Demo', taken)).toBe('Demo 3');
    expect(takenStudyTitles(null)).toEqual([]);
  });
});
