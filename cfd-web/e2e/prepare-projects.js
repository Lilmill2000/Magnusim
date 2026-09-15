/**
 * Seed an isolated MAGNUSIM_PROJECTS_ROOT for Playwright so tests never
 * read or write the developer's live cfd-web/projects/.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');
const FIXTURE_ID = 'sample-project-steady-state-e2e';
const FIXTURE_SRC = join(__dirname, 'fixtures', 'sample-project-steady-state');

function findLiveSample() {
  const liveRoot = join(WEB_ROOT, 'projects');
  if (!existsSync(liveRoot)) return null;
  const names = readdirSync(liveRoot);
  const hit = names.find((n) => n.startsWith('sample-project-steady-state') && n !== FIXTURE_ID);
  if (!hit) return null;
  const dir = join(liveRoot, hit);
  return existsSync(join(dir, 'project.json')) ? dir : null;
}

export function prepareE2eProjectsRoot() {
  const destRoot = resolve(__dirname, '.tmp-projects');
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { recursive: true });
  const dest = join(destRoot, FIXTURE_ID);
  cpSync(FIXTURE_SRC, dest, { recursive: true });

  const wsl = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
  if (wsl) {
    const live = findLiveSample();
    if (live) {
      const geomSrc = join(live, 'geometry');
      if (existsSync(geomSrc)) {
        cpSync(geomSrc, join(dest, 'geometry'), { recursive: true });
      }
    } else {
      const elbow = join(WEB_ROOT, 'python', 'tests', 'fixtures', 'elbow.step');
      if (existsSync(elbow)) {
        mkdirSync(join(dest, 'geometry'), { recursive: true });
        cpSync(elbow, join(dest, 'geometry', 'source.step'));
      }
    }
  }

  writeFileSync(
    join(destRoot, 'active.json'),
    JSON.stringify({ project_id: FIXTURE_ID, updated_at: new Date().toISOString() }, null, 2),
    'utf8',
  );
  return destRoot;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('prepare-projects.js')) {
  const root = prepareE2eProjectsRoot();
  process.stdout.write(root + '\n');
}
