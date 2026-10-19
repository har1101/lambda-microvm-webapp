import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { transferBudgetMs } from './shell-transfer.mjs';
import { shellExec, VM_PYTHON } from './vm-shell.mjs';

const BRIDGE = `import os,pty,select,sys
pid,fd=pty.fork()
if pid==0:os.execv('/bin/bash',['bash','--noprofile','--norc'])
try:
 while True:
  for source in select.select([0,fd],[],[])[0]:
   data=os.read(source,65536)
   if not data:sys.exit(0)
   if source==0:
    while data:
     n=os.write(fd,data);data=data[n:]
   else:os.write(1,data)
finally:os.close(fd)
`;
function socketClass(root, { corrupt = false, closeEarly = false, latencyMs = 0 } = {}) {
  return class Socket extends EventEmitter {
    constructor() {
      super();
      this.first = true;
      this.frames = [];
      this.child = spawn('python3.14', ['-u', '-c', BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child.stdout.on('data', (b) => setTimeout(() => this.emit('message', b), latencyMs));
      this.child.on('exit', () => this.emit('close'));
      queueMicrotask(() => this.emit('open'));
    }
    send(value, callback) {
      this.frames.push(Buffer.byteLength(value));
      if (value.includes(' -c ')) {
        assert.ok(Buffer.byteLength(value) < 1024);
        value = value.replace(VM_PYTHON, 'python3.14');
      } else if (
        /^[A-Za-z0-9+/=]+\n$/.test(value) &&
        Buffer.from(value.trim(), 'base64').toString().startsWith('import sys,os')
      ) {
        value = `${Buffer.from(
          Buffer.from(value.trim(), 'base64')
            .toString()
            .replace('dir="/dev/shm"', `dir=${JSON.stringify(root)}`),
        ).toString('base64')}\n`;
      } else if (value.startsWith('{"size":')) {
        this.payload = true;
      } else if (this.payload && value.length > 500) {
        if (corrupt) {
          value = (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
          corrupt = false;
        }
        if (closeEarly) {
          this.child.kill();
          callback?.();
          return;
        }
      }
      assert.ok(Buffer.byteLength(value) < 20 * 1024, 'frames stay bounded');
      setTimeout(() => this.child.stdin.write(value, callback), latencyMs);
    }
    close() {
      this.child.kill();
    }
  };
}
test('real PTY receives and executes a 5 MiB script only after verified receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-transfer-test-'));
  try {
    const script = `cat >/dev/null <<'SYNTHETIC'\n${'x'.repeat(5 * 1024 * 1024)}\nSYNTHETIC\nprintf '\\nLARGE_EXECUTED\\nT3POC_SHELL_DONE\\n'`;
    const result = await shellExec({
      endpoint: 'mock',
      token: 'synthetic',
      script,
      WebSocket: socketClass(root),
      timeoutMs: 30000,
    });
    assert.match(result, /LARGE_EXECUTED/);
    assert.match(result, /VERIFIED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('corrupt transfer is rejected before the script executes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-transfer-test-'));
  const marker = path.join(root, 'must-not-exist');
  try {
    await assert.rejects(
      shellExec({
        endpoint: 'mock',
        token: 'synthetic',
        script: `#${'x'.repeat(20000)}\ntouch '${marker}'\necho T3POC_SHELL_DONE`,
        WebSocket: socketClass(root, { corrupt: true }),
        timeoutMs: 30000,
      }),
      /receipt rejected/,
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('closed transfer fails without waiting for the full timeout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-transfer-test-'));
  try {
    await assert.rejects(
      shellExec({
        endpoint: 'mock',
        token: 'synthetic',
        script: `#${'x'.repeat(20000)}`,
        WebSocket: socketClass(root, { closeEarly: true }),
        timeoutMs: 30000,
      }),
      /closed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('chunk budget permits a delayed transfer beyond the execution budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-transfer-test-'));
  try {
    const script = `#${'x'.repeat(128 * 1024)}\necho T3POC_SHELL_DONE`;
    assert.ok(transferBudgetMs(script) >= 11000);
    const result = await shellExec({
      endpoint: 'mock',
      token: 'synthetic',
      script,
      WebSocket: socketClass(root, { latencyMs: 120 }),
      timeoutMs: 1000,
    });
    assert.match(result, /VERIFIED/);
    assert.throws(() => transferBudgetMs('x'.repeat(64 * 1024 * 1024)), /limit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
