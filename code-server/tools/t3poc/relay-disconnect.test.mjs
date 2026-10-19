import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';
import { createRuntime, relay } from './t3poc.mjs';

function runtime() {
  let now = 1000;
  const api = createRuntime({ now: () => now, readState: () => null, writeState() {}, log() {} });
  api.attach({ microvmId: 'vm', endpoint: 'vm.example', vmState: 'RUNNING', diskPrepared: true });
  return {
    api,
    advance: () => {
      now += 310000;
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('production HTTP relay destroys orphan upstream and ignores bytes after client disconnect', async (t) => {
  const { api, advance } = runtime();
  let upstreamRequest, upstreamResponse;
  const server = await relay(
    api,
    { port: '0' },
    {
      getToken: async () => 'dummy',
      request(_options, callback) {
        upstreamRequest = new PassThrough();
        process.nextTick(() => {
          upstreamResponse = new PassThrough();
          upstreamResponse.statusCode = 200;
          upstreamResponse.headers = {};
          callback(upstreamResponse);
          upstreamResponse.write('first');
        });
        return upstreamRequest;
      },
    },
  );
  t.after(() => {
    upstreamRequest?.destroy();
    upstreamResponse?.destroy();
    server.closeAllConnections();
    server.close();
  });
  await once(server, 'listening');
  const disconnected = new Promise((resolve) =>
    server.once('connection', (socket) => {
      socket.once('end', resolve);
      socket.once('close', resolve);
    }),
  );
  const response = await new Promise((resolve) =>
    http.get(`http://127.0.0.1:${server.address().port}/stream`, resolve),
  );
  await once(response, 'data');
  response.destroy();
  await once(response, 'close');
  await disconnected;
  for (let i = 0; i < 10; i++) await settle();
  const lastByte = api.session.lastActivityAt;
  advance();
  upstreamResponse.emit('data', Buffer.from('orphan heartbeat'));
  assert.equal(api.session.lastActivityAt, lastByte, 'closed clients must not keep the VM active');
  assert.equal(upstreamRequest.destroyed, true);
  assert.equal(upstreamResponse.destroyed, true);
  assert.equal(api.session.inflight, 0);
});

test('production websocket relay destroys orphan upstream and ignores bytes after client disconnect', async (t) => {
  const { api, advance } = runtime();
  let upstream;
  const server = await relay(
    api,
    { port: '0' },
    {
      getToken: async () => 'dummy',
      connect(_options, connected) {
        let replied = false;
        upstream = new Duplex({
          read() {},
          write(_chunk, _encoding, done) {
            if (!replied) {
              replied = true;
              this.push('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
            }
            done();
          },
        });
        queueMicrotask(connected);
        return upstream;
      },
    },
  );
  t.after(() => {
    upstream?.destroy();
    server.close();
  });
  await once(server, 'listening');
  const disconnected = new Promise((resolve) =>
    server.once('connection', (socket) => {
      socket.once('end', resolve);
      socket.once('close', resolve);
    }),
  );
  const client = net.connect(server.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await once(client, 'data');
  client.destroy();
  await once(client, 'close');
  await disconnected;
  for (let i = 0; i < 10; i++) await settle();
  const lastByte = api.session.lastActivityAt;
  advance();
  upstream.emit('data', Buffer.from('orphan heartbeat'));
  assert.equal(api.session.lastActivityAt, lastByte, 'closed websocket must not keep the VM active');
  assert.equal(upstream.destroyed, true);
  assert.equal(api.session.inflight, 0);
});

test('disconnect during production readiness does not create an upstream for a dead client', async (t) => {
  const { api } = runtime();
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  api.hooks.beforeRequest.push(async () => {
    entered();
    await gate;
  });
  let upstreamCalls = 0;
  const server = await relay(
    api,
    { port: '0' },
    {
      getToken: async () => 'dummy',
      request() {
        upstreamCalls++;
        return new PassThrough();
      },
    },
  );
  t.after(() => {
    release();
    server.closeAllConnections();
    server.close();
  });
  await once(server, 'listening');
  const disconnected = new Promise((resolve) =>
    server.once('connection', (socket) => {
      socket.once('end', resolve);
      socket.once('close', resolve);
    }),
  );
  const client = net.connect(server.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write('GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n');
  await waiting;
  client.destroy();
  await once(client, 'close');
  await disconnected;
  for (let i = 0; i < 10; i++) await settle();
  release();
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(upstreamCalls, 0);
  assert.equal(api.session.inflight, 0);
});

test('normal HTTP completion preserves the upstream keep-alive socket', async (t) => {
  let connections = 0;
  const origin = http.createServer((_req, res) => res.end('ok'));
  origin.on('connection', () => {
    connections++;
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const { api } = runtime();
  const server = await relay(
    api,
    { port: '0' },
    {
      getToken: async () => 'dummy',
      request(options, callback) {
        return http.request({ ...options, host: '127.0.0.1', port: origin.address().port, agent }, callback);
      },
    },
  );
  t.after(() => {
    agent.destroy();
    origin.closeAllConnections();
    origin.close();
    server.closeAllConnections();
    server.close();
  });
  await once(server, 'listening');
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(await response.text(), 'ok');
    await settle();
  }
  assert.equal(connections, 1);
});

test('websocket reset during readiness is handled before opening an upstream', async (t) => {
  const { api } = runtime();
  let release, entered, peer;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  api.hooks.beforeRequest.push(async () => {
    entered();
    await gate;
  });
  const server = await relay(
    api,
    { port: '0' },
    {
      getToken: async () => 'dummy',
      connect() {
        throw Error('dead client must not connect');
      },
    },
  );
  server.once('connection', (socket) => {
    peer = socket;
  });
  t.after(() => {
    release();
    server.close();
  });
  await once(server, 'listening');
  const client = net.connect(server.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await waiting;
  assert.doesNotThrow(() => peer.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
  release();
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(api.session.inflight, 0);
});

test('HTTP upstream reset aborts the response without an unhandled stream error', async (t) => {
  const { api } = runtime();
  let upReq, upRes;
  const server = await relay(
    api,
    { port: '0' },
    {
      getToken: async () => 'dummy',
      request(_options, callback) {
        upReq = new PassThrough();
        process.nextTick(() => {
          upRes = new PassThrough();
          upRes.statusCode = 200;
          upRes.headers = {};
          callback(upRes);
          upRes.write('first');
        });
        return upReq;
      },
    },
  );
  t.after(() => {
    upReq?.destroy();
    upRes?.destroy();
    server.closeAllConnections();
    server.close();
  });
  await once(server, 'listening');
  const response = await new Promise((resolve) =>
    http.get(`http://127.0.0.1:${server.address().port}/stream`, resolve),
  );
  response.on('error', () => {});
  const closed = new Promise((resolve) => response.once('close', resolve));
  await once(response, 'data');
  assert.doesNotThrow(() => upRes.emit('error', new Error('upstream reset')));
  await closed;
  assert.equal(upReq.destroyed, true);
  assert.equal(upRes.destroyed, true);
  assert.equal(api.session.inflight, 0);
});
