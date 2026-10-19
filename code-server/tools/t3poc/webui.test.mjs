import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createRelay } from './t3poc.mjs';

async function fixture(t, respond) {
  const upstream = http.createServer(respond);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const relay = createRelay({
    endpoint: '127.0.0.1',
    getEndpoint: async () => '127.0.0.1',
    getToken: async () => 'test-only',
    clientHost: '127.0.0.1:8787',
    request: http.request,
    upstreamPort: upstream.address().port,
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => {
    relay.closeAllConnections();
    relay.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  return `http://127.0.0.1:${relay.address().port}`;
}

for (const encoding of ['identity', 'gzip', 'br']) {
  test(`auth document is repaired with correct framing (${encoding})`, async (t) => {
    const original = '<html><head><title>Auth</title></head><body>card</body></html>';
    const bytes =
      encoding === 'gzip'
        ? gzipSync(original)
        : encoding === 'br'
          ? brotliCompressSync(original)
          : Buffer.from(original);
    const url = await fixture(t, (req, res) => {
      assert.equal(req.headers['accept-encoding'], 'identity');
      assert.equal(req.headers['if-none-match'], undefined);
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': bytes.length,
        'content-encoding': encoding,
        etag: 'old',
        'content-security-policy': "default-src 'self'",
      });
      res.end(bytes);
    });
    const res = await fetch(`${url}/connect-agent?state=public-test`, { headers: { 'if-none-match': 'old' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), null);
    assert.equal(res.headers.get('content-encoding'), null);
    assert.equal(res.headers.get('etag'), null);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'self'");
    assert.match(await res.text(), /<link rel="stylesheet" href="\/\.t3poc\/auth-layout.css"><\/head>/);
    const style = await fetch(`${url}/.t3poc/auth-layout.css`);
    assert.match(await style.text(), /#root:has\(> \.min-h-screen > section\)/);
  });
}

test('only public content-hashed build assets gain immutable caching', async (t) => {
  const url = await fixture(t, (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/javascript',
      'cache-control': req.url.includes('private') ? 'private, no-store' : 'no-cache',
    });
    res.end('export default 1;');
  });
  assert.match((await fetch(`${url}/assets/example-12345678.js`)).headers.get('cache-control'), /immutable/);
  for (const path of [
    '/api/session',
    '/assets/unhashed.js',
    '/assets/example-12345678.js?user=1',
    '/assets/private-12345678.js',
  ]) {
    assert.doesNotMatch((await fetch(url + path)).headers.get('cache-control'), /immutable/);
  }
});

test('API and streaming responses are neither buffered nor rewritten', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const url = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: first\n\n');
    await pending;
    res.end('data: last\n\n');
  });
  const res = await fetch(`${url}/api/events`);
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  release();
  assert.match(new TextDecoder().decode((await reader.read()).value), /last/);
});

test('oversized HTML passes through within the bounded transform budget', async (t) => {
  const original = `<html><head>${'x'.repeat(300 * 1024)}</head></html>`;
  const url = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(original);
  });
  assert.equal(await (await fetch(`${url}/`)).text(), original);
});

test('transient 429 on a bodyless GET is retried, but POST is never replayed', async (t) => {
  let gets = 0;
  let posts = 0;
  const url = await fixture(t, (req, res) => {
    if (req.method === 'GET' && ++gets > 1) {
      res.end('ready');
      return;
    }
    if (req.method === 'POST') posts++;
    res.writeHead(429, { 'retry-after': '0.1' });
    res.end('busy');
  });
  assert.equal(await (await fetch(`${url}/assets/example-12345678.js`)).text(), 'ready');
  assert.equal(gets, 2);
  assert.equal((await fetch(`${url}/oauth/token`, { method: 'POST', body: 'one-use' })).status, 429);
  assert.equal(posts, 1);
});

test('a long Retry-After is passed through rather than exceeding the retry budget', async (t) => {
  let calls = 0;
  const url = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(429, { 'retry-after': '60' });
    res.end('busy');
  });
  assert.equal((await fetch(`${url}/assets/example-12345678.js`)).status, 429);
  assert.equal(calls, 1);
});
