const cfg = require('./config.json');

const {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
} = require('@aws-sdk/client-lambda-microvms');
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { GetSecretValueCommand, SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');

const mvm = new LambdaMicrovmsClient({ region: cfg.MVM_REGION });
const ddb = new DynamoDBClient({ region: cfg.TABLE_REGION });
const secrets = new SecretsManagerClient({ region: cfg.AUTH_SECRET_REGION });

let cachedPassword;
let passwordCachedAt = 0;
const PASSWORD_CACHE_MS = 5 * 60 * 1000;

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;

  if (request.uri === '/login') {
    return handleLogin(request);
  }

  if (!(await isAuthorized(request.headers))) {
    return redirectToLogin();
  }
  delete request.headers.authorization;

  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies['mvm-session'];
  const isControlRoute = request.uri === '/session/control';
  const isSuspendRoute = request.uri === '/session/suspend';
  const isResumeRoute = request.uri === '/session/resume';

  if (request.uri === '/session/select') {
    return handleSessionSelection(request, sessionId);
  }
  if (request.uri === '/session/start') {
    if (request.method !== 'POST') {
      return redirectToSessionSelect();
    }
    return startSession();
  }

  if (!sessionId) {
    if (isControlRoute || isSuspendRoute || isResumeRoute) {
      return sessionControlResponse({ hasSession: false });
    }
    return redirectToSessionSelect();
  }

  const result = await ddb.send(
    new GetItemCommand({
      TableName: cfg.TABLE,
      Key: { sessionId: { S: sessionId } },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    if (isControlRoute || isSuspendRoute || isResumeRoute) {
      return sessionControlResponse({ hasSession: false, clearSessionCookie: true });
    }
    return redirectToSessionSelect(true);
  }

  const paused = result.Item.paused?.BOOL === true;
  if (isControlRoute) {
    return sessionControlResponse({ hasSession: true, paused });
  }
  if (isSuspendRoute) {
    return suspendSession(request, sessionId, result.Item);
  }
  if (isResumeRoute) {
    return resumeSession(request, sessionId, result.Item);
  }
  if (paused) {
    return pausedSessionResponse(request.headers);
  }

  let token = result.Item.token.S;
  const expiry = Number(result.Item.tokenExpiry.N);
  if (Date.now() > expiry - cfg.TOKEN_REFRESH_THRESHOLD * 60000) {
    try {
      const refreshed = await mvm.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: result.Item.microvmId.S,
          expirationInMinutes: cfg.TOKEN_DURATION_MIN,
          allowedPorts: [{ port: 8080 }],
        }),
      );
      token = refreshed.authToken['X-aws-proxy-auth'];
      await ddb.send(
        new UpdateItemCommand({
          TableName: cfg.TABLE,
          Key: { sessionId: { S: sessionId } },
          UpdateExpression: 'SET #t = :t, tokenExpiry = :e',
          ExpressionAttributeNames: { '#t': 'token' },
          ExpressionAttributeValues: {
            ':t': { S: token },
            ':e': { N: String(Date.now() + cfg.TOKEN_DURATION_MIN * 60000) },
          },
        }),
      );
    } catch (error) {
      console.error('MicroVM auth token refresh failed', error?.name);
    }
  }

  const host = result.Item.endpoint.S;
  request.origin = {
    custom: {
      domainName: host,
      port: 443,
      protocol: 'https',
      path: '',
      sslProtocols: ['TLSv1.2'],
      readTimeout: 60,
      keepaliveTimeout: 60,
    },
  };
  request.headers.host = [{ key: 'Host', value: host }];
  request.headers['x-aws-proxy-auth'] = [{ key: 'X-aws-proxy-auth', value: token }];
  request.headers.origin = [{ key: 'Origin', value: `https://${host}` }];
  return request;
};

async function startSession() {
  const id = randomUUID();
  // Measured before RunMicrovm, so this is never later than the service-side
  // startedAt + maximumDurationInSeconds that actually terminates the MicroVM.
  const expiresAt = Date.now() + cfg.MAX_DURATION_SEC * 1000;
  const run = await mvm.send(
    new RunMicrovmCommand({
      imageIdentifier: cfg.IMAGE_ARN,
      executionRoleArn: cfg.EXECUTION_ROLE_ARN,
      ingressNetworkConnectors: [cfg.INGRESS],
      egressNetworkConnectors: [cfg.EGRESS],
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: cfg.IDLE_SEC,
        suspendedDurationSeconds: cfg.SUSPENDED_SEC,
      },
      maximumDurationInSeconds: cfg.MAX_DURATION_SEC,
      runHookPayload: JSON.stringify({ sessionId: id, expiresAt }),
    }),
  );

  const tokenResponse = await mvm.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: run.microvmId,
      expirationInMinutes: cfg.TOKEN_DURATION_MIN,
      allowedPorts: [{ port: 8080 }],
    }),
  );
  const token = tokenResponse.authToken['X-aws-proxy-auth'];

  const now = Date.now();
  const ttl = Math.floor(now / 1000) + cfg.MAX_DURATION_SEC + 3600;
  await ddb.send(
    new PutItemCommand({
      TableName: cfg.TABLE,
      Item: {
        sessionId: { S: id },
        microvmId: { S: run.microvmId },
        endpoint: { S: run.endpoint },
        token: { S: token },
        tokenExpiry: { N: String(now + cfg.TOKEN_DURATION_MIN * 60000) },
        createdAt: { N: String(now) },
        paused: { BOOL: false },
        ttl: { N: String(ttl) },
      },
    }),
  );

  return {
    status: '200',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
      'set-cookie': [
        {
          key: 'Set-Cookie',
          value: createMicrovmSessionCookie(id),
        },
      ],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'x-content-type-options': [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
    },
    body: [
      "<!DOCTYPE html><html><head><meta charset='utf-8'>",
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<meta http-equiv="refresh" content="8;url=/">',
      '<title>Starting OMP Cloud IDE...</title>',
      '<style>body{font-family:system-ui;display:flex;flex-direction:column;justify-content:center;',
      'align-items:center;height:100vh;margin:0;background:#1e1e1e;color:#ccc}',
      '.spinner{border:4px solid #333;border-top:4px solid #007acc;border-radius:50%;',
      'width:40px;height:40px;animation:spin 1s linear infinite;margin-bottom:20px}',
      '@keyframes spin{to{transform:rotate(360deg)}}</style></head>',
      "<body><div class='spinner'></div>",
      '<p>Starting your OMP Cloud IDE...</p>',
      "<p style='font-size:0.8em;color:#888'>Usually ready in 5–15 seconds</p>",
      '</body></html>',
    ].join(''),
  };
}

async function handleSessionSelection(request, currentSessionId) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return sessionSelectionResponse({
      sessions: await listAvailableSessions(),
      currentSessionId,
    });
  }
  if (request.method !== 'POST') {
    return methodNotAllowedResponse();
  }

  const form = parseFormBody(request.body);
  if (!form) {
    return sessionSelectionResponse({
      sessions: await listAvailableSessions(),
      currentSessionId,
      errorMessage: 'The session request was invalid or too large.',
      status: '400',
    });
  }

  const action = form.get('action');
  if (action === 'new') {
    return startSession();
  }
  if (action !== 'attach') {
    return sessionSelectionResponse({
      sessions: await listAvailableSessions(),
      currentSessionId,
      errorMessage: 'Choose an existing session or start a new MicroVM.',
      status: '400',
    });
  }

  const selectedSessionId = form.get('sessionId') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(selectedSessionId)) {
    return sessionSelectionResponse({
      sessions: await listAvailableSessions(),
      currentSessionId,
      errorMessage: 'The selected session ID was invalid.',
      status: '400',
    });
  }
  return attachSession(selectedSessionId, currentSessionId);
}

async function listAvailableSessions() {
  const result = await ddb.send(
    new ScanCommand({
      TableName: cfg.TABLE,
      ProjectionExpression: 'sessionId,microvmId,paused,createdAt,#ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      Limit: 25,
    }),
  );

  const sessions = await Promise.all(
    (result.Items ?? []).map(async (item) => {
      const sessionId = item.sessionId?.S;
      const microvmId = item.microvmId?.S;
      if (!sessionId || !microvmId) return null;
      try {
        const microvm = await mvm.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
        if (microvm.state === 'TERMINATED' || microvm.state === 'TERMINATING') return null;
        return {
          sessionId,
          microvmId,
          state: microvm.state ?? 'UNKNOWN',
          imageVersion: microvm.imageVersion ?? '',
          paused: item.paused?.BOOL === true,
          createdAt: Number(item.createdAt?.N ?? 0),
          expiresAt: microvm.startedAt
            ? new Date(microvm.startedAt).getTime() + (microvm.maximumDurationInSeconds ?? cfg.MAX_DURATION_SEC) * 1000
            : 0,
          ttl: Number(item.ttl?.N ?? 0),
        };
      } catch (error) {
        if (error?.name !== 'ResourceNotFoundException') {
          console.error('Could not inspect MicroVM while listing sessions', error?.name);
        }
        return null;
      }
    }),
  );

  return sessions
    .filter(Boolean)
    .sort((left, right) => (right.createdAt || right.ttl * 1000) - (left.createdAt || left.ttl * 1000));
}

async function attachSession(selectedSessionId, currentSessionId) {
  const result = await ddb.send(
    new GetItemCommand({
      TableName: cfg.TABLE,
      Key: { sessionId: { S: selectedSessionId } },
      ConsistentRead: true,
    }),
  );
  if (!result.Item?.microvmId?.S) {
    return sessionSelectionResponse({
      sessions: await listAvailableSessions(),
      currentSessionId,
      errorMessage: 'That session no longer exists. Choose another session or start a new MicroVM.',
      status: '404',
    });
  }

  try {
    const microvmId = result.Item.microvmId.S;
    const state = await getMicrovmState(microvmId);
    if (state === 'TERMINATED' || state === 'TERMINATING') {
      return sessionSelectionResponse({
        sessions: await listAvailableSessions(),
        currentSessionId,
        errorMessage: 'That MicroVM has terminated and cannot be resumed.',
        status: '410',
      });
    }
    if (state === 'SUSPENDING') {
      return sessionSelectionResponse({
        sessions: await listAvailableSessions(),
        currentSessionId,
        errorMessage: 'That MicroVM is still suspending. Wait a few seconds and try again.',
        status: '409',
      });
    }
    if (state === 'SUSPENDED') {
      await mvm.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
    }
    await setSessionPaused(selectedSessionId, false);
    return sessionAttachedResponse(selectedSessionId, state === 'SUSPENDED');
  } catch (error) {
    console.error('Could not attach existing MicroVM session', error?.name);
    return sessionSelectionResponse({
      sessions: await listAvailableSessions(),
      currentSessionId,
      errorMessage: 'Could not connect to that MicroVM. Retry or choose another session.',
      status: '502',
    });
  }
}

async function suspendSession(request, sessionId, item) {
  if (request.method !== 'POST') {
    return postOnlyResponse();
  }

  await setSessionPaused(sessionId, true);
  try {
    const state = await getMicrovmState(item.microvmId.S);
    if (state === 'TERMINATED' || state === 'TERMINATING') {
      await setSessionPaused(sessionId, false);
      return sessionControlResponse({ hasSession: false, clearSessionCookie: true });
    }
    if (state !== 'SUSPENDED' && state !== 'SUSPENDING') {
      await mvm.send(new SuspendMicrovmCommand({ microvmIdentifier: item.microvmId.S }));
    }
    return sessionControlResponse({
      hasSession: true,
      paused: true,
      message: 'Suspend requested. Editor traffic is now blocked until you explicitly resume.',
    });
  } catch (error) {
    await setSessionPaused(sessionId, false);
    console.error('MicroVM suspend failed', error?.name);
    return sessionOperationErrorResponse('Could not suspend the Cloud IDE. Please retry.');
  }
}

async function resumeSession(request, sessionId, item) {
  if (request.method !== 'POST') {
    return postOnlyResponse();
  }

  try {
    const state = await getMicrovmState(item.microvmId.S);
    if (state === 'TERMINATED' || state === 'TERMINATING') {
      await setSessionPaused(sessionId, false);
      return sessionControlResponse({ hasSession: false, clearSessionCookie: true });
    }
    if (state === 'SUSPENDING') {
      return sessionControlResponse({
        hasSession: true,
        paused: true,
        message: 'The Cloud IDE is still suspending. Wait a few seconds, then resume again.',
      });
    }
    if (state === 'SUSPENDED') {
      await mvm.send(new ResumeMicrovmCommand({ microvmIdentifier: item.microvmId.S }));
    }
    await setSessionPaused(sessionId, false);
    return resumingPageResponse();
  } catch (error) {
    console.error('MicroVM resume failed', error?.name);
    return sessionOperationErrorResponse('Could not resume the Cloud IDE. Please retry.');
  }
}

async function getMicrovmState(microvmId) {
  const result = await mvm.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
  return result.state;
}

async function setSessionPaused(sessionId, paused) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: cfg.TABLE,
      Key: { sessionId: { S: sessionId } },
      UpdateExpression: 'SET paused = :paused',
      ExpressionAttributeValues: { ':paused': { BOOL: paused } },
    }),
  );
}

async function isAuthorized(headers) {
  const cookies = parseCookies(headers.cookie);
  if (await isAccessCookieValid(cookies[cfg.ACCESS_COOKIE_NAME])) {
    return true;
  }

  const authorization = headers.authorization?.[0]?.value;
  if (!authorization?.startsWith('Basic ')) {
    return false;
  }

  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) {
    return false;
  }

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const expectedPassword = await getAccessPassword();
  return secureEqual(username, cfg.BASIC_AUTH_USERNAME) && secureEqual(password, expectedPassword);
}

async function handleLogin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return loginPageResponse();
  }
  if (request.method !== 'POST') {
    return methodNotAllowedResponse();
  }

  const form = parseLoginForm(request.body);
  if (!form) {
    return loginPageResponse('The login request was invalid or too large.', '400');
  }

  const expectedPassword = await getAccessPassword();
  if (!secureEqual(form.username, cfg.BASIC_AUTH_USERNAME) || !secureEqual(form.password, expectedPassword)) {
    return loginPageResponse('The username or password was incorrect.', '401');
  }

  const cookie = createAccessCookie(expectedPassword);
  return {
    status: '303',
    statusDescription: 'See Other',
    headers: {
      location: [{ key: 'Location', value: '/session/select' }],
      'set-cookie': [{ key: 'Set-Cookie', value: cookie }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
  };
}

function parseFormBody(body) {
  if (!body?.data || body.inputTruncated) {
    return null;
  }

  try {
    const decoded = body.encoding === 'base64' ? Buffer.from(body.data, 'base64').toString('utf8') : body.data;
    return new URLSearchParams(decoded);
  } catch {
    return null;
  }
}

function parseLoginForm(body) {
  const params = parseFormBody(body);
  if (!params) return null;
  return {
    username: params.get('username') ?? '',
    password: params.get('password') ?? '',
  };
}

function createMicrovmSessionCookie(sessionId) {
  return `mvm-session=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${cfg.MAX_DURATION_SEC}`;
}

function createAccessCookie(password, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + cfg.ACCESS_COOKIE_MAX_AGE_SEC;
  const payload = String(expiresAt);
  const signature = signAccessCookie(payload, password);
  return `${cfg.ACCESS_COOKIE_NAME}=${payload}.${signature}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${cfg.ACCESS_COOKIE_MAX_AGE_SEC}`;
}

async function isAccessCookieValid(value, now = Date.now()) {
  if (!value) {
    return false;
  }
  const expectedPassword = await getAccessPassword();
  return isAccessCookieValidForPassword(value, expectedPassword, now);
}

function isAccessCookieValidForPassword(value, password, now = Date.now()) {
  if (!value) {
    return false;
  }
  const separator = value.indexOf('.');
  if (separator <= 0) {
    return false;
  }
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expiresAt = Number(payload);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) {
    return false;
  }
  // Reject cookies outside the configured lifetime even if their signature is
  // valid, which bounds damage if the shared password is ever disclosed.
  if (expiresAt > nowSeconds + cfg.ACCESS_COOKIE_MAX_AGE_SEC + 60) {
    return false;
  }
  return secureEqual(signature, signAccessCookie(payload, password));
}

function signAccessCookie(payload, password) {
  return createHmac('sha256', password).update(`omp-cloud-ide:${payload}`).digest('base64url');
}

async function getAccessPassword() {
  if (cachedPassword && Date.now() - passwordCachedAt < PASSWORD_CACHE_MS) {
    return cachedPassword;
  }

  const response = await secrets.send(new GetSecretValueCommand({ SecretId: cfg.AUTH_SECRET_ID }));
  if (!response.SecretString) {
    throw new Error('Cloud IDE access password is not a SecretString');
  }
  cachedPassword = response.SecretString;
  passwordCachedAt = Date.now();
  return cachedPassword;
}

function secureEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function loginPageResponse(errorMessage = '', status = '200') {
  const error = errorMessage
    ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>`
    : '<p class="hint">Use the personal Cloud IDE credentials.</p>';
  return {
    status,
    statusDescription: status === '200' ? 'OK' : status === '400' ? 'Bad Request' : 'Unauthorized',
    headers: {
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
      'x-content-type-options': [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
      'content-security-policy': [
        {
          key: 'Content-Security-Policy',
          value:
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      ],
    },
    body: [
      '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>OMP Cloud IDE Login</title>',
      '<style>html{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;',
      'min-height:100vh;margin:0;display:grid;place-items:center}.card{width:min(24rem,calc(100% - 2rem));',
      'background:#1f2937;border:1px solid #374151;border-radius:12px;padding:2rem;box-shadow:0 20px 40px #0006}',
      'h1{font-size:1.35rem;margin:0 0 .5rem}.hint{color:#9ca3af}.error{color:#fca5a5}',
      'label{display:block;margin-top:1rem;font-size:.9rem}input{box-sizing:border-box;width:100%;margin-top:.35rem;',
      'padding:.7rem;border:1px solid #4b5563;border-radius:6px;background:#111827;color:#fff}',
      'button{width:100%;margin-top:1.25rem;padding:.75rem;border:0;border-radius:6px;background:#2563eb;',
      'color:#fff;font-weight:600;cursor:pointer}</style></head><body><main class="card">',
      '<h1>OMP Cloud IDE</h1>',
      error,
      '<form method="post" action="/login" autocomplete="on">',
      `<label>Username<input name="username" autocomplete="username" required value="${escapeHtml(cfg.BASIC_AUTH_USERNAME)}"></label>`,
      '<label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>',
      '<button type="submit">Sign in</button></form></main></body></html>',
    ].join(''),
  };
}

function sessionSelectionResponse({
  sessions,
  currentSessionId = '',
  errorMessage = '',
  status = '200',
  now = Date.now(),
}) {
  const error = errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : '';
  const sessionCards = sessions.length
    ? sessions
        .map((session) => {
          const isCurrent = session.sessionId === currentSessionId;
          const isSuspended = session.state === 'SUSPENDED' || session.paused;
          const actionLabel = isSuspended ? 'Resume and connect' : 'Connect';
          const created = session.createdAt
            ? new Date(session.createdAt).toISOString()
            : 'Created before session history timestamps were enabled';
          const lifetime = session.expiresAt
            ? ` · Ends ${new Date(session.expiresAt).toISOString()} (${formatRemaining(session.expiresAt - now)})`
            : '';
          return [
            `<article class="session${isCurrent ? ' current' : ''}">`,
            '<div class="session-heading">',
            `<strong>${escapeHtml(session.microvmId)}</strong>`,
            `<span class="state ${escapeHtml(String(session.state).toLowerCase())}">${escapeHtml(session.state)}</span>`,
            '</div>',
            `<p>Image ${escapeHtml(session.imageVersion || 'unknown')} · ${escapeHtml(created)}${escapeHtml(lifetime)}</p>`,
            isCurrent ? '<p class="current-label">Currently selected in this browser</p>' : '',
            '<form method="post" action="/session/select">',
            '<input type="hidden" name="action" value="attach">',
            `<input type="hidden" name="sessionId" value="${escapeHtml(session.sessionId)}">`,
            `<button class="primary" type="submit">${actionLabel}</button>`,
            '</form></article>',
          ].join('');
        })
        .join('')
    : '<p class="empty">No resumable MicroVM sessions were found.</p>';

  return {
    status,
    statusDescription: status === '200' ? 'OK' : 'Error',
    headers: {
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
      'x-content-type-options': [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
      'content-security-policy': [
        {
          key: 'Content-Security-Policy',
          value:
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      ],
    },
    body: [
      '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>Choose OMP Cloud IDE Session</title>',
      '<style>html{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;',
      'min-height:100vh;margin:0;padding:2rem;box-sizing:border-box}.shell{width:min(48rem,100%);margin:auto}',
      'h1{font-size:1.55rem;margin:0 0 .5rem}.hint,.session p,.empty{color:#9ca3af;line-height:1.5}',
      '.error{color:#fca5a5;background:#450a0a;border:1px solid #991b1b;border-radius:8px;padding:.75rem}',
      '.sessions{display:grid;gap:1rem;margin:1.5rem 0}.session{background:#1f2937;border:1px solid #374151;',
      'border-radius:12px;padding:1rem}.session.current{border-color:#60a5fa}.session-heading{display:flex;gap:.75rem;',
      'align-items:center;justify-content:space-between;flex-wrap:wrap}strong{font:600 .85rem ui-monospace,monospace}',
      '.state{font-size:.75rem;font-weight:700;padding:.25rem .5rem;border-radius:999px;background:#374151}',
      '.running{color:#86efac}.suspended{color:#fde68a}.current-label{color:#93c5fd!important}',
      'button{box-sizing:border-box;width:100%;padding:.75rem;border:0;border-radius:6px;color:#fff;font-weight:600;',
      'cursor:pointer}.primary{background:#2563eb}.new{background:#374151}.new-session{margin-top:1rem;padding-top:1.5rem;',
      'border-top:1px solid #374151}</style></head><body><main class="shell">',
      '<h1>Choose a Cloud IDE session</h1>',
      '<p class="hint">Reconnect to a running or suspended MicroVM, or start a clean session.</p>',
      error,
      `<section class="sessions">${sessionCards}</section>`,
      '<form class="new-session" method="post" action="/session/select">',
      '<input type="hidden" name="action" value="new">',
      '<button class="new" type="submit">Start a new MicroVM</button></form>',
      '</main></body></html>',
    ].join(''),
  };
}

function sessionControlResponse({
  hasSession,
  paused = false,
  message = '',
  error = false,
  clearSessionCookie = false,
}) {
  let controls;
  if (!hasSession) {
    controls = [
      '<p class="hint">No active Cloud IDE session is associated with this browser.</p>',
      '<a class="button primary" href="/session/select">Choose a session</a>',
    ].join('');
  } else if (paused) {
    controls = [
      `<p class="status paused">${escapeHtml(message || 'The Cloud IDE is paused.')}</p>`,
      '<form method="post" action="/session/resume">',
      '<button class="primary" type="submit">Resume editor</button></form>',
    ].join('');
  } else {
    controls = [
      `<p class="status ${error ? 'error' : 'running'}">${escapeHtml(message || 'The Cloud IDE is running.')}</p>`,
      '<p class="hint">Suspending blocks editor reconnects and stops MicroVM compute charges after the snapshot completes.</p>',
      '<form method="post" action="/session/suspend">',
      '<button class="danger" type="submit">Suspend Cloud IDE</button></form>',
      '<a class="button secondary" href="/">Back to editor</a>',
      '<a class="button secondary" href="/session/select">Switch session</a>',
    ].join('');
  }

  const headers = {
    'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
    'x-content-type-options': [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
    'content-security-policy': [
      {
        key: 'Content-Security-Policy',
        value:
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'",
      },
    ],
  };
  if (clearSessionCookie) {
    headers['set-cookie'] = [{ key: 'Set-Cookie', value: expiredSessionCookie() }];
  }

  return {
    status: '200',
    statusDescription: 'OK',
    headers,
    body: [
      '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>OMP Cloud IDE Control</title>',
      '<style>html{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;',
      'min-height:100vh;margin:0;display:grid;place-items:center}.card{width:min(28rem,calc(100% - 2rem));',
      'background:#1f2937;border:1px solid #374151;border-radius:12px;padding:2rem;box-shadow:0 20px 40px #0006}',
      'h1{font-size:1.35rem;margin:0 0 .75rem}.hint{color:#9ca3af;line-height:1.5}.status{font-weight:600}',
      '.running{color:#86efac}.paused{color:#fde68a}.error{color:#fca5a5}form{margin-top:1.25rem}button,.button{box-sizing:border-box;',
      'display:block;width:100%;padding:.75rem;border:0;border-radius:6px;color:#fff;font-weight:600;cursor:pointer;',
      'text-align:center;text-decoration:none}.primary{background:#2563eb}.danger{background:#b91c1c}.secondary{background:#374151;',
      'margin-top:.75rem}</style></head><body><main class="card"><h1>OMP Cloud IDE Control</h1>',
      controls,
      '</main></body></html>',
    ].join(''),
  };
}

function sessionAttachedResponse(sessionId, resuming) {
  if (resuming) {
    const response = resumingPageResponse();
    response.headers['set-cookie'] = [{ key: 'Set-Cookie', value: createMicrovmSessionCookie(sessionId) }];
    return response;
  }
  return {
    status: '303',
    statusDescription: 'See Other',
    headers: {
      location: [{ key: 'Location', value: '/' }],
      'set-cookie': [{ key: 'Set-Cookie', value: createMicrovmSessionCookie(sessionId) }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
  };
}

function pausedSessionResponse(headers) {
  if (isHtmlNavigation(headers)) {
    return redirectToControl();
  }
  return {
    status: '409',
    statusDescription: 'Conflict',
    headers: {
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      'retry-after': [{ key: 'Retry-After', value: '5' }],
    },
    body: 'Cloud IDE is paused. Open /session/control to resume.',
  };
}

function resumingPageResponse() {
  return {
    status: '200',
    statusDescription: 'OK',
    headers: {
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
      'content-security-policy': [
        {
          key: 'Content-Security-Policy',
          value: "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        },
      ],
    },
    body: [
      '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<meta http-equiv="refresh" content="5;url=/">',
      '<title>Resuming OMP Cloud IDE...</title>',
      '<style>html{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;',
      'min-height:100vh;margin:0;display:grid;place-items:center}</style></head>',
      '<body><p>Resuming the Cloud IDE. The editor will open shortly...</p></body></html>',
    ].join(''),
  };
}

function sessionOperationErrorResponse(message) {
  const response = sessionControlResponse({ hasSession: true, paused: false, message, error: true });
  response.status = '502';
  response.statusDescription = 'Bad Gateway';
  return response;
}

function postOnlyResponse() {
  return {
    status: '405',
    statusDescription: 'Method Not Allowed',
    headers: {
      allow: [{ key: 'Allow', value: 'POST' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    },
    body: 'Method not allowed',
  };
}

function methodNotAllowedResponse() {
  return {
    status: '405',
    statusDescription: 'Method Not Allowed',
    headers: {
      allow: [{ key: 'Allow', value: 'GET, HEAD, POST' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    },
    body: 'Method not allowed',
  };
}

function redirectToLogin() {
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: '/login' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
  };
}

function redirectToControl() {
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: '/session/control' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
  };
}

function isHtmlNavigation(headers) {
  return (headers.accept || []).some((header) => header.value.includes('text/html'));
}

function formatRemaining(ms) {
  if (ms <= 0) return 'lifetime reached';
  const totalMinutes = Math.floor(ms / 60000);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m left`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function redirectToSessionSelect(clearCookie = false) {
  const headers = {
    location: [{ key: 'Location', value: '/session/select' }],
    'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
  };
  if (clearCookie) {
    headers['set-cookie'] = [
      {
        key: 'Set-Cookie',
        value: expiredSessionCookie(),
      },
    ];
  }
  return { status: '302', headers };
}

function expiredSessionCookie() {
  return 'mvm-session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0';
}

function parseCookies(cookieHeader) {
  if (!cookieHeader?.[0]) return {};
  return cookieHeader[0].value.split(';').reduce((accumulator, cookie) => {
    const separator = cookie.indexOf('=');
    if (separator > 0) {
      accumulator[cookie.substring(0, separator).trim()] = cookie.substring(separator + 1).trim();
    }
    return accumulator;
  }, {});
}

exports.__test = {
  createAccessCookie,
  createMicrovmSessionCookie,
  escapeHtml,
  isAccessCookieValidForPassword,
  loginPageResponse,
  pausedSessionResponse,
  parseCookies,
  parseLoginForm,
  postOnlyResponse,
  resumingPageResponse,
  sessionAttachedResponse,
  sessionControlResponse,
  sessionSelectionResponse,
  startSession,
  signAccessCookie,
};
