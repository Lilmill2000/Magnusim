// @ts-check
/**
 * GET/POST /api/prefs and POST /api/prefs/hardware-check
 */
import { clampPort, listenPort, publicPrefs, writeLocalDoc } from './prefs.js';
import { runHardwareCheck } from './hardware-profile.js';
import { envGet } from './env-compat.js';

export async function handlePrefsApi(req, res, u, parts, { sendJson, readJsonBody }) {
  if (parts[0] !== 'api' || parts[1] !== 'prefs') return false;

  if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
    return sendJson(res, 200, {
      ...publicPrefs(),
      listen_port: listenPort(),
    });
  }

  if (req.method === 'POST' && parts[2] === 'hardware-check') {
    try {
      const hardware = runHardwareCheck();
      return sendJson(res, 200, { ok: true, hardware, prefs: publicPrefs() });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  }

  if (req.method === 'POST' && !parts[2]) {
    const body = (await readJsonBody(req)) || {};
    const patch = {};
    if (body.units != null) {
      patch.units = /imperial/i.test(String(body.units)) ? 'Imperial' : 'Metric';
      patch.length_unit = patch.units === 'Imperial' ? 'INCH' : 'MM';
    }
    if (body.length_unit != null) {
      const lu = String(body.length_unit).toUpperCase();
      if (['MM', 'CM', 'M', 'INCH'].includes(lu)) patch.length_unit = lu;
    }
    if (body.port != null) {
      const p = clampPort(body.port);
      if (p == null) {
        return sendJson(res, 400, { ok: false, error: 'Port must be an integer from 1024 to 65535' });
      }
      patch.port = p;
    }
    if (body.wizard_completed != null) patch.wizard_completed = !!body.wizard_completed;
    if (body.collapse_completed_sections != null) {
      patch.collapse_completed_sections = !!body.collapse_completed_sections;
    }
    writeLocalDoc(patch);
    const prefs = publicPrefs();
    const bound = clampPort(envGet('BOUND_PORT')) || listenPort();
    return sendJson(res, 200, {
      ok: true,
      prefs,
      restart_required: prefs.port !== bound,
      bound_port: bound,
    });
  }

  return sendJson(res, 404, { ok: false, error: 'unknown /api/prefs route' });
}

export function boundPortFromListen(server) {
  try {
    const addr = server && server.httpServer && server.httpServer.address();
    if (addr && typeof addr === 'object' && addr.port) return addr.port;
  } catch {
    /* ignore */
  }
  return listenPort();
}
