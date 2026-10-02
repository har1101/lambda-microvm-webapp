// Deployed end-to-end test for the OMP Cloud IDE.
//
//   AWS_PROFILE=... node scripts/e2e.mjs [--url https://xxxx.cloudfront.net] [--keep-auth-row]
//
// It exercises the real CloudFront/Lambda@Edge/MicroVM path with a temporary
// Edge sign-in row written straight to DynamoDB (Cognito Managed Login needs a
// human TOTP, so only its redirect is checked). It starts exactly one MicroVM,
// checks code-server, the restored auth state and the session file through
// code-server's remote-resource endpoint, suspends, resumes, terminates it via
// the confirmation form, and verifies that every MicroVM that existed before the
// run is still alive. Cleanup in `finally` only touches the IDs this run created.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../artifact/edge/', import.meta.url));
const {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  TerminateMicrovmCommand,
} = require('@aws-sdk/client-lambda-microvms');
const { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const edgeConfig = JSON.parse(readFileSync(new URL('../artifact/edge/config.json', import.meta.url), 'utf8'));
const mvm = new LambdaMicrovmsClient({ region: edgeConfig.MVM_REGION });
const ddb = new DynamoDBClient({ region: edgeConfig.TABLE_REGION });

const READY_TIMEOUT_MS = 240_000;
const STATE_TIMEOUT_MS = 180_000;
const POLL_MS = 3_000;
const REMOTE_HOME = '/home/vscode/.cache/omp-cloud-ide';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const siteUrl = new URL(argValue('--url') ?? process.env.E2E_URL ?? findDistributionUrl());
const origin = siteUrl.origin;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}

function findDistributionUrl() {
  const domain = execFileSync(
    'aws',
    [
      'cloudfront',
      'list-distributions',
      '--query',
      "DistributionList.Items[?Comment=='Personal OMP cloud IDE on Lambda MicroVM'].DomainName | [0]",
      '--output',
      'text',
    ],
    { encoding: 'utf8' },
  ).trim();
  if (!domain || domain === 'None') throw new Error('CloudFront distribution not found; pass --url');
  return `https://${domain}`;
}

// ---- HTTP with a minimal cookie jar (Edge cookies are host-only) ----
const jar = new Map();
function storeCookies(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}
async function http(path, { method = 'GET', form, accept = 'text/html' } = {}) {
  const headers = { accept, 'user-agent': 'omp-cloud-ide-e2e' };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers.origin = origin;
    body = new URLSearchParams(form).toString();
  }
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  storeCookies(response);
  return { status: response.status, location: response.headers.get('location') ?? '', text: await response.text() };
}

async function waitFor(description, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe().catch((error) => ({ ok: false, detail: error.message }));
    if (last.ok) return last;
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${description}: ${last?.detail ?? ''}`);
}

// code-server answers `/` with a redirect to `./?folder=...` once it is ready.
const editorReady = async () => {
  const response = await http('/');
  return { ok: response.status === 302 && response.location.includes('folder='), detail: `${response.status}` };
};

async function remoteJson(path) {
  const response = await http(`/vscode-remote-resource?path=${encodeURIComponent(path)}`, { accept: '*/*' });
  if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}`);
  return JSON.parse(response.text);
}

async function listLiveMicrovms() {
  const ids = new Set();
  for (const image of edgeConfig.IMAGES) {
    let nextToken;
    do {
      const page = await mvm.send(new ListMicrovmsCommand({ imageIdentifier: image.arn, maxResults: 50, nextToken }));
      for (const item of page.items ?? []) {
        if (item.microvmId && item.state !== 'TERMINATED' && item.state !== 'TERMINATING') ids.add(item.microvmId);
      }
      nextToken = page.nextToken;
    } while (nextToken);
  }
  return ids;
}

async function microvmState(microvmId) {
  try {
    return (await mvm.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }))).state;
  } catch (error) {
    if (error?.name === 'ResourceNotFoundException') return 'TERMINATED';
    throw error;
  }
}

async function main() {
  // config.json is regenerated by every synth, including Jest's fake-account
  // synth. Stale values would point the protection snapshot at the wrong image.
  const account = execFileSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], {
    encoding: 'utf8',
  }).trim();
  if (!edgeConfig.IMAGES.every((image) => image.arn.includes(`:${account}:`))) {
    throw new Error(`artifact/edge/config.json is not for account ${account}; run \`npm run synth\` first`);
  }
  console.log(`E2E target ${origin}`);
  const protectedIds = await listLiveMicrovms();
  console.log(`protected MicroVMs: ${[...protectedIds].join(', ') || '(none)'}`);

  const accessCookie = randomBytes(32).toString('base64url');
  const authKey = `sess#${createHash('sha256').update(accessCookie).digest('base64url')}`;
  let createdMicrovmId;
  let sessionId;
  let requestId;
  let terminated = false;

  try {
    // ---- unauthenticated behaviour ----
    const anonymous = await http('/');
    check(
      'unauthenticated HTML navigation redirects to sign-in',
      anonymous.status === 302 && anonymous.location.endsWith('/auth/login'),
      anonymous.location,
    );
    const api = await http('/', { accept: 'application/json' });
    check('unauthenticated non-HTML request is 401', api.status === 401);
    const login = await http('/auth/login');
    const authorize = login.location ? new URL(login.location) : undefined;
    check(
      'sign-in redirects to Cognito with PKCE',
      login.status === 302 &&
        authorize?.hostname === edgeConfig.COGNITO_DOMAIN &&
        authorize.searchParams.get('code_challenge_method') === 'S256' &&
        authorize.searchParams.get('redirect_uri') === `${origin}/auth/callback`,
      authorize?.origin,
    );
    jar.clear();

    // ---- temporary Edge sign-in (bypasses Cognito's human TOTP only) ----
    const now = Date.now();
    const expiresAt = now + 60 * 60_000;
    await ddb.send(
      new PutItemCommand({
        TableName: edgeConfig.AUTH_TABLE,
        Item: {
          id: { S: authKey },
          sub: { S: 'e2e-test' },
          createdAt: { N: String(now) },
          expiresAt: { N: String(expiresAt) },
          ttl: { N: String(Math.ceil(expiresAt / 1000)) },
        },
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
    jar.set(edgeConfig.ACCESS_COOKIE_NAME, accessCookie);

    const chooser = await http('/session/select');
    const defaultImage = edgeConfig.IMAGES[0];
    // Start a non-default size: a missing or ignored `size` would fall back to the
    // default and pass, and only a real start proves IAM covers the other images.
    const chosenImage = edgeConfig.IMAGES[1];
    check('signed-in chooser renders', chooser.status === 200 && chooser.text.includes('Start a new MicroVM'));
    check(
      'chooser offers every MicroVM size with the default selected',
      edgeConfig.IMAGES.every((image) => chooser.text.includes(`name="size" value="${image.id}"`)) &&
        chooser.text.includes(`value="${defaultImage.id}" checked`),
    );

    // ---- start exactly one MicroVM ----
    requestId = randomUUID();
    const started = await http('/session/select', {
      method: 'POST',
      form: { action: 'new', requestId, size: chosenImage.id },
    });
    sessionId = jar.get('mvm-session');
    check('new MicroVM start is accepted', started.status === 200 && sessionId === requestId, `HTTP ${started.status}`);
    const row = await ddb.send(
      new GetItemCommand({ TableName: edgeConfig.TABLE, Key: { sessionId: { S: sessionId } }, ConsistentRead: true }),
    );
    const microvmId = row.Item?.microvmId?.S;
    check('session row tracks the new MicroVM', Boolean(microvmId), microvmId);
    check('new MicroVM is not a pre-existing one', !protectedIds.has(microvmId));
    // Only now is the ID eligible for cleanup.
    createdMicrovmId = microvmId;
    const createdImageArn = (await mvm.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }))).imageArn;
    check('new MicroVM uses the selected size image', createdImageArn === chosenImage.arn, createdImageArn);

    const startClock = Date.now();
    await waitFor('code-server after start', editorReady, READY_TIMEOUT_MS);
    check('code-server is reachable through CloudFront', true, `${Math.round((Date.now() - startClock) / 1000)}s`);

    // ---- /run hook results inside the VM ----
    const session = await remoteJson(`${REMOTE_HOME}/session.json`);
    check('run hook recorded the MicroVM ID', session.microvmId === createdMicrovmId);
    check(
      'run hook recorded a deadline about 8 hours ahead',
      Math.abs(session.expiresAt - (startClock + edgeConfig.MAX_DURATION_SEC * 1000)) < 5 * 60_000,
    );
    check('run hook recorded the control URL', session.controlUrl === `${origin}/session/control`, session.controlUrl);
    const authSync = await waitFor(
      'auth restore record',
      async () => {
        const status = await remoteJson(`${REMOTE_HOME}/auth-sync.json`);
        return { ok: Array.isArray(status.restoreFailed), status, detail: 'no restoreFailed yet' };
      },
      60_000,
    );
    check(
      'auth state restored without failures',
      authSync.status.restoreFailed.length === 0,
      JSON.stringify(authSync.status.restoreFailed),
    );
    const restored = Object.entries(authSync.status.files ?? {}).filter(([, file]) =>
      /^[0-9a-f]{64}$/.test(file?.sha256),
    );
    check('persisted auth files were restored', restored.length > 0, restored.map(([key]) => key).join(', '));

    // ---- explicit suspend blocks editor traffic ----
    const control = await http('/session/control');
    check('control page renders for the session', control.status === 200 && control.text.includes('/session/suspend'));
    const suspended = await http('/session/suspend', { method: 'POST', form: {} });
    check('suspend is accepted', suspended.status === 200 && suspended.text.includes('Suspend requested'));
    // Checked right after the suspend request, before the snapshot makes the origin unreachable.
    const blocked = await http('/');
    check(
      'editor traffic is redirected to the control page while paused',
      blocked.status === 302 && blocked.location.endsWith('/session/control'),
      `${blocked.status} ${blocked.location}`,
    );
    await waitFor(
      'SUSPENDED state',
      async () => {
        const state = await microvmState(createdMicrovmId);
        return { ok: state === 'SUSPENDED', detail: state };
      },
      STATE_TIMEOUT_MS,
    );
    check('MicroVM reached SUSPENDED', true);

    // ---- explicit resume restores the same VM ----
    const resumed = await http('/session/resume', { method: 'POST', form: {} });
    check('resume is accepted', resumed.status === 200 || resumed.status === 302, `HTTP ${resumed.status}`);
    await waitFor('code-server after resume', editorReady, READY_TIMEOUT_MS);
    const afterResume = await remoteJson(`${REMOTE_HOME}/session.json`);
    check('the same MicroVM is back after resume', afterResume.microvmId === createdMicrovmId);

    // ---- confirmed termination ----
    const confirm = await http('/session/select', {
      method: 'POST',
      form: { action: 'terminate-confirm', sessionId, microvmId: createdMicrovmId },
    });
    check(
      'termination asks for the MicroVM ID',
      confirm.status === 200 && confirm.text.includes('Type the MicroVM ID'),
    );
    const wrong = await http('/session/select', {
      method: 'POST',
      form: { action: 'terminate', sessionId, microvmId: createdMicrovmId, confirmation: 'microvm-wrong' },
    });
    check('a wrong confirmation is rejected', wrong.text.includes('Type the exact MicroVM ID'));
    check('MicroVM still runs after the wrong confirmation', (await microvmState(createdMicrovmId)) === 'RUNNING');
    const terminate = await http('/session/select', {
      method: 'POST',
      form: { action: 'terminate', sessionId, microvmId: createdMicrovmId, confirmation: createdMicrovmId },
    });
    check('termination is accepted', terminate.status === 200 && terminate.text.includes('Termination requested'));
    await waitFor(
      'TERMINATED state and row removal',
      async () => {
        await http('/session/select'); // the chooser deletes rows of terminated VMs
        const state = await microvmState(createdMicrovmId);
        const left = await ddb.send(
          new GetItemCommand({
            TableName: edgeConfig.TABLE,
            Key: { sessionId: { S: sessionId } },
            ConsistentRead: true,
          }),
        );
        return { ok: state === 'TERMINATED' && !left.Item, detail: `${state}, row ${left.Item ? 'present' : 'gone'}` };
      },
      STATE_TIMEOUT_MS,
    );
    terminated = true;
    check('terminated MicroVM and its session row are gone', true);
  } finally {
    // A start can time out after RunMicrovm; the form UUID is the session key,
    // so recover the MicroVM this run created from its row.
    if (!createdMicrovmId && requestId) {
      const row = await ddb
        .send(
          new GetItemCommand({
            TableName: edgeConfig.TABLE,
            Key: { sessionId: { S: requestId } },
            ConsistentRead: true,
          }),
        )
        .catch(() => undefined);
      const candidate = row?.Item?.microvmId?.S;
      if (candidate && !protectedIds.has(candidate)) createdMicrovmId = candidate;
    }
    if (createdMicrovmId && !terminated) {
      if (protectedIds.has(createdMicrovmId)) {
        console.error(`cleanup: refusing to terminate pre-existing ${createdMicrovmId}`);
      } else {
        console.log(`cleanup: terminating ${createdMicrovmId}`);
        await mvm.send(new TerminateMicrovmCommand({ microvmIdentifier: createdMicrovmId })).catch((error) => {
          console.error(`cleanup: TerminateMicrovm failed (${error?.name}); terminate ${createdMicrovmId} manually`);
        });
        await waitFor(
          'cleanup termination',
          async () => {
            const state = await microvmState(createdMicrovmId);
            return { ok: state === 'TERMINATED', detail: state };
          },
          STATE_TIMEOUT_MS,
        ).then(
          () => {
            terminated = true;
          },
          (error) => console.error(`cleanup: ${error.message}; ${createdMicrovmId} may still be running`),
        );
      }
    }
    // Keep the row of a MicroVM that might still run, so the chooser still shows it.
    if (requestId && createdMicrovmId && terminated) {
      await ddb
        .send(
          new DeleteItemCommand({
            TableName: edgeConfig.TABLE,
            Key: { sessionId: { S: requestId } },
            ConditionExpression: 'microvmId = :id',
            ExpressionAttributeValues: { ':id': { S: createdMicrovmId } },
          }),
        )
        .catch((error) => {
          if (error?.name !== 'ConditionalCheckFailedException') console.error('cleanup: session row', error?.name);
        });
    }
    if (!args.includes('--keep-auth-row')) {
      await ddb
        .send(new DeleteItemCommand({ TableName: edgeConfig.AUTH_TABLE, Key: { id: { S: authKey } } }))
        .catch((error) => console.error('cleanup: auth row', error?.name));
    }
    const stillLive = await listLiveMicrovms();
    const lost = [...protectedIds].filter((id) => !stillLive.has(id));
    console.log(
      lost.length ? `FAIL protected MicroVMs disappeared: ${lost.join(', ')}` : 'PASS protected MicroVMs intact',
    );
    if (lost.length) process.exitCode = 1;
  }
}

try {
  await main();
  console.log(`\n${results.length} checks passed`);
} catch (error) {
  console.error(`\nE2E failed: ${error.message}`);
  process.exitCode = 1;
}
