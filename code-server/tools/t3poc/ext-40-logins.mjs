import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loginInvocation } from './login-shell.mjs';
import { LOCAL_PYTHON, STOP_T3 } from './vm-shell.mjs';

export const LOGIN_SERVICE = 't3poc-logins';
export const LOGIN_DIRS = { claude: '/dev/shm/claude', codex: '/dev/shm/codex' };
export const REFRESH_MS = 60_000;
const PY_PATH = fileURLToPath(new URL('./vm_logins.py', import.meta.url));
const PY = fs.readFileSync(PY_PATH, 'utf8');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function injectEnabled(opts = {}, env = process.env) {
  return opts['inject-logins'] === true || env.T3POC_INJECT_LOGINS === '1';
}
function checkKind(kind) {
  if (!Object.hasOwn(LOGIN_DIRS, kind)) throw new Error('kind must be claude or codex');
}
export function injectScript(kind, tarBytes) {
  checkKind(kind);
  return loginInvocation(PY, 'extract', tarBytes, LOGIN_DIRS[kind]);
}
export function captureScript(kind, expected) {
  checkKind(kind);
  return loginInvocation(PY, `${expected ? 'capture' : 'probe'}-${kind}`, expected && Buffer.from(expected));
}
export async function importLogin(kind, bytes, keychain) {
  checkKind(kind);
  const result = spawnSync(LOCAL_PYTHON, [PY_PATH, 'normalize', kind], {
    input: bytes,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('login tar rejected');
  await keychain.set(kind, Buffer.from(result.stdout.toString().trim(), 'base64'));
}

// Call inside the runtime lifecycle lock. Verify Keychain even when the guest hash is unchanged.
export async function captureLogins(runtime) {
  if (!injectEnabled(runtime.deps.opts, runtime.deps.env))
    throw new Error('login carry-over is disabled; use --inject-logins');
  if (runtime.session.vmState !== 'RUNNING') throw new Error('login capture requires a RUNNING VM');
  const keychain = runtime.deps.keychain(LOGIN_SERVICE);
  const results = {};
  for (const kind of Object.keys(LOGIN_DIRS)) {
    try {
      const out = await runtime.deps.shell({ script: captureScript(kind), sensitive: true });
      if (/(?:^|[\r\n])T3POC_LOGIN_EMPTY(?:\r?\n|$)/.test(out)) {
        results[kind] = 'retained';
        continue;
      }
      const digest = out.match(/(?:^|[\r\n])T3POC_LOGIN_HASH ([a-f0-9]{64})(?:\r?\n|$)/)?.[1];
      if (!digest) throw new Error();
      // A relay restart compares with the Keychain bundle before exporting any content.
      let previous;
      try {
        previous = await keychain.get(kind);
      } catch (error) {
        if (error.code !== 'KEYCHAIN_NOT_FOUND') throw error;
      }
      if (!previous || hash(previous) !== digest) {
        const captured = await runtime.deps.shell({ script: captureScript(kind, digest), sensitive: true });
        const b64 = captured.match(/(?:^|[\r\n])T3POC_LOGIN_BUNDLE ([A-Za-z0-9+/=]+)(?:\r?\n|$)/)?.[1];
        if (!b64 || b64.length > 350_000) throw new Error();
        const bytes = Buffer.from(b64, 'base64');
        if (hash(bytes) !== digest) throw new Error();
        await importLogin(kind, bytes, keychain);
        results[kind] = 'captured';
      } else results[kind] = 'unchanged';
    } catch {
      // Shell/Keychain errors are deliberately not forwarded: they may contain secrets.
      throw new Error(`login capture failed for ${kind}; previous Keychain bundle retained`);
    }
  }
  return results;
}

export async function restoreLogins(runtime) {
  if (!injectEnabled(runtime.deps.opts, runtime.deps.env)) return;
  // A relay attaching to the current VM must capture its rotated tokens, never
  // overwrite them with a prior bundle. prepareDisk is true only for a new VM.
  if (!runtime.flags.prepareDisk) return;
  const keychain = runtime.deps.keychain(LOGIN_SERVICE);
  let stopped = false;
  for (const kind of Object.keys(LOGIN_DIRS)) {
    try {
      let blob;
      try {
        blob = await keychain.get(kind);
      } catch (error) {
        if (error.code === 'KEYCHAIN_NOT_FOUND') continue;
        throw error;
      }
      if (!stopped) {
        const result = await runtime.deps.shell({ script: STOP_T3 });
        if (!result.includes('T3POC_T3_STOPPED')) throw new Error();
        runtime.flags.t3Stopped = true;
        stopped = true;
      }
      const out = await runtime.deps.shell({ script: injectScript(kind, blob), sensitive: true });
      if (!out.includes('T3POC_LOGIN_OK')) throw new Error();
      runtime.log(`injected ${kind} login into RAM`);
    } catch {
      throw new Error(`login inject failed for ${kind}`);
    }
  }
}
export function register(api) {
  // A persisted unfinished VM must recover preparation even after relay RAM
  // flags were lost. Preserve the core readiness/backoff/checkpoint behavior.
  const prepareVm = api.prepareVm.bind(api);
  api.prepareVm = async () => {
    if (injectEnabled(api.deps.opts, api.deps.env) && api.session.diskPrepared === false) api.flags.prepareDisk = true;
    return prepareVm();
  };
  api.hooks.prepareDisk.push(restoreLogins);
  const enabled = (runtime) => injectEnabled(runtime.deps.opts, runtime.deps.env);
  const capture = async (runtime) => {
    if (enabled(runtime)) await captureLogins(runtime);
  };
  api.hooks.beforeSwap.push(capture);
  api.hooks.beforeStop.push(capture);
  api.hooks.onTick.push((runtime) =>
    runtime.exclusive(async () => {
      if (
        !enabled(runtime) ||
        runtime.session.vmState !== 'RUNNING' ||
        runtime.now() < (runtime.flags.loginRefreshAt ?? 0)
      )
        return;
      runtime.flags.loginRefreshAt = runtime.now() + REFRESH_MS;
      try {
        await captureLogins(runtime);
      } catch {
        runtime.log('login refresh failed; previous Keychain bundles retained');
      }
    }),
  );
}
