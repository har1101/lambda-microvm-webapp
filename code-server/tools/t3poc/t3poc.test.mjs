import assert from 'node:assert/strict';
import test from 'node:test';
import { findPairingUrl, isLoopback, parseArgs, upstreamHeaders } from './t3poc.mjs';

test('parses commands and flags', () => {
  assert.deepEqual(parseArgs(['relay', '--port', '9000']), { command: 'relay', opts: { port: '9000' } });
  assert.throws(() => parseArgs(['start', 'oops']));
});

test('extracts the pairing link printed by t3 auth pairing create --json', () => {
  const out = '{"id":"x","pairUrl":"http://127.0.0.1:8787/pair#token=ABCD1234EFGH"}';
  assert.equal(findPairingUrl(out), 'http://127.0.0.1:8787/pair#token=ABCD1234EFGH');
  assert.equal(findPairingUrl('nothing here'), null);
});

test('relay headers: AWS Host + proxy token, client loopback host for the in-VM shim, no spoofed values', () => {
  const h = upstreamHeaders(
    {
      host: '127.0.0.1:8787',
      origin: 'http://127.0.0.1:8787',
      'x-aws-proxy-auth': 'evil',
      'x-t3poc-host': 'evil',
      'x-forwarded-proto': 'https',
    },
    'mvm-1.lambda-microvm.ap-northeast-1.on.aws',
    'tok',
    '127.0.0.1:8787',
  );
  assert.equal(h.host, 'mvm-1.lambda-microvm.ap-northeast-1.on.aws');
  assert.equal(h['x-aws-proxy-auth'], 'tok');
  assert.equal(h['x-t3poc-host'], '127.0.0.1:8787');
  assert.equal(h.origin, 'http://127.0.0.1:8787');
  assert.equal(h['x-forwarded-proto'], undefined);
});

test('relay accepts loopback peers only', () => {
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('192.168.1.5'));
});
