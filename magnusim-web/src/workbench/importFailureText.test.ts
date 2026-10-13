import { describe, expect, it } from 'vitest';
import { importFailureText } from './importFailureText';

/** A vtk.js reader's rejection: its fetchBinary reads the reply as an ArrayBuffer. */
function readerRejection(status: number, body: string) {
  const bytes = new TextEncoder().encode(body);
  return { xhr: { status, statusText: '', responseType: 'arraybuffer', response: bytes.buffer }, e: {} };
}

describe('importFailureText', () => {
  it('keeps an Error message and a plain string', () => {
    expect(importFailureText(new Error('could not read geometry'))).toBe('could not read geometry');
    expect(importFailureText('file too large to upload')).toBe('file too large to upload');
  });

  it('reads a server body, with its detail', () => {
    expect(importFailureText({ error: 'CAD preview failed', detail: 'worker timeout after 180 s' })).toBe(
      'CAD preview failed (worker timeout after 180 s)',
    );
    expect(importFailureText({ error: { message: 'The worker stopped' } })).toBe('The worker stopped');
  });

  it("reads a reader's failed request: the status and the server's reason", () => {
    expect(importFailureText(readerRejection(404, JSON.stringify({ error: 'no geometry imported' })))).toBe(
      'The server answered 404: no geometry imported',
    );
    expect(importFailureText(readerRejection(500, '<html>Internal</html>'))).toBe('The server answered 500');
    expect(
      importFailureText({ xhr: { status: 503, responseType: 'text', responseText: '{"error":"Updating box."}' } }),
    ).toBe('The server answered 503: Updating box.');
    expect(importFailureText({ xhr: { status: 0 } })).toBe('The server did not answer (the connection was closed).');
  });

  it('never shows "[object Object]"', () => {
    for (const e of [{}, { error: {} }, new Error(String({})), null, undefined, { message: '[object Object]' }]) {
      const text = importFailureText(e);
      expect(text).not.toContain('[object');
      expect(text).toBe('The import failed for an unknown reason.');
    }
    expect(importFailureText({}, 'geometry import failed')).toBe('geometry import failed');
  });
});
