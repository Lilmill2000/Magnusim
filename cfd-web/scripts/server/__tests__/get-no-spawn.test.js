/**
 * GET hydrate / catalog / materials must never start project_cli.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { handleProjectHydrate } from '../../project-hydrate.js';
import { getMaterials } from '../../w18-materials.js';
import { getRunStatus } from '../../w27-solve.js';
import { getSimulation } from '../../w17-simulation.js';

describe('GET-no-spawn', () => {
  before(() => {
    process.env.CFDDESK_FORBID_PROJECT_CLI = '1';
  });

  it('hydrate + catalog + materials GET do not spawn project_cli', () => {
    const sent = [];
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
    };
    const sendJson = (_r, status, body) => {
      sent.push({ status, body });
    };
    handleProjectHydrate(
      { method: 'GET' },
      res,
      new URL('http://127.0.0.1/api/project/hydrate?project_id=no-such-project'),
      { sendJson },
    );
    assert.equal(sent.length, 1);
    assert.ok(sent[0].status === 404 || sent[0].status === 400);

    assert.doesNotThrow(() => getMaterials('no-such-project'));
    assert.doesNotThrow(() => getSimulation('no-such-project'));
    assert.doesNotThrow(() => getRunStatus('no-such-project'));
  });
});
