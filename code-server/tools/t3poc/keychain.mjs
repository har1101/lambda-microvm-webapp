// macOS Keychain access. Values are base64 on the `security -i` stdin so they
// are not argv and this module never writes them to a file.
import { execFileSync, spawnSync } from 'node:child_process';

const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,64}$/;

function assertAccount(account) {
  if (!ACCOUNT_RE.test(account)) throw new Error('rejected keychain account');
}

export function memoryKeychain() {
  const values = new Map();
  return {
    async set(account, value) {
      assertAccount(account);
      values.set(account, Buffer.from(value));
    },
    async get(account) {
      assertAccount(account);
      if (!values.has(account)) throw new Error('keychain item not found');
      return Buffer.from(values.get(account));
    },
    has(account) {
      return values.has(account);
    },
  };
}

export function macKeychain(service, io = { execFileSync, spawnSync }) {
  if (!ACCOUNT_RE.test(service)) throw new Error('rejected keychain service');
  return {
    set(account, value) {
      assertAccount(account);
      const b64 = Buffer.from(value).toString('base64');
      const result = io.spawnSync('security', ['-i'], {
        input: `add-generic-password -U -s ${service} -a ${account} -w ${b64}\n`,
      });
      if (result.status !== 0) throw new Error(`keychain write failed (${service})`);
    },
    get(account) {
      assertAccount(account);
      let out;
      try {
        out = io.execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
          encoding: 'utf8',
        });
      } catch {
        throw new Error(`keychain read failed (${service})`);
      }
      return Buffer.from(String(out).trim(), 'base64');
    },
  };
}
