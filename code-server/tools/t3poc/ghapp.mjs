// t3poc GitHub App: short-lived (1h) installation tokens scoped to ai-native-factory/t3poc-sandbox only.
// Usage: AWS_PROFILE=fukuchi node ghapp.mjs setup|push|refresh|status
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
const HOST = 'ai-native-factory-ltd.ghe.com', API = `https://api.${HOST}`, ORG = 'ai-native-factory', REPO = 't3poc-sandbox';
const SVC = 't3poc-ghapp', PORT = 47831;
const kcSet = (acct, val) => { // via `security -i` stdin so the secret never appears in argv / on disk
  const b64 = Buffer.from(val).toString('base64');
  const r = spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${SVC} -a ${acct} -w ${b64}\n` });
  if (r.status !== 0) throw new Error('keychain write failed: ' + r.stderr);
};
const kcGet = (acct) => Buffer.from(execFileSync('security', ['find-generic-password', '-s', SVC, '-a', acct, '-w']).toString().trim(), 'base64').toString();
const gh = async (method, path, token, body, scheme = 'Bearer') => {
  const r = await fetch(API + path, { method, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 't3poc', ...(token ? { Authorization: `${scheme} ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${j.message || ''}`); return j;
};
const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const jwt = () => { const id = kcGet('app-id'), pem = kcGet('pem'), now = Math.floor(Date.now() / 1000);
  const data = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iat: now - 60, exp: now + 540, iss: id })}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), pem).toString('base64url')}`; };

async function setup() {
  const state = crypto.randomBytes(16).toString('hex');
  const manifest = { name: `t3poc-sandbox-${crypto.randomBytes(2).toString('hex')}`, url: `https://${HOST}/${ORG}/${REPO}`,
    hook_attributes: { url: `https://${HOST}/${ORG}/${REPO}`, active: false }, redirect_url: `http://127.0.0.1:${PORT}/callback`,
    public: false, default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }, default_events: [] };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  await new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<form id=f method=post action="https://${HOST}/organizations/${ORG}/settings/apps/new?state=${state}"><input type=hidden name=manifest value="${esc(JSON.stringify(manifest))}"></form><script>f.submit()</script>`); }
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      try {
        if (u.searchParams.get('state') !== state) throw new Error('state mismatch');
        const app = await gh('POST', `/app-manifests/${encodeURIComponent(u.searchParams.get('code'))}/conversions`);
        kcSet('pem', app.pem); kcSet('app-id', String(app.id)); kcSet('slug', app.slug);
        const inst = `https://${HOST}/apps/${app.slug}/installations/new`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`App 作成完了 (id ${app.id})。秘密鍵はキーチェーンに保存しました。このタブは閉じてOK。`);
        console.log(`App 作成: ${app.slug} (id ${app.id})。秘密鍵は Keychain(${SVC}) のみに保存。\nインストール画面: ${inst}`);
        execFileSync('open', [inst]); srv.close(); resolve();
      } catch (e) { res.writeHead(500); res.end(String(e.message)); srv.close(); reject(e); }
    }).listen(PORT, '127.0.0.1', () => { console.log('ブラウザで App 作成画面を開きます…'); execFileSync('open', [`http://127.0.0.1:${PORT}/`]); });
  });
}

async function mint() {
  const inst = await gh('GET', `/repos/${ORG}/${REPO}/installation`, jwt());
  return gh('POST', `/app/installations/${inst.id}/access_tokens`, jwt(), { repositories: [REPO], permissions: { contents: 'write', pull_requests: 'write' } });
}

async function push() {
  const M = await import('@aws-sdk/client-lambda-microvms'); const { WebSocket } = await import('ws');
  const t = await mint(); if (!/^[A-Za-z0-9_.-]{20,}$/.test(t.token)) throw new Error('unexpected token format');
  const st = JSON.parse(fs.readFileSync(os.homedir() + '/.t3poc/state.json', 'utf8'));
  const c = new M.LambdaMicrovmsClient({ region: 'ap-northeast-1' });
  const r = await c.send(new M.CreateMicrovmShellAuthTokenCommand({ microvmIdentifier: st.microvmId, expirationInMinutes: 5 }));
  const ws = new WebSocket(`wss://${st.endpoint}/shell`, [`lambda-microvms.authentication.${r.authToken['X-aws-proxy-auth']}`, 'lambda-microvms', 'lambda-microvms.port.8022']);
  let out = ''; ws.on('message', (d) => { out += d.toString(); });
  const b64 = Buffer.from(t.token).toString('base64');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  // stty -echo + leading space: token is read from stdin (base64), never in argv/history/echo
  ws.send(` stty -echo; read -r T; su - vscode -c 'umask 077; base64 -d > /dev/shm/gh-token.tmp && mv /dev/shm/gh-token.tmp /dev/shm/gh-token; GH_HOST=${HOST} GH_TOKEN=$(cat /dev/shm/gh-token) gh api /repos/${ORG}/${REPO} -q .full_name | sed s/^/T3R""ES:/' <<< "$T"; unset T; stty echo; history -c; echo T3D""ONE\n`);
  setTimeout(() => ws.send(b64 + '\n'), 500);
  const deadline = Date.now() + 20000; while (!/T3DONE\r?\n/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  ws.close(); if (process.env.T3DEBUG) console.log(out.split(b64).join("<redacted>").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,""));
  const ok = out.includes(`T3RES:${ORG}/${REPO}`);
  console.log(ok ? `OK: VM /dev/shm/gh-token を更新 (有効期限 ${new Date(t.expires_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST, ${REPO} のみ)` : 'NG: 書き込み/確認に失敗');
  if (!ok) process.exitCode = 1; return ok;
}

const cmd = process.argv[2];
if (cmd === 'setup') await setup();
else if (cmd === 'push') await push();
else if (cmd === 'refresh') { for (;;) { try { await push(); } catch (e) { console.error(new Date().toISOString(), e.message); } await new Promise((r) => setTimeout(r, 50 * 60 * 1000)); } }
else if (cmd === 'status') { const t = await mint(); console.log('mint OK, expires', t.expires_at, Object.keys(t.permissions)); /* token discarded */ }
else { console.log('usage: AWS_PROFILE=fukuchi node ghapp.mjs setup|push|refresh|status'); process.exitCode = 1; }
