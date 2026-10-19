import fs from 'node:fs';
import { transferBudgetMs, transferScript } from './shell-transfer.mjs';

export const SHELL_DONE = 'T3POC_SHELL_DONE';
export const VM_PYTHON = '/usr/local/bin/python3.14';
export const LOCAL_PYTHON = process.env.T3POC_PYTHON ?? 'python3.14';
const FS_SOURCE = fs.readFileSync(new URL('./vm_fs.py', import.meta.url), 'utf8');
const COMMANDS = new Set(['emit', 'emit-pairing', 'check-tar', 'restore', 'apply-pairing', 'extract']);
const encoded = (bytes) =>
  Buffer.from(bytes)
    .toString('base64')
    .match(/.{1,76}/g)
    ?.join('\n') ?? '';

export const STOP_T3 = `(set -eu
pkill -f '[t]3 serve' || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! pgrep -f '[t]3 serve' >/dev/null; then echo T3POC_T3_STOPPED; exit 0; fi
  sleep 1
done
exit 1
)
echo ${SHELL_DONE}
`;

export const START_T3 = `su -s /bin/sh vscode -c 'umask 077; export T3CODE_HOME=/dev/shm/t3 CLAUDE_CONFIG_DIR=/dev/shm/claude CODEX_HOME=/dev/shm/codex; mkdir -p "$T3CODE_HOME" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"; nohup t3 serve --host 127.0.0.1 --port 3773 --no-browser /home/vscode/workspace >/dev/shm/t3-serve.log 2>&1 &' && echo T3POC_T3_STARTED
echo ${SHELL_DONE}
`;

/** Stage in a fresh private RAM directory, never through a predictable symlink. */
export function pythonInvocation(source, command, payload, dest) {
  if (!COMMANDS.has(command)) throw new Error('rejected history command');
  if (command === 'extract' && !['/dev/shm/claude', '/dev/shm/codex'].includes(dest)) {
    throw new Error('rejected login destination');
  }
  const lines = [
    '(set -eu',
    'umask 077',
    'stty -echo >/dev/null 2>&1 || true',
    'task=$(mktemp -d /dev/shm/t3poc.XXXXXXXX)',
    'trap \'rm -rf "$task"\' EXIT',
    'base64 -d > "$task/run.py" << \'B64\'',
    encoded(source),
    'B64',
    'base64 -d > "$task/vm_fs.py" << \'FS\'',
    encoded(FS_SOURCE),
    'FS',
  ];
  if (payload) lines.push('base64 -d > "$task/payload" << \'PAYLOAD\'', encoded(payload), 'PAYLOAD');
  const args = `"$task/run.py" ${command}${dest ? ` ${dest}` : ''}${payload ? ' "$task/payload"' : ''}`;
  // SQLite sidecars must also belong to vscode, not the remote shell user.
  lines.push('chown -R vscode:vscode "$task"');
  lines.push('if [ "$(id -un)" = vscode ]; then', `${VM_PYTHON} ${args}`, 'else');
  lines.push(`su -s /bin/sh vscode -c "${VM_PYTHON} ${args.replaceAll('"', '\\"')}"`);
  lines.push('fi');
  lines.push(')', `echo ${SHELL_DONE}`);
  return lines.join('\n');
}

export async function shellExec({ endpoint, token, script, stdin, WebSocket, timeoutMs = 90_000 }) {
  if (!endpoint || !token) throw new Error('shell requires an endpoint and token');
  const large = Buffer.byteLength(script) > 16 * 1024;
  const transferBudget = large ? transferBudgetMs(script, stdin) : 0;
  const ws = new WebSocket(`wss://${endpoint}/shell`, [
    `lambda-microvms.authentication.${token}`,
    'lambda-microvms',
    'lambda-microvms.port.8022',
  ]);
  let out = '';
  let failure = null;
  let inputTimer;
  ws.on('message', (data) => {
    out += data.toString();
  });
  ws.on('close', () => {
    failure = new Error('MicroVM shell closed before completion');
  });
  ws.on('error', () => {
    failure = new Error('MicroVM shell transport failed');
  });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
      new Promise((_, reject) => {
        inputTimer = setTimeout(() => reject(new Error('MicroVM shell open timed out')), timeoutMs);
      }),
    ]);
    clearTimeout(inputTimer);
    const deadline = Date.now() + timeoutMs + transferBudget;
    if (large) {
      const waitFor = async (pattern, prefix) => {
        while (!pattern.test(out)) {
          if (out.includes(`${prefix}ABORT`)) throw new Error('MicroVM script receipt rejected');
          if (failure) throw failure;
          if (Date.now() >= deadline) throw new Error('MicroVM script transfer timed out');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      const send = (value) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('MicroVM shell send timed out')),
            Math.max(1, deadline - Date.now()),
          );
          ws.send(value, (error) => {
            clearTimeout(timer);
            if (error) reject(new Error('MicroVM shell send failed'));
            else resolve();
          });
        });
      await transferScript({ script, stdin, python: VM_PYTHON, waitFor, send });
    } else {
      ws.send(`stty -echo >/dev/null 2>&1 || true\n${script}\n`);
      if (stdin) inputTimer = setTimeout(() => ws.send(`${stdin}\n`), 400);
    }
    while (!new RegExp(`(?:^|[\\r\\n])${SHELL_DONE}(?:\\r?\\n|$)`).test(out) && Date.now() < deadline) {
      if (failure) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!new RegExp(`(?:^|[\\r\\n])${SHELL_DONE}(?:\\r?\\n|$)`).test(out)) throw new Error('MicroVM shell timed out');
    return out;
  } finally {
    clearTimeout(inputTimer);
    ws.close();
  }
}
