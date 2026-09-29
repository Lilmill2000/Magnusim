import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalOperator } from '../http.ts';

function req(host, extra = {}, remote = '127.0.0.1') {
  return { headers: { host, ...extra }, socket: { remoteAddress: remote } };
}

// gate:h6-local-operator — plugin management only for a browser on this PC.
describe('isLocalOperator', () => {
  it('accepts loopback hosts reached directly', () => {
    assert.equal(isLocalOperator(req('127.0.0.1:8082')), true);
    assert.equal(isLocalOperator(req('localhost:8082')), true);
    assert.equal(isLocalOperator(req('[::1]:8082', {}, '::1')), true);
  });
  it('refuses the public tunnel host, proxies and remote peers', () => {
    assert.equal(isLocalOperator(req('simulation.lilmill2000.com')), false);
    assert.equal(isLocalOperator(req('127.0.0.1:8082', { 'x-forwarded-for': '203.0.113.9' })), false);
    assert.equal(isLocalOperator(req('127.0.0.1:8082', { 'cf-connecting-ip': '203.0.113.9' })), false);
    assert.equal(isLocalOperator(req('127.0.0.1:8082', {}, '192.168.1.20')), false);
  });
});
