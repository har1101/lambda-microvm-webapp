// Run only under the public macKeychain lockf wrapper. No values in argv/files.
import { rawMacKeychain } from './keychain.mjs';

try {
  const [action, service, account] = process.argv.slice(2);
  const keychain = rawMacKeychain(service);
  if (action === 'get') process.stdout.write(keychain.get(account).toString('base64'));
  else if (action === 'set') {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) throw Error('too large');
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof payload?.b64 !== 'string') throw Error('invalid payload');
    keychain.set(account, Buffer.from(payload.b64, 'base64'));
  } else throw Error('invalid action');
} catch (error) {
  process.exitCode = error.code === 'KEYCHAIN_NOT_FOUND' ? 44 : 1;
}
