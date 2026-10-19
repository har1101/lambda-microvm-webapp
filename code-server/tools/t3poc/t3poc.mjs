#!/usr/bin/env node
// t3poc — run on your Mac. No credentials are written to disk by this tool:
// AWS credentials come from your SSO profile (aws sso login), MicroVM tokens
// live only in this process's memory. ~/.t3poc/state.json holds only the
// MicroVM id and endpoint.
//
//   t3poc start  [--max-duration-sec 28800]   RunMicrovm (HTTP_INGRESS + SHELL_INGRESS + INTERNET_EGRESS)
//   t3poc relay  [--port 8787]                loopback relay -> MicroVM :8080 (adds X-aws-proxy-auth, refreshes it)
//   t3poc pair   [--port 8787]                one-time T3 pairing link with --base-url http://127.0.0.1:<port>
//   t3poc status | stop
//
// Env: AWS_PROFILE (default fukuchi), T3POC_REGION (default ap-northeast-1).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export const REGION = process.env.T3POC_REGION ?? 'ap-northeast-1';
process.env.AWS_PROFILE ??= 'fukuchi';
const STATE_DIR = path.join(os.homedir(), '.t3poc');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const APP_PORT = 8080;
const TOKEN_MINUTES = 60;
const REFRESH_BEFORE_MS = 15 * 60_000;
const connector = (name) => `arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:${name}`;

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error(`unexpected argument: ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[i + 1];
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
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function requireState() {
  const s = readState();
  if (!s?.microvmId) throw new Error('no MicroVM recorded; run `t3poc start` first');
  return s;
}

const mvm = () => new LambdaMicrovmsClient({ region: REGION });

async function start(opts) {
  const existing = readState();
  if (existing?.microvmId) {
    const cur = await mvm()
      .send(new GetMicrovmCommand({ microvmIdentifier: existing.microvmId }))
      .catch(() => null);
    if (cur && !['TERMINATED', 'TERMINATING', 'FAILED'].includes(cur.state)) {
      throw new Error(`MicroVM ${existing.microvmId} is still ${cur.state}; run \`t3poc stop\` first`);
    }
  }
  const { Account } = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
  const maxDuration = Number(opts['max-duration-sec'] ?? 28800);
  if (!Number.isInteger(maxDuration) || maxDuration < 900 || maxDuration > 28800) {
    throw new Error('--max-duration-sec must be 900..28800');
  }
  const sessionId = randomUUID();
  const expiresAt = Date.now() + maxDuration * 1000;
  const run = await mvm().send(
    new RunMicrovmCommand({
      imageIdentifier: `arn:aws:lambda:${REGION}:${Account}:microvm-image:t3poc-task`,
      // Guest role: logs only, no S3/KMS. Logins stay in RAM (/dev/shm) in the VM.
      executionRoleArn: `arn:aws:iam::${Account}:role/t3poc-microvm-guest`,
      ingressNetworkConnectors: [connector('HTTP_INGRESS'), connector('SHELL_INGRESS')],
      egressNetworkConnectors: [connector('INTERNET_EGRESS')],
      idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: 28800, suspendedDurationSeconds: 28800 },
      maximumDurationInSeconds: maxDuration,
      runHookPayload: JSON.stringify({ sessionId, expiresAt, authState: false }),
    }),
  );
  writeState({ microvmId: run.microvmId, endpoint: run.endpoint, region: REGION, expiresAt });
  process.stdout.write(`started ${run.microvmId} (${run.state}); waiting for RUNNING`);
  for (let i = 0; i < 90; i++) {
    const cur = await mvm().send(new GetMicrovmCommand({ microvmIdentifier: run.microvmId }));
    if (cur.state === 'RUNNING') break;
    if (['FAILED', 'TERMINATED'].includes(cur.state))
      throw new Error(`MicroVM ${cur.state}: ${cur.terminationMessage ?? ''}`);
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`\nendpoint: ${run.endpoint}\nends at:  ${new Date(expiresAt).toLocaleString()}`);
  console.log('next: `t3poc relay` (keep it running), then `t3poc pair` in another terminal');
}

async function proxyToken(microvmId) {
  const res = await mvm().send(
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

/**
 * Headers forwarded to the MicroVM. AWS routes on Host=<endpoint>; the in-VM
 * shim restores the client-facing address from X-T3poc-Host so T3's DPoP `htu`
 * and Origin checks see http://127.0.0.1:<port>, exactly what the client used.
 */
export function upstreamHeaders(incoming, endpoint, token, clientHost) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (['host', 'x-aws-proxy-auth', 'x-t3poc-host', 'x-forwarded-proto', 'x-forwarded-host'].includes(key)) continue;
    out[key] = v;
  }
  out.host = endpoint;
  out['x-t3poc-host'] = clientHost;
  out['x-aws-proxy-auth'] = token;
  return out;
}

import { forwardWebResponse, serveWebStyle, webRequestHeaders } from './webui.mjs';

export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function createRelay({
  endpoint: initialEndpoint,
  getEndpoint = async () => initialEndpoint,
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
    if (serveWebStyle(req, res)) return;
    let counted = false;
    let finished = false;
    let upReq;
    let upRes;
    let retryTimer;
    let retries = 0;
    const finish = () => {
      finished = true;
      clearTimeout(retryTimer);
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
    const send = () => {
      upReq = request(
        {
          host: endpoint,
          port: upstreamPort,
          servername: endpoint,
          method: req.method,
          path: req.url,
          headers: webRequestHeaders(req, upstreamHeaders(req.headers, endpoint, token, clientHost)),
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
          // A cold module graph can briefly exhaust ingress capacity. Only
          // replay bodyless reads after a 429; writes and upgrades are untouched.
          const retryAfter = upRes.headers['retry-after'];
          const delay =
            retryAfter == null
              ? 500 * 2 ** retries
              : /^\d+(?:\.\d+)?$/.test(String(retryAfter))
                ? Number(retryAfter) * 1000
                : Date.parse(String(retryAfter)) - Date.now();
          if (
            req.method === 'GET' &&
            !req.headers['content-length'] &&
            !req.headers['transfer-encoding'] &&
            upRes.statusCode === 429 &&
            retries < 4 &&
            Number.isFinite(delay) &&
            delay <= 5000
          ) {
            retries++;
            upRes.resume();
            retryTimer = setTimeout(
              () => {
                if (!finished && !res.destroyed) send().end();
              },
              Math.max(100, delay),
            );
            return;
          }
          upRes.on('data', activity);
          forwardWebResponse(req, res, upRes);
        },
      );
      upReq.on('error', (error) => {
        if (finished || res.destroyed) return;
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`t3poc: upstream error ${error.code ?? error.name}\n`);
      });
      return upReq;
    };
    send();
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

async function relay(opts) {
  const { microvmId, endpoint } = requireState();
  const port = Number(opts.port ?? 8787);
  let current = await proxyToken(microvmId);
  const getToken = async () => {
    if (Date.now() >= current.refreshAt) current = await proxyToken(microvmId);
    return current.value;
  };
  const server = createRelay({ endpoint, getToken, clientHost: `127.0.0.1:${port}` });
  server.listen(port, '127.0.0.1', () => {
    console.log(`relay: http://127.0.0.1:${port} -> https://${endpoint} (:${APP_PORT}); Ctrl+C to stop`);
  });
}

/** Extract the pairing link printed by `t3 auth pairing create --json`. */
export function findPairingUrl(text) {
  const m = text.match(/https?:\/\/127\.0\.0\.1:\d+\/pair#token=[A-Za-z0-9._~%+-]+/);
  return m ? m[0] : null;
}

async function pair(opts) {
  const { WebSocket } = await import('ws');
  const { microvmId, endpoint } = requireState();
  const port = Number(opts.port ?? 8787);
  const label = opts.label ?? `t3poc-${os.hostname()}`;
  const ttl = opts.ttl ?? '5m';
  const cmd = `t3 auth pairing create --base-dir /dev/shm/t3 --base-url http://127.0.0.1:${port} --label '${label.replace(/[^\w.-]/g, '')}' --ttl ${ttl.replace(/[^\w ]/g, '')} --json`;
  const res = await mvm().send(
    new CreateMicrovmShellAuthTokenCommand({ microvmIdentifier: microvmId, expirationInMinutes: 5 }),
  );
  const token = res.authToken['X-aws-proxy-auth'];
  const ws = new WebSocket(`wss://${endpoint}/shell`, [
    `lambda-microvms.authentication.${token}`,
    'lambda-microvms',
    'lambda-microvms.port.8022',
  ]);
  let out = '';
  const done = (url) => {
    ws.close();
    if (url) {
      console.log(`pairing link (one-time, ${ttl}; treat as a password):\n${url}`);
      console.log('T3 Desktop: Settings → Connections → Add environment → paste the link (relay must be running).');
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
    // The shell may land as root or in the host namespace; run as the app user.
    ws.send(`su -s /bin/sh vscode -c "${cmd}" 2>&1 || ${cmd} 2>&1\n`);
  });
  ws.on('message', (data) => {
    out += data.toString();
    const url = findPairingUrl(out);
    if (url) {
      clearTimeout(timer);
      done(url);
    }
  });
  ws.on('error', (e) => {
    clearTimeout(timer);
    out += `\n[ws error] ${e.message}`;
    done(null);
  });
}

async function status() {
  const s = requireState();
  const cur = await mvm().send(new GetMicrovmCommand({ microvmIdentifier: s.microvmId }));
  console.log(`${s.microvmId} ${cur.state} endpoint=${s.endpoint} ends=${new Date(s.expiresAt).toLocaleString()}`);
}

async function stop() {
  const s = requireState();
  await mvm().send(new TerminateMicrovmCommand({ microvmIdentifier: s.microvmId }));
  fs.rmSync(STATE_FILE, { force: true });
  console.log(`terminating ${s.microvmId} (RAM-only logins are discarded with it)`);
}

const HELP = `usage: t3poc start [--max-duration-sec N] | relay [--port 8787] | pair [--port 8787] [--ttl 5m] | status | stop`;

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const commands = { start, relay, pair, status, stop };
  if (!commands[command]) return console.log(HELP);
  await commands[command](opts);
}

if (import.meta.url === `file://${fs.realpathSync(process.argv[1] ?? '')}`) {
  main().catch((e) => {
    console.error(`t3poc: ${e.message}`);
    process.exit(1);
  });
}
