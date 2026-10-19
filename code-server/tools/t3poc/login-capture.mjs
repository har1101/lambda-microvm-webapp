import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
} from '@aws-sdk/client-lambda-microvms';
import { captureLogins, injectEnabled } from './ext-40-logins.mjs';
import { macKeychain } from './keychain.mjs';
import { createRuntime, parseArgs } from './t3poc.mjs';
import { shellExec } from './vm-shell.mjs';

export async function captureNow(opts, deps, env = process.env) {
  if (!injectEnabled(opts, env)) throw new Error('login capture requires --inject-logins or T3POC_INJECT_LOGINS=1');
  const saved = deps.readState();
  if (!saved?.microvmId || !saved.endpoint) throw new Error('no MicroVM recorded');
  const current = await deps.getMicrovm(saved.microvmId);
  const api = createRuntime({ ...deps, opts, env });
  api.attach({ ...saved, vmState: current.state });
  return api.exclusive(() => captureLogins(api));
}

async function main() {
  const { opts } = parseArgs(['capture', ...process.argv.slice(2)]);
  if (!injectEnabled(opts, process.env)) throw new Error('disabled');
  const stateFile = opts['state-file'] ?? path.join(os.homedir(), '.t3poc', 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const client = new LambdaMicrovmsClient({
    region: saved.region ?? process.env.T3POC_REGION ?? 'ap-northeast-1',
    maxAttempts: 1,
  });
  try {
    const result = await captureNow(opts, {
      readState: () => saved,
      getMicrovm: (id) => client.send(new GetMicrovmCommand({ microvmIdentifier: id })),
      keychain: macKeychain,
      async shell(input) {
        const { WebSocket } = await import('ws');
        const response = await client.send(
          new CreateMicrovmShellAuthTokenCommand({ microvmIdentifier: saved.microvmId, expirationInMinutes: 5 }),
        );
        return shellExec({
          ...input,
          endpoint: saved.endpoint,
          token: response.authToken['X-aws-proxy-auth'],
          WebSocket,
        });
      },
    });
    for (const [kind, status] of Object.entries(result)) console.log(`${kind} login: ${status}`);
  } finally {
    client.destroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch(() => {
    console.error('login capture failed; require explicit opt-in, a RUNNING recorded VM and accessible Keychain');
    process.exitCode = 1;
  });
}
