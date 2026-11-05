/**
 * Requests as a browser page on a given host sends them (host-check*.test.js): a DNS-rebinding
 * page on http://evil.example:PORT, once evil.example resolves to 127.0.0.1, reaches this PC's
 * server with Host and Origin both evil.example:PORT and Fetch Metadata "same-origin".
 */
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * One request from a page on `hostname` to the server on `port` (127.0.0.1): Host and (unless
 * `origin: false`, as a same-origin GET sends it) Origin are the page's. An event stream is read
 * for a moment, then closed.
 * @returns {Promise<{ status: number, type: string, text: string, json: any }>}
 */
export function asPage(port, hostname, { method = 'GET', path, body, origin = true } = {}) {
  const host = `${hostname}:${port}`;
  const headers = { host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };
  if (origin) headers.origin = `http://${host}`;
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  if (data) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(data.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      const done = () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), text, json });
      };
      if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
        setTimeout(() => {
          req.destroy();
          done();
        }, 300);
      } else {
        res.on('end', done);
      }
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** What a page on a host the server doesn't answer on gets: 403, the reason and the host, and none of the route's data. */
export function assertRefused(r, hostname, what) {
  assert.equal(r.status, 403, `${what}: ${r.text.slice(0, 200)}`);
  assert.match(r.type, /application\/json/, `${what}: a JSON refusal, not the route's own content`);
  assert.equal(r.json?.ok, false, what);
  assert.equal(r.json?.reason, 'host', what);
  assert.ok(r.json.error.includes(`"${hostname}"`), `${what}: names the host`);
  assert.deepEqual(Object.keys(r.json).sort(), ['error', 'ok', 'reason'], `${what}: nothing of the route's data`);
}
