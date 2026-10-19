import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOGIN_SERVICE = 't3poc-logins';
export const LOGIN_DIRS = { claude: '/dev/shm/claude', codex: '/dev/shm/codex' };
const PY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vm_logins.py');
const PY = fs.readFileSync(PY_PATH, 'utf8');

export function injectEnabled(opts = {}, env = process.env) {
  return opts['inject-logins'] === true || env.T3POC_INJECT_LOGINS === '1';
}

export function injectScript(kind, tarBytes) {
  const dest = LOGIN_DIRS[kind];
  if (!dest) throw new Error('kind must be claude or codex');
  const scriptB64 = Buffer.from(PY).toString('base64');
  const tarB64 = Buffer.from(tarBytes).toString('base64');
  return [
    'umask 077',
    'stty -echo >/dev/null 2>&1 || true',
    "base64 -d > /dev/shm/t3poc-login.py << 'B64'",
    scriptB64,
    'B64',
    "base64 -d > /dev/shm/t3poc-login.tar << 'PAYLOAD'",
    tarB64,
    'PAYLOAD',
    `python3 /dev/shm/t3poc-login.py extract ${dest} /dev/shm/t3poc-login.tar`,
    'rm -f /dev/shm/t3poc-login.py /dev/shm/t3poc-login.tar',
    'echo T3POC_SHELL_DONE',
  ].join('\n');
}

export async function importLogin(kind, bytes, keychain) {
  if (!LOGIN_DIRS[kind]) throw new Error('kind must be claude or codex');
  const result = spawnSync('python3', [PY_PATH, 'validate'], { input: bytes });
  if (result.status !== 0) throw new Error('login tar rejected');
  await keychain.set(kind, bytes);
}

export function register(api) {
  api.hooks.onVmReady.push(async (runtime) => {
    if (!injectEnabled(runtime.deps.opts, runtime.deps.env)) return;
    const keychain = runtime.deps.keychain(LOGIN_SERVICE);
    for (const kind of Object.keys(LOGIN_DIRS)) {
      let blob;
      try {
        blob = await keychain.get(kind);
      } catch {
        continue;
      }
      const out = await runtime.deps.shell({ script: injectScript(kind, blob) });
      if (!out.includes('T3POC_LOGIN_OK')) {
        runtime.log(`login inject failed for ${kind}`);
        continue;
      }
      runtime.log(`injected ${kind} login into ${LOGIN_DIRS[kind]}`);
    }
  });
}
