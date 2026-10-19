export const SHELL_DONE = 'T3POC_SHELL_DONE';
const COMMANDS = new Set(['emit', 'emit-pairing', 'check-tar', 'restore', 'apply-pairing']);

export const STOP_T3 = `if command -v pkill >/dev/null 2>&1; then pkill -f 't3 serve' || true; fi
sleep 0.5
echo T3POC_T3_STOPPED
echo ${SHELL_DONE}
`;

export const START_T3 = `su -s /bin/sh vscode -c 'umask 077; export T3CODE_HOME=/dev/shm/t3 CLAUDE_CONFIG_DIR=/dev/shm/claude CODEX_HOME=/dev/shm/codex; mkdir -p "$T3CODE_HOME" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"; nohup t3 serve --host 127.0.0.1 --port 3773 --no-browser /home/vscode/workspace >/dev/shm/t3-serve.log 2>&1 &' || true
sleep 0.5
echo T3POC_T3_STARTED
echo ${SHELL_DONE}
`;

/** Shell text that runs vm_history.py inside the VM. Payload bytes stay in /dev/shm. */
export function pythonInvocation(source, command, payload) {
  if (!COMMANDS.has(command)) throw new Error('rejected history command');
  const lines = [
    'umask 077',
    'stty -echo >/dev/null 2>&1 || true',
    "base64 -d > /dev/shm/t3poc-run.py << 'B64'",
    Buffer.from(source).toString('base64'),
    'B64',
  ];
  if (payload) {
    lines.push("base64 -d > /dev/shm/t3poc-payload << 'PAYLOAD'");
    lines.push(Buffer.from(payload).toString('base64'));
    lines.push('PAYLOAD');
    lines.push(`python3 /dev/shm/t3poc-run.py ${command} /dev/shm/t3poc-payload`);
  } else {
    lines.push(`python3 /dev/shm/t3poc-run.py ${command}`);
  }
  lines.push('rm -f /dev/shm/t3poc-run.py /dev/shm/t3poc-payload', `echo ${SHELL_DONE}`);
  return lines.join('\n');
}

export async function shellExec({ endpoint, token, script, stdin, WebSocket, timeoutMs = 90_000 }) {
  if (!endpoint || !token) throw new Error('shell requires an endpoint and token');
  const ws = new WebSocket(`wss://${endpoint}/shell`, [
    `lambda-microvms.authentication.${token}`,
    'lambda-microvms',
    'lambda-microvms.port.8022',
  ]);
  let out = '';
  ws.on('message', (data) => {
    out += data.toString();
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(`stty -echo >/dev/null 2>&1 || true\n${script}\n`);
  if (stdin) setTimeout(() => ws.send(`${stdin}\n`), 400);
  const deadline = Date.now() + timeoutMs;
  while (!out.includes(SHELL_DONE) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  ws.close();
  if (!out.includes(SHELL_DONE)) throw new Error('MicroVM shell timed out');
  return out;
}
