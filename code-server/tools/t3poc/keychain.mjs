// Values travel through stdin in short lines, never argv or files.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PREFIX = 'T3POC_CHUNKED_V1:';
const CHUNK_BYTES = 512;
const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value) => createHash('sha256').update(value).digest('hex');
function assertAccount(account) {
  if (!ACCOUNT_RE.test(account)) throw new Error('rejected keychain account');
}
function manifest(value) {
  const text = value.toString('utf8');
  if (!text.startsWith(PREFIX)) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(PREFIX.length));
  } catch {
    throw new Error('invalid keychain manifest');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !/^[a-f0-9]{16}$/.test(parsed.id) ||
    !Number.isInteger(parsed.count) ||
    parsed.count < 0 ||
    parsed.count > Math.ceil(MAX_BYTES / CHUNK_BYTES) ||
    !/^[a-f0-9]{64}$/.test(parsed.sha256)
  )
    throw new Error('invalid keychain manifest');
  return parsed;
}
const chunkAccount = (account, item, index) => `t3pc-${digest(account).slice(0, 16)}-${item.id}-${index}`;

export function memoryKeychain() {
  const values = new Map();
  return {
    async set(account, value) {
      assertAccount(account);
      values.set(account, Buffer.from(value));
    },
    async get(account) {
      assertAccount(account);
      if (!values.has(account)) {
        const error = new Error('keychain item not found');
        error.code = 'KEYCHAIN_NOT_FOUND';
        throw error;
      }
      return Buffer.from(values.get(account));
    },
    has(account) {
      return values.has(account);
    },
  };
}

export function rawMacKeychain(service, io = { execFileSync, spawnSync }) {
  if (!ACCOUNT_RE.test(service)) throw new Error('rejected keychain service');
  const read = (account) => {
    try {
      const out = io.execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return Buffer.from(String(out).trim(), 'base64');
    } catch (cause) {
      const error = new Error(`keychain read failed (${service})`);
      if (cause.status === 44) error.code = 'KEYCHAIN_NOT_FOUND';
      throw error;
    }
  };
  const write = (account, value) => {
    const result = io.spawnSync('/usr/bin/security', ['-i'], {
      input: `add-generic-password -U -s ${service} -a ${account} -w ${value.toString('base64')}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || !read(account).equals(value)) throw new Error(`keychain write failed (${service})`);
  };
  const remove = (account) => {
    try {
      io.execFileSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      /* Retain secrets in Keychain if deletion fails. */
    }
  };
  const removeChunks = (account, item) => {
    if (item) for (let i = 0; i < item.count; i++) remove(chunkAccount(account, item, i));
  };
  return {
    set(account, value) {
      assertAccount(account);
      const bytes = Buffer.from(value);
      if (bytes.length > MAX_BYTES) throw new Error('keychain value too large');
      let previous = null;
      let previousRaw = null;
      try {
        previousRaw = read(account);
        previous = manifest(previousRaw);
      } catch (error) {
        if (error.code !== 'KEYCHAIN_NOT_FOUND') throw error;
      }
      const next = {
        id: randomBytes(8).toString('hex'),
        count: Math.ceil(bytes.length / CHUNK_BYTES),
        sha256: digest(bytes),
      };
      let publishing = false;
      try {
        for (let i = 0; i < next.count; i++)
          write(chunkAccount(account, next, i), bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
        // Publish only after every chunk exists; recover the prior pointer on publication failure.
        publishing = true;
        write(account, Buffer.from(PREFIX + JSON.stringify(next)));
      } catch (error) {
        if (publishing) {
          // An unsuccessful CLI command may still have modified the item.
          // Restore the old pointer before reclaiming the new generation.
          if (previousRaw) write(account, previousRaw);
          else remove(account);
        }
        // Never reclaim a generation still referenced by the current pointer.
        // An unavailable read/delete keeps encrypted Keychain material intact.
        let referenced = true;
        try {
          referenced = manifest(read(account))?.id === next.id;
        } catch (checkError) {
          if (checkError.code === 'KEYCHAIN_NOT_FOUND') referenced = false;
        }
        if (!referenced) removeChunks(account, next);
        throw error;
      }
      removeChunks(account, previous);
    },
    get(account) {
      assertAccount(account);
      const value = read(account);
      const item = manifest(value);
      if (!item) return value; // Legacy single-item values remain readable.
      const chunks = [];
      for (let i = 0; i < item.count; i++) {
        let chunk;
        try {
          chunk = read(chunkAccount(account, item, i));
        } catch {
          throw new Error('keychain chunk unavailable');
        }
        if (chunk.length > CHUNK_BYTES) throw new Error('invalid keychain chunk');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length > MAX_BYTES || digest(bytes) !== item.sha256)
        throw new Error('keychain value integrity check failed');
      return bytes;
    },
  };
}

// Serialize readers and writers across relay/CLI processes. Kept lock files are
// empty metadata; the kernel releases locks even if the worker exits or crashes.
export function macKeychain(service, io = { spawnSync }, root = path.join(os.homedir(), '.t3poc', 'keychain-locks')) {
  if (!ACCOUNT_RE.test(service)) throw new Error('rejected keychain service');
  const run = (action, account, value) => {
    assertAccount(account);
    const bytes = value === undefined ? null : Buffer.from(value);
    if (bytes && bytes.length > MAX_BYTES) throw new Error('keychain value too large');
    const parent = path.dirname(root);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const dir of [parent, root]) {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077)
        throw new Error('unsafe keychain lock directory');
    }
    const file = path.join(root, digest(`${service}\0${account}`));
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.nlink !== 1)
        throw new Error('unsafe keychain lock file');
    } finally {
      fs.closeSync(fd);
    }
    const worker = fileURLToPath(new URL('./keychain-worker.mjs', import.meta.url));
    const result = io.spawnSync(
      '/usr/bin/lockf',
      ['-k', '-s', '-t', '0', file, process.execPath, worker, action, service, account],
      {
        input: bytes ? JSON.stringify({ b64: bytes.toString('base64') }) : '',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 24 * 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      const error = new Error(`keychain ${action} failed (${service})`);
      if (result.status === 44) error.code = 'KEYCHAIN_NOT_FOUND';
      throw error;
    }
    return action === 'get' ? Buffer.from(String(result.stdout).trim(), 'base64') : undefined;
  };
  return { set: (account, value) => run('set', account, value), get: (account) => run('get', account) };
}
