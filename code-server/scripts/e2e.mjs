// Deployed end-to-end test for the OMP Cloud IDE.
//
//   AWS_PROFILE=... node scripts/e2e.mjs [--url https://xxxx.cloudfront.net] [--keep-auth-row]
//
// It exercises the real CloudFront/Lambda@Edge/MicroVM path with temporary Edge
// sign-in rows (one admin, one guest) written straight to DynamoDB (Cognito
// Managed Login needs a human TOTP, so only its redirect is checked). The admin
// starts one MicroVM; the run checks code-server, the restored auth state and the
// session file through code-server's remote-resource endpoint. While it runs, the
// guest must not see or reach it, starts its own MicroVM without auth state, is
// held to one MicroVM, and terminates it. The admin then suspends, resumes and
// terminates its MicroVM via the confirmation form, and the run verifies that
// every MicroVM that existed before is still alive. Cleanup in `finally` only
// touches the IDs and rows this run created.
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
const REMOTE_AGENT_DB = '/home/vscode/.omp/agent/agent.db';

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

/** One browser: a minimal cookie jar (Edge cookies are host-only) and the requests made with it. */
function makeBrowser() {
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
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      location: response.headers.get('location') ?? '',
      bytes,
      text: bytes.toString('utf8'),
    };
  }
  const remote = (path) => http(`/vscode-remote-resource?path=${encodeURIComponent(path)}`, { accept: '*/*' });
  return {
    jar,
    http,
    remote,
    // code-server answers `/` with a redirect to `./?folder=...` once it is ready.
    async editorReady() {
      const response = await http('/');
      return { ok: response.status === 302 && response.location.includes('folder='), detail: `${response.status}` };
    },
    async remoteJson(path) {
      const response = await remote(path);
      if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}`);
      return JSON.parse(response.text);
    },
  };
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

const getSessionRow = (sessionId) =>
  ddb.send(
    new GetItemCommand({ TableName: edgeConfig.TABLE, Key: { sessionId: { S: sessionId } }, ConsistentRead: true }),
  );

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

  // Per-run identities, so a leftover guest slot from an aborted run cannot block this one.
  const runId = randomUUID().slice(0, 8);
  const adminUser = { sub: `e2e-admin-${runId}`, role: 'admin', email: `e2e-admin-${runId}@example.invalid` };
  const guestUser = { sub: `e2e-guest-${runId}`, role: 'guest', email: `e2e-guest-${runId}@example.invalid` };
  const authKeys = [];
  // Every start this run submitted: { requestId, microvmId, terminated }.
  const starts = [];

  async function signIn(browser, user) {
    const accessCookie = randomBytes(32).toString('base64url');
    const authKey = `sess#${createHash('sha256').update(accessCookie).digest('base64url')}`;
    const now = Date.now();
    const expiresAt = now + 60 * 60_000;
    await ddb.send(
      new PutItemCommand({
        TableName: edgeConfig.AUTH_TABLE,
        Item: {
          id: { S: authKey },
          sub: { S: user.sub },
          role: { S: user.role },
          email: { S: user.email },
          createdAt: { N: String(now) },
          expiresAt: { N: String(expiresAt) },
          ttl: { N: String(Math.ceil(expiresAt / 1000)) },
        },
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
    authKeys.push(authKey);
    browser.jar.set(edgeConfig.ACCESS_COOKIE_NAME, accessCookie);
  }

  // Registered before posting: if a guard regresses and a probe starts a real
  // MicroVM, cleanup recovers it from the row keyed by this request ID.
  function newStartRequest() {
    const entry = { requestId: randomUUID(), microvmId: undefined, terminated: false };
    starts.push(entry);
    return entry;
  }

  async function start(browser, image, user) {
    const entry = newStartRequest();
    const { requestId } = entry;
    const response = await browser.http('/session/select', {
      method: 'POST',
      form: { action: 'new', requestId, size: image.id },
    });
    const sessionId = browser.jar.get('mvm-session');
    check(
      `${user.role}: new MicroVM start is accepted`,
      response.status === 200 && sessionId === requestId,
      `HTTP ${response.status}`,
    );
    const row = await getSessionRow(sessionId);
    const microvmId = row.Item?.microvmId?.S;
    check(`${user.role}: session row tracks the new MicroVM`, Boolean(microvmId), microvmId);
    check(`${user.role}: session row records its owner`, row.Item?.ownerSub?.S === user.sub, row.Item?.ownerSub?.S);
    check(`${user.role}: new MicroVM is not a pre-existing one`, !protectedIds.has(microvmId));
    // Only now is the ID eligible for cleanup.
    entry.microvmId = microvmId;
    const microvm = await mvm.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
    check(`${user.role}: new MicroVM uses the selected size image`, microvm.imageArn === image.arn, microvm.imageArn);
    const expectedRole = user.role === 'admin' ? edgeConfig.EXECUTION_ROLE_ARN : edgeConfig.GUEST_EXECUTION_ROLE_ARN;
    check(
      `${user.role}: new MicroVM runs with the ${user.role} execution role`,
      microvm.executionRoleArn === expectedRole,
      microvm.executionRoleArn,
    );
    return { sessionId, microvmId, entry };
  }

  async function terminateViaForm(browser, user, { sessionId, microvmId, entry }) {
    const confirm = await browser.http('/session/select', {
      method: 'POST',
      form: { action: 'terminate-confirm', sessionId, microvmId },
    });
    check(
      `${user.role}: termination asks for the MicroVM ID`,
      confirm.status === 200 && confirm.text.includes('Type the MicroVM ID'),
    );
    if (user.role === 'admin') {
      const wrong = await browser.http('/session/select', {
        method: 'POST',
        form: { action: 'terminate', sessionId, microvmId, confirmation: 'microvm-wrong' },
      });
      check('a wrong confirmation is rejected', wrong.text.includes('Type the exact MicroVM ID'));
      check('MicroVM still runs after the wrong confirmation', (await microvmState(microvmId)) === 'RUNNING');
    }
    const terminate = await browser.http('/session/select', {
      method: 'POST',
      form: { action: 'terminate', sessionId, microvmId, confirmation: microvmId },
    });
    check(
      `${user.role}: termination is accepted`,
      terminate.status === 200 && terminate.text.includes('Termination requested'),
    );
    await waitFor(
      'TERMINATED state and row removal',
      async () => {
        await browser.http('/session/select'); // the chooser deletes rows of terminated VMs
        const state = await microvmState(microvmId);
        const left = await getSessionRow(sessionId);
        return { ok: state === 'TERMINATED' && !left.Item, detail: `${state}, row ${left.Item ? 'present' : 'gone'}` };
      },
      STATE_TIMEOUT_MS,
    );
    entry.terminated = true;
    check(`${user.role}: terminated MicroVM and its session row are gone`, true);
  }

  try {
    // ---- unauthenticated behaviour ----
    const anonymous = makeBrowser();
    const home = await anonymous.http('/');
    check(
      'unauthenticated HTML navigation redirects to sign-in',
      home.status === 302 && home.location.endsWith('/auth/login'),
      home.location,
    );
    const api = await anonymous.http('/', { accept: 'application/json' });
    check('unauthenticated non-HTML request is 401', api.status === 401);
    const login = await anonymous.http('/auth/login');
    const authorize = login.location ? new URL(login.location) : undefined;
    check(
      'sign-in redirects to Cognito with PKCE',
      login.status === 302 &&
        authorize?.hostname === edgeConfig.COGNITO_DOMAIN &&
        authorize.searchParams.get('code_challenge_method') === 'S256' &&
        authorize.searchParams.get('redirect_uri') === `${origin}/auth/callback`,
      authorize?.origin,
    );

    // ---- temporary Edge sign-ins (bypass Cognito's human TOTP only) ----
    const admin = makeBrowser();
    const guest = makeBrowser();
    await signIn(admin, adminUser);
    await signIn(guest, guestUser);

    const adminChooser = await admin.http('/session/select');
    const defaultImage = edgeConfig.IMAGES[0];
    // Start a non-default size: a missing or ignored `size` would fall back to the
    // default and pass, and only a real start proves IAM covers the other images.
    const adminImage = edgeConfig.IMAGES[1];
    check(
      'admin: signed-in chooser renders',
      adminChooser.status === 200 && adminChooser.text.includes('Start a new MicroVM'),
    );
    check(
      'admin: chooser offers every MicroVM size with the default selected',
      edgeConfig.IMAGES.every((image) => adminChooser.text.includes(`name="size" value="${image.id}"`)) &&
        adminChooser.text.includes(`value="${defaultImage.id}" checked`),
    );

    // ---- the admin starts one MicroVM ----
    const adminVm = await start(admin, adminImage, adminUser);
    const startClock = Date.now();
    await waitFor('code-server after start', () => admin.editorReady(), READY_TIMEOUT_MS);
    check('code-server is reachable through CloudFront', true, `${Math.round((Date.now() - startClock) / 1000)}s`);

    // ---- /run hook results inside the admin VM ----
    const session = await admin.remoteJson(`${REMOTE_HOME}/session.json`);
    check('run hook recorded the MicroVM ID', session.microvmId === adminVm.microvmId);
    check(
      'run hook recorded a deadline about 8 hours ahead',
      Math.abs(session.expiresAt - (startClock + edgeConfig.MAX_DURATION_SEC * 1000)) < 5 * 60_000,
    );
    check('run hook recorded the control URL', session.controlUrl === `${origin}/session/control`, session.controlUrl);
    const authSync = await waitFor(
      'auth restore record',
      async () => {
        const status = await admin.remoteJson(`${REMOTE_HOME}/auth-sync.json`);
        return { ok: Array.isArray(status.restoreFailed), status, detail: 'no restoreFailed yet' };
      },
      60_000,
    );
    check('admin: auth persistence is enabled', authSync.status.persistence === 'enabled', authSync.status.persistence);
    check(
      'auth state restored without failures',
      authSync.status.restoreFailed.length === 0,
      JSON.stringify(authSync.status.restoreFailed),
    );
    const restored = Object.entries(authSync.status.files ?? {}).filter(([, file]) =>
      /^[0-9a-f]{64}$/.test(file?.sha256),
    );
    check('persisted auth files were restored', restored.length > 0, restored.map(([key]) => key).join(', '));

    // ---- the guest can neither see nor reach the admin's MicroVM ----
    const guestChooser = await guest.http('/session/select');
    const guestImages = edgeConfig.IMAGES.filter((image) => image.roles.includes('guest'));
    const adminOnlyImages = edgeConfig.IMAGES.filter((image) => !image.roles.includes('guest'));
    check('guest: signed-in chooser renders', guestChooser.status === 200);
    check('guest: chooser does not list the admin MicroVM', !guestChooser.text.includes(adminVm.microvmId));
    check(
      'guest: chooser offers only guest sizes',
      guestImages.every((image) => guestChooser.text.includes(`name="size" value="${image.id}"`)) &&
        adminOnlyImages.every((image) => !guestChooser.text.includes(`name="size" value="${image.id}"`)),
    );
    const foreignAttach = await guest.http('/session/select', {
      method: 'POST',
      form: { action: 'attach', sessionId: adminVm.sessionId },
    });
    check(
      'guest: attaching the admin session is refused',
      foreignAttach.status !== 303 && guest.jar.get('mvm-session') !== adminVm.sessionId,
      `HTTP ${foreignAttach.status}`,
    );
    // Even a stolen session ID must not route the guest's browser to the admin VM.
    guest.jar.set('mvm-session', adminVm.sessionId);
    const forged = await guest.http('/');
    check(
      'guest: a forged session cookie never reaches the admin editor',
      !(forged.status === 302 && forged.location.includes('folder=')),
      `${forged.status} ${forged.location}`,
    );
    guest.jar.delete('mvm-session');
    if (adminOnlyImages.length) {
      const tooLarge = await guest.http('/session/select', {
        method: 'POST',
        form: { action: 'new', requestId: newStartRequest().requestId, size: adminOnlyImages[0].id },
      });
      check(`guest: starting ${adminOnlyImages[0].id} is refused`, tooLarge.status === 400, `HTTP ${tooLarge.status}`);
    }

    // ---- the guest starts one MicroVM without auth state ----
    const guestVm = await start(guest, guestImages[0], guestUser);
    await waitFor('guest code-server after start', () => guest.editorReady(), READY_TIMEOUT_MS);
    check('guest: code-server is reachable through CloudFront', true);
    const guestSync = await waitFor(
      'guest auth persistence record',
      async () => {
        const status = await guest.remoteJson(`${REMOTE_HOME}/auth-sync.json`);
        return { ok: typeof status.persistence === 'string', status, detail: 'not recorded yet' };
      },
      60_000,
    );
    check(
      'guest: auth persistence is disabled',
      guestSync.status.persistence === 'disabled',
      guestSync.status.persistence,
    );
    // The image may create an empty agent.db; it must just never be the admin's restored one.
    const adminAgentDbSha = authSync.status.files?.['omp/agent.db']?.sha256;
    const guestAgentDb = await guest.remote(REMOTE_AGENT_DB);
    const guestAgentDbSha =
      guestAgentDb.status === 200 ? createHash('sha256').update(guestAgentDb.bytes).digest('hex') : 'absent';
    check(
      'guest: the admin OMP credentials were not restored',
      Boolean(adminAgentDbSha) && guestAgentDbSha !== adminAgentDbSha,
      `guest agent.db ${guestAgentDbSha}`,
    );

    const beforeSecond = await listLiveMicrovms();
    const second = await guest.http('/session/select', {
      method: 'POST',
      form: { action: 'new', requestId: newStartRequest().requestId, size: guestImages[0].id },
    });
    check('guest: a second MicroVM is refused', second.status === 409, `HTTP ${second.status}`);
    const afterSecond = await listLiveMicrovms();
    check(
      'guest: the refused start created no MicroVM',
      [...afterSecond].every((id) => beforeSecond.has(id)),
      [...afterSecond].filter((id) => !beforeSecond.has(id)).join(', '),
    );
    guest.jar.set('mvm-session', guestVm.sessionId);

    // ---- the admin sees the guest MicroVM but cannot enter it ----
    const adminView = await admin.http('/session/select');
    check(
      'admin: chooser lists the guest MicroVM with its owner',
      adminView.text.includes(guestVm.microvmId) && adminView.text.includes(guestUser.email),
    );
    const adminForeignAttach = await admin.http('/session/select', {
      method: 'POST',
      form: { action: 'attach', sessionId: guestVm.sessionId },
    });
    check(
      'admin: attaching the guest session is refused',
      adminForeignAttach.status !== 303 && admin.jar.get('mvm-session') === adminVm.sessionId,
      `HTTP ${adminForeignAttach.status}`,
    );
    admin.jar.set('mvm-session', adminVm.sessionId);

    // ---- the guest terminates its own MicroVM, freeing its slot ----
    await terminateViaForm(guest, guestUser, guestVm);
    const slot = await getSessionRow(`slot#${guestUser.sub}`);
    check('guest: the one-MicroVM slot is released', !slot.Item, slot.Item ? JSON.stringify(slot.Item) : '');

    // ---- explicit suspend blocks editor traffic ----
    const control = await admin.http('/session/control');
    check('control page renders for the session', control.status === 200 && control.text.includes('/session/suspend'));
    const suspended = await admin.http('/session/suspend', { method: 'POST', form: {} });
    check('suspend is accepted', suspended.status === 200 && suspended.text.includes('Suspend requested'));
    // Checked right after the suspend request, before the snapshot makes the origin unreachable.
    const blocked = await admin.http('/');
    check(
      'editor traffic is redirected to the control page while paused',
      blocked.status === 302 && blocked.location.endsWith('/session/control'),
      `${blocked.status} ${blocked.location}`,
    );
    await waitFor(
      'SUSPENDED state',
      async () => {
        const state = await microvmState(adminVm.microvmId);
        return { ok: state === 'SUSPENDED', detail: state };
      },
      STATE_TIMEOUT_MS,
    );
    check('MicroVM reached SUSPENDED', true);

    // ---- explicit resume restores the same VM ----
    const resumed = await admin.http('/session/resume', { method: 'POST', form: {} });
    check('resume is accepted', resumed.status === 200 || resumed.status === 302, `HTTP ${resumed.status}`);
    await waitFor('code-server after resume', () => admin.editorReady(), READY_TIMEOUT_MS);
    const afterResume = await admin.remoteJson(`${REMOTE_HOME}/session.json`);
    check('the same MicroVM is back after resume', afterResume.microvmId === adminVm.microvmId);

    // ---- confirmed termination ----
    await terminateViaForm(admin, adminUser, adminVm);
  } finally {
    for (const entry of starts) {
      // A start can time out after RunMicrovm; the form UUID is the session key,
      // so recover the MicroVM this run created from its row.
      if (!entry.microvmId) {
        const row = await getSessionRow(entry.requestId).catch(() => undefined);
        const candidate = row?.Item?.microvmId?.S;
        if (candidate && !protectedIds.has(candidate)) entry.microvmId = candidate;
      }
      if (entry.microvmId && !entry.terminated) {
        if (protectedIds.has(entry.microvmId)) {
          console.error(`cleanup: refusing to terminate pre-existing ${entry.microvmId}`);
          continue;
        }
        console.log(`cleanup: terminating ${entry.microvmId}`);
        await mvm.send(new TerminateMicrovmCommand({ microvmIdentifier: entry.microvmId })).catch((error) => {
          console.error(`cleanup: TerminateMicrovm failed (${error?.name}); terminate ${entry.microvmId} manually`);
        });
        await waitFor(
          'cleanup termination',
          async () => {
            const state = await microvmState(entry.microvmId);
            return { ok: state === 'TERMINATED', detail: state };
          },
          STATE_TIMEOUT_MS,
        ).then(
          () => {
            entry.terminated = true;
          },
          (error) => console.error(`cleanup: ${error.message}; ${entry.microvmId} may still be running`),
        );
      }
      // Keep the row of a MicroVM that might still run, so the chooser still shows it.
      if (entry.microvmId && entry.terminated) {
        await ddb
          .send(
            new DeleteItemCommand({
              TableName: edgeConfig.TABLE,
              Key: { sessionId: { S: entry.requestId } },
              ConditionExpression: 'microvmId = :id',
              ExpressionAttributeValues: { ':id': { S: entry.microvmId } },
            }),
          )
          .catch((error) => {
            if (error?.name !== 'ConditionalCheckFailedException') console.error('cleanup: session row', error?.name);
          });
      }
    }
    if (starts.every((entry) => !entry.microvmId || entry.terminated)) {
      await ddb
        .send(
          new DeleteItemCommand({ TableName: edgeConfig.TABLE, Key: { sessionId: { S: `slot#${guestUser.sub}` } } }),
        )
        .catch((error) => console.error('cleanup: guest slot', error?.name));
    }
    if (!args.includes('--keep-auth-row')) {
      for (const authKey of authKeys) {
        await ddb
          .send(new DeleteItemCommand({ TableName: edgeConfig.AUTH_TABLE, Key: { id: { S: authKey } } }))
          .catch((error) => console.error('cleanup: auth row', error?.name));
      }
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
