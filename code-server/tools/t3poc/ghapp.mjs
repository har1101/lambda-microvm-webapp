// t3poc GitHub App: 1-hour installation tokens for one repo.
// The private key stays in the macOS keychain (service t3poc-ghapp).
// Usage: AWS_PROFILE=fukuchi node ghapp.mjs setup|push|refresh|status

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { macKeychain } from './keychain.mjs';

export const GH_HOST = 'ai-native-factory-ltd.ghe.com';
export const ORG = 'ai-native-factory';
export const REPO = 't3poc-sandbox';
export const KEYCHAIN_SERVICE = 't3poc-ghapp';
export const REFRESH_EVERY_MS = 50 * 60 * 1000;
const API = `https://api.${GH_HOST}`;
const PORT = 47831;

const b64u = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

async function gh(method, apiPath, token, body, scheme = 'Bearer', fetchImpl = fetch) {
  const response = await fetchImpl(`${API}${apiPath}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 't3poc',
      ...(token ? { Authorization: `${scheme} ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${apiPath} -> ${response.status} ${payload.message || ''}`);
  return payload;
}

async function appJwt(keychain) {
  const id = Buffer.from(await keychain.get('app-id')).toString('utf8');
  const pem = Buffer.from(await keychain.get('pem')).toString('utf8');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iat: now - 60, exp: now + 540, iss: id })}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), pem).toString('base64url')}`;
}

export async function mintInstallationToken(deps = {}) {
  const keychain = deps.keychain ?? macKeychain(KEYCHAIN_SERVICE);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await appJwt(keychain);
  const installation = await gh('GET', `/repos/${ORG}/${REPO}/installation`, token, undefined, 'Bearer', fetchImpl);
  return gh(
    'POST',
    `/app/installations/${installation.id}/access_tokens`,
    token,
    { repositories: [REPO], permissions: { contents: 'write', pull_requests: 'write' } },
    'Bearer',
    fetchImpl,
  );
}

/** Shell script that reads a base64 token from stdin. The token is not in this string. */
export function pushScript() {
  return ` stty -echo; read -r T; su - vscode -c 'umask 077; base64 -d > /dev/shm/gh-token.tmp && mv /dev/shm/gh-token.tmp /dev/shm/gh-token; GH_HOST=${GH_HOST} GH_TOKEN=$(cat /dev/shm/gh-token) gh api /repos/${ORG}/${REPO} -q .full_name | sed s/^/T3RES:/' <<< "$T"; unset T; stty echo; echo T3POC_SHELL_DONE`;
}

export async function pushToVm({ shell, mint, log = () => {} }) {
  const minted = await mint();
  if (!/^[A-Za-z0-9_.-]{20,}$/.test(minted.token)) throw new Error('unexpected token format');
  const script = pushScript();
  if (script.includes(minted.token)) throw new Error('token leaked into the shell script');
  const out = await shell({ script, stdin: Buffer.from(minted.token).toString('base64') });
  const ok = out.includes(`T3RES:${ORG}/${REPO}`);
  log(ok ? `gh token updated (expires ${minted.expires_at}, repo ${REPO} only)` : 'gh token push failed');
  if (!ok) throw new Error('gh token push failed');
  return { expiresAt: minted.expires_at };
}

async function setup() {
  const keychain = macKeychain(KEYCHAIN_SERVICE);
  const state = crypto.randomBytes(16).toString('hex');
  const manifest = {
    name: `t3poc-sandbox-${crypto.randomBytes(2).toString('hex')}`,
    url: `https://${GH_HOST}/${ORG}/${REPO}`,
    hook_attributes: { url: `https://${GH_HOST}/${ORG}/${REPO}`, active: false },
    redirect_url: `http://127.0.0.1:${PORT}/callback`,
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: [],
  };
  const esc = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  await new Promise((resolve, reject) => {
    const server = http
      .createServer(async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<form id=f method=post action="https://${GH_HOST}/organizations/${ORG}/settings/apps/new?state=${state}"><input type=hidden name=manifest value="${esc(JSON.stringify(manifest))}"></form><script>f.submit()</script>`,
          );
          return;
        }
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        try {
          if (url.searchParams.get('state') !== state) throw new Error('state mismatch');
          const app = await gh(
            'POST',
            `/app-manifests/${encodeURIComponent(url.searchParams.get('code'))}/conversions`,
          );
          keychain.set('pem', app.pem);
          keychain.set('app-id', String(app.id));
          keychain.set('slug', app.slug);
          const install = `https://${GH_HOST}/apps/${app.slug}/installations/new`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`App 作成完了 (id ${app.id})。秘密鍵はキーチェーンに保存しました。このタブは閉じてOK。`);
          console.log(`App 作成: ${app.slug} (id ${app.id})。秘密鍵は Keychain(${KEYCHAIN_SERVICE}) のみに保存。`);
          console.log(`インストール画面: ${install}`);
          execFileSync('open', [install]);
          server.close();
          resolve();
        } catch (error) {
          res.writeHead(500);
          res.end(String(error.message));
          server.close();
          reject(error);
        }
      })
      .listen(PORT, '127.0.0.1', () => {
        console.log('ブラウザで App 作成画面を開きます…');
        execFileSync('open', [`http://127.0.0.1:${PORT}/`]);
      });
  });
}

async function push() {
  const { shellExec } = await import('./vm-shell.mjs');
  const { WebSocket } = await import('ws');
  const state = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.t3poc', 'state.json'), 'utf8'));
  const { CreateMicrovmShellAuthTokenCommand, LambdaMicrovmsClient } = await import('@aws-sdk/client-lambda-microvms');
  const client = new LambdaMicrovmsClient({ region: 'ap-northeast-1' });
  const minted = await client.send(
    new CreateMicrovmShellAuthTokenCommand({ microvmIdentifier: state.microvmId, expirationInMinutes: 5 }),
  );
  await pushToVm({
    mint: () => mintInstallationToken(),
    shell: (input) =>
      shellExec({
        endpoint: state.endpoint,
        token: minted.authToken['X-aws-proxy-auth'],
        WebSocket,
        ...input,
      }),
  });
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'setup') await setup();
  else if (cmd === 'push') await push();
  else if (cmd === 'refresh') {
    for (;;) {
      try {
        await push();
      } catch (error) {
        console.error(new Date().toISOString(), error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, REFRESH_EVERY_MS));
    }
  } else if (cmd === 'status') {
    const minted = await mintInstallationToken();
    console.log('mint OK, expires', minted.expires_at, Object.keys(minted.permissions));
  } else {
    console.log('usage: AWS_PROFILE=fukuchi node ghapp.mjs setup|push|refresh|status');
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invoked) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
