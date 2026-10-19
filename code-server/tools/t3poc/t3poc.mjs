#!/usr/bin/env node
// t3poc — run on your Mac. No credentials are written to disk by this tool:
// AWS credentials come from your SSO profile, MicroVM tokens live in memory,
// and ~/.t3poc/state.json holds only the MicroVM id and endpoint.
// Extensions in ext-*.mjs add lazy start, pairing, GitHub tokens, idle, and history.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { macKeychain } from './keychain.mjs';

export const REGION = process.env.T3POC_REGION ?? 'ap-northeast-1';
process.env.AWS_PROFILE ??= 'fukuchi';
const STATE_DIR = path.join(os.homedir(), '.t3poc');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const APP_PORT = 8080;
const TOKEN_MINUTES = 60;
const REFRESH_BEFORE_MS = 15 * 60_000;
const BOOLEAN_FLAGS = new Set(['inject-logins']);
const connector = (name) => `arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:${name}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error(`unexpected argument: ${rest[i]}`);
    const name = rest[i].slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    opts[name] = rest[i + 1];
    i++;
  }
  return { command, opts };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const safe = {
    microvmId: state.microvmId,
    endpoint: state.endpoint,
    region: state.region ?? REGION,
    expiresAt: state.expiresAt,
    startedAt: state.startedAt,
  };
  if (state.diskPrepared === true || state.diskPrepared === false) safe.diskPrepared = state.diskPrepared;
  if (Array.isArray(state.cleanupMicrovmIds)) safe.cleanupMicrovmIds = state.cleanupMicrovmIds;
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

const mvm = () => new LambdaMicrovmsClient({ region: REGION });

export function publicState(session) {
  const safe = {
    microvmId: session.microvmId,
    endpoint: session.endpoint,
    region: REGION,
    expiresAt: session.expiresAt,
    startedAt: session.startedAt,
  };
  // diskPrepared is a boolean flag, never a credential. Absent means "already
  // prepared" so an older state file is not restored over a live VM.
  if (session.diskPrepared === true || session.diskPrepared === false) safe.diskPrepared = session.diskPrepared;
  if (Array.isArray(session.cleanupMicrovmIds)) safe.cleanupMicrovmIds = [...session.cleanupMicrovmIds];
  return safe;
}

export function createRuntime(deps) {
  const session = {
    microvmId: null,
    endpoint: null,
    expiresAt: null,
    startedAt: null,
    vmState: 'ABSENT',
    lastActivityAt: deps.now ? deps.now() : Date.now(),
    swapping: false,
    // Diagnostic connection count only; idle policy deliberately uses bytes.
    inflight: 0,
  };
  const hooks = {
    beforeRequest: [],
    prepareDisk: [],
    onVmReady: [],
    onTick: [],
    beforeSwap: [],
    beforeStop: [],
    onResume: [],
  };
  const flags = { t3Stopped: false, historyRestored: false, prepareDisk: false, pairingSnapshotAt: 0 };
  let readyFor = null;
  let failedReadyFor = null;
  let readyRetryAt = 0;
  let inflightReady = null;
  let lifecycle = Promise.resolve();
  let ticking = null;
  let preparing = null;
  const api = {
    deps,
    session,
    hooks,
    flags,
    now: () => (deps.now ? deps.now() : Date.now()),
    log: (message) => (deps.log ?? console.log)(String(message)),
    readState: () => deps.readState(),
    attach(next) {
      Object.assign(session, next);
    },
    writeState() {
      if (!flags.deferState) deps.writeState(publicState(session));
    },
    async recoverCleanup(force = false) {
      if (!force && api.now() < (flags.nextCleanupAt ?? 0)) throw new Error('MicroVM cleanup retry deferred');
      const saved = deps.readState();
      const journal = session.microvmId ? session : saved;
      for (const id of [...(journal?.cleanupMicrovmIds ?? [])]) {
        if (id === journal.microvmId) throw new Error('invalid MicroVM cleanup journal');
        try {
          await deps.terminate(id);
        } catch (error) {
          if (error.name !== 'ResourceNotFoundException') {
            flags.nextCleanupAt = api.now() + 60_000;
            throw error;
          }
        }
        flags.nextCleanupAt = 0;
        journal.cleanupMicrovmIds = journal.cleanupMicrovmIds.filter((value) => value !== id);
        deps.writeState(publicState(journal));
      }
    },
    exclusive(fn) {
      const next = lifecycle.then(fn);
      lifecycle = next.catch(() => {});
      return next;
    },
    async emitVmReady() {
      if (preparing) return preparing;
      preparing = api.prepareVm().finally(() => {
        preparing = null;
      });
      return preparing;
    },
    async prepareVm() {
      if (!session.microvmId || readyFor === session.microvmId) return;
      const id = session.microvmId;
      if (failedReadyFor === id && api.now() < readyRetryAt)
        throw new Error('VM readiness retry deferred for 60 seconds');
      try {
        if (flags.prepareDisk && session.diskPrepared !== true) {
          for (const fn of hooks.prepareDisk) await fn(api);
        }
        if (flags.t3Stopped) {
          const shell = await import('./vm-shell.mjs');
          const started = await deps.shell({ script: shell.START_T3 });
          if (!started.includes('T3POC_T3_STARTED')) throw new Error('T3 restart failed');
          flags.t3Stopped = false;
        }
        // Disk restoration has its own durable checkpoint. A later token or
        // clone failure must never restore pairing over a live VM again.
        session.diskPrepared = true;
        flags.prepareDisk = false;
        api.writeState();
        for (const fn of hooks.onVmReady) await fn(api);
        readyFor = id;
        failedReadyFor = null;
      } catch (error) {
        failedReadyFor = id;
        readyRetryAt = api.now() + 60_000;
        throw error;
      }
    },
    async ensureReady() {
      // The boot keeps running after a caller's 120s hold expires, so the next
      // request waits on the same MicroVM instead of starting a second one.
      if (!inflightReady) {
        inflightReady = api
          .exclusive(async () => {
            await api.recoverCleanup();
            for (const fn of hooks.beforeRequest) await fn(api);
            if (!session.endpoint) {
              const saved = deps.readState();
              if (!saved?.microvmId) throw new Error('no MicroVM recorded; run `t3poc start` first');
              api.attach({ ...saved, vmState: saved.vmState ?? 'RUNNING' });
            }
            if (session.vmState === 'RUNNING' && session.microvmId) {
              const prepared = session.diskPrepared === true;
              await api.emitVmReady();
              if (!prepared && session.diskPrepared === true) api.writeState();
            }
          })
          .finally(() => {
            inflightReady = null;
          });
      }
      const hold = deps.holdMs ?? 120_000;
      let timer;
      return Promise.race([
        inflightReady,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('MicroVM was not ready within 120000ms')), hold);
        }),
      ]).finally(() => clearTimeout(timer));
    },
    async backupHistory() {
      try {
        const mod = await import('./t3-history.mjs');
        return await mod.backupHistory(api);
      } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND') return { skipped: true };
        throw error;
      }
    },
    async restoreHistory() {
      try {
        const mod = await import('./t3-history.mjs');
        return await mod.restoreHistory(api);
      } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND') return { skipped: true };
        throw error;
      }
    },
    async wipPush() {
      try {
        const mod = await import('./workspace.mjs');
        return await mod.pushWip(api);
      } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND') return { skipped: true };
        throw error;
      }
    },
    async tick() {
      if (!ticking)
        ticking = (async () => {
          await api.exclusive(async () => {
            await api.recoverCleanup();
            if (!session.microvmId) {
              const saved = deps.readState();
              if (saved?.microvmId) {
                try {
                  const current = await deps.getMicrovm(saved.microvmId);
                  api.attach({ ...saved, vmState: current.state });
                } catch (error) {
                  if (error.name !== 'ResourceNotFoundException') throw error;
                }
              }
            }
          });
          for (const fn of hooks.onTick) await fn(api);
        })().finally(() => {
          ticking = null;
        });
      return ticking;
    },
  };
  return api;
}

export async function loadExtensions(api, dir = HERE) {
  const names = fs
    .readdirSync(dir)
    .filter((name) => /^ext-\d+-[\w-]+\.mjs$/.test(name))
    .sort();
  for (const name of names) {
    const mod = await import(`./${name}`);
    mod.register(api);
  }
}

async function proxyToken(microvmId, send = (command) => mvm().send(command)) {
  const res = await send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: TOKEN_MINUTES,
      allowedPorts: [{ port: APP_PORT }],
    }),
  );
  return {
    value: res.authToken['X-aws-proxy-auth'],
    refreshAt: Date.now() + TOKEN_MINUTES * 60_000 - REFRESH_BEFORE_MS,
  };
}

/** Auth tokens are scoped to a VM; never reuse one after a session switch. */
export function createProxyTokenCache(getSession, mint = proxyToken, now = Date.now) {
  const tokens = new Map();
  const pending = new Map();
  return async () => {
    for (;;) {
      const id = getSession().microvmId;
      let token = tokens.get(id);
      if (!token || now() >= token.refreshAt) {
        if (!pending.has(id))
          pending.set(
            id,
            Promise.resolve().then(() => mint(id)),
          );
        try {
          token = await pending.get(id);
        } finally {
          pending.delete(id);
        }
        tokens.clear();
        tokens.set(id, token);
      }
      if (getSession().microvmId === id) return token.value;
    }
  };
}

export function upstreamHeaders(incoming, endpoint, token, clientHost) {
  const out = {};
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (['host', 'x-aws-proxy-auth', 'x-t3poc-host', 'x-forwarded-proto', 'x-forwarded-host'].includes(lower)) {
      continue;
    }
    out[lower] = value;
  }
  out.host = endpoint;
  out['x-t3poc-host'] = clientHost;
  out['x-aws-proxy-auth'] = token;
  return out;
}

export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function createRelay({
  getEndpoint,
  getToken,
  getConnection = async () => ({ endpoint: await getEndpoint(), token: await getToken() }),
  clientHost,
  ensureReady = async () => {},
  onActivity = () => {},
  onDone = () => {},
  connect = tls.connect,
  request = https.request,
  upstreamPort = 443,
}) {
  const track = async () => {
    onActivity();
    await ensureReady();
  };
  const server = http.createServer(async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403);
      return res.end();
    }
    let counted = false;
    let finished = false;
    let upReq;
    let upRes;
    const finish = () => {
      finished = true;
      if (counted) {
        counted = false;
        onDone();
      }
      // A disconnected client must not leave a streaming response running.
      // Its subsequent bytes would otherwise refresh the VM's idle clock.
      if (!upRes?.readableEnded) {
        // Completed HTTP responses may already have returned their socket to
        // the keep-alive pool. Never destroy a pooled socket on normal close.
        if (!upRes?.complete) upReq?.destroy();
        upRes?.destroy();
      }
    };
    const activity = () => {
      if (!finished && !res.destroyed) onActivity();
    };
    // Register before readiness/token awaits: the client can disappear there.
    res.once('close', finish);
    try {
      await track();
      counted = true;
      if (finished || res.destroyed) {
        finish();
        return;
      }
    } catch (error) {
      if (finished || res.destroyed) return;
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end(`t3poc: not ready: ${error.message}\n`);
    }
    let token;
    let endpoint;
    try {
      ({ endpoint, token } = await getConnection());
    } catch (error) {
      finish();
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      return res.end(`t3poc: could not mint MicroVM token: ${error.name}\n`);
    }
    if (finished || res.destroyed) return;
    req.on('data', activity);
    upReq = request(
      {
        host: endpoint,
        port: upstreamPort,
        servername: endpoint,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req.headers, endpoint, token, clientHost),
      },
      (response) => {
        upRes = response;
        upRes.on('error', () => {
          finish();
          res.destroy();
        });
        if (finished || res.destroyed) {
          upRes.destroy();
          return;
        }
        upRes.on('data', activity);
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      },
    );
    upReq.on('error', (error) => {
      if (finished || res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`t3poc: upstream error ${error.code ?? error.name}\n`);
    });
    if (finished) upReq.destroy();
    else req.pipe(upReq);
  });
  server.on('upgrade', async (req, socket, head) => {
    if (!isLoopback(req.socket.remoteAddress)) return socket.destroy();
    let counted = false;
    let finished = false;
    let upstream;
    const finish = () => {
      finished = true;
      if (counted) {
        counted = false;
        onDone();
      }
      upstream?.destroy();
    };
    const activity = () => {
      if (!finished && !socket.destroyed) onActivity();
    };
    socket.once('close', finish);
    socket.on('error', () => {
      finish();
      socket.destroy();
    });
    socket.once('end', () => {
      finish();
      socket.destroy();
    });
    try {
      await track();
      counted = true;
      if (finished || socket.destroyed) {
        finish();
        return;
      }
    } catch {
      return socket.destroy();
    }
    socket.on('data', activity);
    let token;
    let endpoint;
    try {
      ({ endpoint, token } = await getConnection());
    } catch {
      finish();
      return socket.destroy();
    }
    if (finished || socket.destroyed) return;
    upstream = connect(
      { host: endpoint, port: upstreamPort, servername: endpoint, ALPNProtocols: ['http/1.1'] },
      () => {
        if (finished || socket.destroyed) return upstream.destroy();
        const headers = upstreamHeaders(req.headers, endpoint, token, clientHost);
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [key, value] of Object.entries(headers))
          for (const one of [].concat(value)) lines.push(`${key}: ${one}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      },
    );
    upstream.on('data', activity);
    upstream.on('close', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    if (finished) upstream.destroy();
  });
  return server;
}

export function findPairingUrl(text) {
  const match = text.match(/https?:\/\/127\.0\.0\.1:\d+\/pair#token=[A-Za-z0-9._~%+-]+/);
  return match ? match[0] : null;
}

function productionDeps(opts) {
  return {
    opts,
    env: process.env,
    now: () => Date.now(),
    holdMs: 120_000,
    readState,
    writeState,
    log: (message) => console.log(`${new Date().toISOString()} ${message}`),
    keychain: (service) => macKeychain(service),
    async accountId() {
      const identity = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
      return identity.Account;
    },
    async getMicrovm(id) {
      return mvm().send(new GetMicrovmCommand({ microvmIdentifier: id }));
    },
    async waitUntil(id, deadline) {
      while (Date.now() < deadline) {
        const current = await mvm().send(new GetMicrovmCommand({ microvmIdentifier: id }));
        if (current.state === 'RUNNING') return current;
        if (['FAILED', 'TERMINATED'].includes(current.state)) {
          throw new Error(`MicroVM ${current.state}: ${current.terminationMessage ?? ''}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error('MicroVM was not RUNNING before the deadline');
    },
    async startMicrovm({ allowExisting = false } = {}) {
      const existing = readState();
      if (!allowExisting && existing?.microvmId) {
        const current = await mvm()
          .send(new GetMicrovmCommand({ microvmIdentifier: existing.microvmId }))
          .catch((error) => {
            if (error.name === 'ResourceNotFoundException') return null;
            throw error;
          });
        if (current && !['TERMINATED', 'TERMINATING', 'FAILED'].includes(current.state)) {
          throw new Error(`MicroVM ${existing.microvmId} is still ${current.state}; run \`t3poc stop\` first`);
        }
      }
      const { Account } = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
      const maxDuration = Number(opts['max-duration-sec'] ?? 28800);
      if (!Number.isInteger(maxDuration) || maxDuration < 900 || maxDuration > 28800) {
        throw new Error('--max-duration-sec must be 900..28800');
      }
      const expiresAt = Date.now() + maxDuration * 1000;
      const run = await mvm().send(
        new RunMicrovmCommand({
          imageIdentifier: `arn:aws:lambda:${REGION}:${Account}:microvm-image:t3poc-task`,
          executionRoleArn: `arn:aws:iam::${Account}:role/t3poc-microvm-guest`,
          ingressNetworkConnectors: [connector('HTTP_INGRESS'), connector('SHELL_INGRESS')],
          egressNetworkConnectors: [connector('INTERNET_EGRESS')],
          idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: 28800, suspendedDurationSeconds: 28800 },
          maximumDurationInSeconds: maxDuration,
          runHookPayload: JSON.stringify({ sessionId: randomUUID(), expiresAt, authState: false }),
        }),
      );
      return { microvmId: run.microvmId, endpoint: run.endpoint, expiresAt, region: REGION };
    },
    async suspend(id) {
      await mvm().send(new SuspendMicrovmCommand({ microvmIdentifier: id }));
    },
    async resume(id) {
      await mvm().send(new ResumeMicrovmCommand({ microvmIdentifier: id }));
    },
    async terminate(id) {
      await mvm().send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
    },
    async shell(input) {
      const { shellExec } = await import('./vm-shell.mjs');
      const { WebSocket } = await import('ws');
      const res = await mvm().send(
        new CreateMicrovmShellAuthTokenCommand({ microvmIdentifier: sessionIdFrom(input), expirationInMinutes: 5 }),
      );
      return shellExec({
        endpoint: input.endpoint,
        token: res.authToken['X-aws-proxy-auth'],
        WebSocket,
        ...input,
      });
    },
    async s3Put(params) {
      const [{ S3Client, PutObjectCommand }] = await Promise.all([import('@aws-sdk/client-s3')]);
      await new S3Client({ region: REGION }).send(new PutObjectCommand(params));
    },
    async s3Get(params) {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const out = await new S3Client({ region: REGION }).send(
        new GetObjectCommand({ Bucket: params.Bucket, Key: params.Key }),
      );
      return Buffer.from(await out.Body.transformToByteArray());
    },
  };
}

function sessionIdFrom(input) {
  if (input.microvmId) return input.microvmId;
  const saved = readState();
  if (!saved?.microvmId) throw new Error('no MicroVM recorded');
  return saved.microvmId;
}

// productionDeps.shell needs the live session endpoint. Patch it once the runtime exists.
function bindShell(deps, api) {
  const inner = deps.shell.bind(deps);
  let pending = Promise.resolve();
  deps.shell = (input) => {
    const target = { endpoint: api.session.endpoint, microvmId: api.session.microvmId, ...input };
    const next = pending.then(() => inner(target));
    pending = next.catch(() => {});
    return next;
  };
}

async function start(api, opts) {
  const run = await api.deps.startMicrovm({ allowExisting: false });
  const startedAt = Date.now();
  api.attach({ ...run, vmState: 'STARTING', startedAt, lastActivityAt: startedAt, diskPrepared: false });
  api.writeState();
  const deadline = Date.now() + 450_000;
  process.stdout.write(`started ${run.microvmId}; waiting for RUNNING`);
  await api.deps.waitUntil(run.microvmId, deadline);
  api.attach({ vmState: 'RUNNING', lastActivityAt: Date.now() });
  api.flags.historyRestored = false;
  api.flags.prepareDisk = true;
  await api.emitVmReady();
  api.writeState();
  console.log(`\nendpoint: ${run.endpoint}\nends at:  ${new Date(run.expiresAt).toLocaleString()}`);
  console.log('next: `t3poc relay` (keep it running). The first T3 request can also boot the VM.');
  void opts;
}

export function createConnectionProvider(api, getToken) {
  return () => api.exclusive(async () => ({ endpoint: api.session.endpoint, token: await getToken() }));
}

export async function relay(api, opts, transport = {}) {
  const port = Number(opts.port ?? 8787);
  const getToken = transport.getToken ?? createProxyTokenCache(() => api.session);
  const timer = setInterval(() => {
    api.tick().catch((error) => api.log(error.message));
  }, 15_000);
  timer.unref?.();
  const server = createRelay({
    request: transport.request,
    connect: transport.connect,
    clientHost: `127.0.0.1:${port}`,
    ensureReady: async () => {
      api.session.inflight += 1;
      api.session.lastActivityAt = api.now();
      try {
        await api.ensureReady();
      } catch (error) {
        api.session.inflight = Math.max(0, api.session.inflight - 1);
        throw error;
      }
    },
    onDone: () => {
      api.session.inflight = Math.max(0, api.session.inflight - 1);
    },
    onActivity: () => {
      api.session.lastActivityAt = api.now();
    },
    getEndpoint: async () => api.session.endpoint,
    getToken,
    getConnection: createConnectionProvider(api, getToken),
  });
  server.once('close', () => clearInterval(timer));
  server.listen(port, '127.0.0.1', () => {
    api.log(`relay: http://127.0.0.1:${port} (lazy; first request boots the MicroVM); Ctrl+C to stop`);
  });
  return server;
}

export function pairingScript(cmd) {
  return `su -s /bin/sh vscode -c "${cmd}" 2>&1\n`;
}

async function pair(api, opts) {
  const { WebSocket } = await import('ws');
  const saved = api.readState();
  if (!saved?.microvmId) throw new Error('no MicroVM recorded; run `t3poc start` first');
  api.attach({ ...saved, vmState: 'RUNNING' });
  const port = Number(opts.port ?? 8787);
  const label = opts.label ?? `t3poc-${os.hostname()}`;
  const ttl = opts.ttl ?? '5m';
  const cmd = `t3 auth pairing create --base-dir /dev/shm/t3 --base-url http://127.0.0.1:${port} --label '${label.replace(/[^\w.-]/g, '')}' --ttl ${ttl.replace(/[^\w ]/g, '')} --json`;
  const res = await mvm().send(
    new CreateMicrovmShellAuthTokenCommand({ microvmIdentifier: saved.microvmId, expirationInMinutes: 5 }),
  );
  const token = res.authToken['X-aws-proxy-auth'];
  const ws = new WebSocket(`wss://${saved.endpoint}/shell`, [
    `lambda-microvms.authentication.${token}`,
    'lambda-microvms',
    'lambda-microvms.port.8022',
  ]);
  let out = '';
  const done = async (url) => {
    ws.close();
    if (url) {
      console.log(`pairing link (one-time, ${ttl}; treat as a password):\n${url}`);
      console.log('T3 Desktop: Settings → Connections → Add environment → paste the link (relay must be running).');
      try {
        const pairing = await import('./ext-30-pairing.mjs');
        await pairing.snapshot(api);
      } catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND') api.log(`pairing snapshot failed: ${error.message}`);
      }
    } else {
      console.error('could not read a pairing link from the MicroVM shell. Fallback:');
      console.error('  Lambda console → MicroVMs → this MicroVM → Connect, then run (as user vscode):');
      console.error(`  ${cmd}`);
      if (out) console.error(`--- shell output (last 600 chars) ---\n${out.slice(-600)}`);
      process.exitCode = 1;
    }
  };
  const timer = setTimeout(() => done(null), 30_000);
  ws.on('open', () => {
    ws.send(pairingScript(cmd));
  });
  ws.on('message', (data) => {
    out += data.toString();
    const url = findPairingUrl(out);
    if (url) {
      clearTimeout(timer);
      done(url);
    }
  });
  ws.on('error', (error) => {
    clearTimeout(timer);
    out += `\n[ws error] ${error.message}`;
    done(null);
  });
}

async function status(api) {
  const saved = api.readState();
  if (!saved?.microvmId) throw new Error('no MicroVM recorded; run `t3poc start` first');
  const current = await api.deps.getMicrovm(saved.microvmId);
  console.log(
    `${saved.microvmId} ${current.state} endpoint=${saved.endpoint} ends=${new Date(saved.expiresAt).toLocaleString()}`,
  );
}

export async function stop(api) {
  const saved = api.readState();
  if (!saved?.microvmId) throw new Error('no MicroVM recorded; run `t3poc start` first');
  await api.exclusive(async () => {
    api.attach(saved);
    let current;
    try {
      current = await api.deps.getMicrovm(saved.microvmId);
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
      current = { state: 'TERMINATED' };
    }
    api.attach({ vmState: current.state });
    if (!['TERMINATED', 'TERMINATING', 'FAILED'].includes(current.state)) {
      if (['SUSPENDED', 'SUSPENDING'].includes(current.state)) {
        await api.deps.resume(saved.microvmId);
        await api.deps.waitUntil(saved.microvmId, api.now() + 120_000);
        api.session.vmState = 'RUNNING';
        for (const fn of api.hooks.onResume) {
          try {
            await fn(api);
          } catch {
            api.log('resume hook failed during stop; attempting WIP with the available token');
          }
        }
      }
      // Preserve workspace changes before any optional pairing snapshot.
      // pushWip still throws on failure: never terminate after a failed push.
      await api.wipPush();
      for (const fn of api.hooks.beforeStop) await fn(api);
      await api.deps.terminate(saved.microvmId);
    }
    // Cleanup failure must not prevent stopping the primary. Keep the journal
    // on failure so a subsequent stop can reclaim outstanding replacement IDs.
    await api.recoverCleanup(true);
    if (api.deps.removeState) await api.deps.removeState();
    else fs.rmSync(STATE_FILE, { force: true });
  });
  api.log(`terminating ${saved.microvmId} (RAM-only logins are discarded with it)`);
}

async function install(api, opts) {
  const { installLaunchAgent } = await import('./launchd.mjs');
  const { execFileSync } = await import('node:child_process');
  const result = installLaunchAgent({
    scriptPath: fileURLToPath(import.meta.url),
    port: String(opts.port ?? 8787),
    execFileSync,
  });
  api.log(`launchd plist: ${result.dest}${result.loaded ? ' (loaded)' : ' (not loaded; this host is not macOS)'}`);
}

async function uninstall(api) {
  const { uninstallLaunchAgent } = await import('./launchd.mjs');
  const { execFileSync } = await import('node:child_process');
  const dest = uninstallLaunchAgent({ execFileSync });
  api.log(`removed ${dest}`);
}

async function logins(api, opts) {
  let mod;
  try {
    mod = await import('./ext-40-logins.mjs');
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('login injection extension is not installed');
    throw error;
  }
  const kind = opts.kind;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  await mod.importLogin(kind, Buffer.concat(chunks), api.deps.keychain(mod.LOGIN_SERVICE));
  api.log(`stored ${kind} login in the macOS keychain`);
}

const HELP = `usage: t3poc start [--max-duration-sec N] | relay [--port 8787] [--inject-logins] | pair [--port 8787] [--ttl 5m] | status | stop | install | uninstall | logins --kind claude|codex`;

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const deps = productionDeps(opts);
  const api = createRuntime(deps);
  bindShell(deps, api);
  await loadExtensions(api);
  const commands = { start, relay, pair, status, stop, install, uninstall, logins };
  if (!commands[command]) return console.log(HELP);
  await commands[command](api, opts);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invoked) {
  main().catch((error) => {
    console.error(`t3poc: ${error.message}`);
    process.exit(1);
  });
}
