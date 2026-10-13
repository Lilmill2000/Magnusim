/**
 * Plain words for why a geometry import failed, whatever was thrown. A server reply's
 * body ({ error, detail }) and a vtk.js reader's rejection ({ xhr, e }: the part's faces
 * or edges did not load) are plain objects, whose own text is "[object Object]".
 */

const MAX_LEN = 400;

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN - 1) + '…' : t;
}

/** A useful string, or '' for nothing or an object's default text. */
function usable(s: unknown): string {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t && !/^\[object \w+\]$/.test(t) ? t : '';
}

type XhrLike = {
  status?: number;
  statusText?: string;
  responseType?: string;
  responseText?: string;
  response?: unknown;
};

/** The body of a finished request as text ('' when it has none or it can't be read). */
function xhrBody(xhr: XhrLike): string {
  try {
    if (!xhr.responseType || xhr.responseType === 'text') return String(xhr.responseText || '');
    const res = xhr.response;
    if (typeof res === 'string') return res;
    // An ArrayBuffer or a typed array (checked by shape: it may come from another realm).
    if (res && typeof (res as ArrayBuffer).byteLength === 'number') {
      return new TextDecoder().decode(ArrayBuffer.isView(res) ? res : new Uint8Array(res as ArrayBuffer));
    }
  } catch (_) {
    /* no body */
  }
  return '';
}

/** Why a request the reader made failed: the server's own reason when its reply has one. */
function xhrText(xhr: XhrLike): string {
  const status = Number(xhr.status) || 0;
  if (!status) return 'The server did not answer (the connection was closed).';
  const body = xhrBody(xhr).trim();
  let reason = '';
  if (body) {
    try {
      reason = reasonOf(JSON.parse(body), 0);
    } catch (_) {
      reason = body.startsWith('<') ? '' : body;
    }
  }
  if (!reason) reason = usable(xhr.statusText);
  return 'The server answered ' + status + (reason ? ': ' + reason : '');
}

function reasonOf(e: unknown, depth: number): string {
  if (e == null || depth > 4) return '';
  if (typeof e === 'string') return usable(e);
  if (typeof e !== 'object') return usable(String(e));
  const o = e as Record<string, unknown>;
  if (o.xhr && typeof o.xhr === 'object') return xhrText(o.xhr as XhrLike);
  const own = usable(o.message) || reasonOf(o.error, depth + 1) || reasonOf(o.reason, depth + 1);
  const detail = reasonOf(o.detail, depth + 1);
  if (own && detail && !own.includes(detail)) return own + ' (' + detail + ')';
  return own || detail || reasonOf(o.cause, depth + 1);
}

/** The dialog's text for a failed import: the reason in plain words, else the fallback. */
export function importFailureText(e: unknown, fallback = 'The import failed for an unknown reason.'): string {
  const why = reasonOf(e, 0);
  return why ? clip(why) : fallback;
}
