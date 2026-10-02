const cfg = require('./config.json');

const {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} = require('@aws-sdk/client-lambda-microvms');
const {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { GetParameterCommand, SSMClient } = require('@aws-sdk/client-ssm');
const {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { CognitoJwtVerifier } = require('aws-jwt-verify');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const mvm = new LambdaMicrovmsClient({ region: cfg.MVM_REGION });
const ddb = new DynamoDBClient({ region: cfg.TABLE_REGION });
const ssm = new SSMClient({ region: cfg.COGNITO_REGION });
const cognitoIdp = new CognitoIdentityProviderClient({ region: cfg.COGNITO_REGION });

let cachedCognitoClient;
let cognitoClientCachedAt = 0;
let cachedIdTokenVerifier;
const COGNITO_CLIENT_CACHE_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 32 random bytes as base64url: access cookie values, OAuth state, nonce, PKCE verifier.
const RANDOM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// A start claim that never received a MicroVM (RunMicrovm failed) expires on its own.
const START_CLAIM_TTL_SEC = 15 * 60;
// Edge pages submit forms to themselves; only the sign-out redirect leaves for Cognito.
const FORM_ACTION = `form-action 'self' https://${cfg.COGNITO_DOMAIN}`;
const DEFAULT_IMAGE = cfg.IMAGES[0];

exports.handler = async (event) => {
  const { request, config: distribution } = event.Records[0].cf;
  const siteOrigin = `https://${distribution?.distributionDomainName}`;

  switch (request.uri) {
    case '/auth/login':
      return handleAuthLogin(request, siteOrigin);
    case '/auth/callback':
      return handleAuthCallback(request, siteOrigin);
    case '/auth/logout':
      return handleAuthLogout(request, siteOrigin);
    case '/auth/signed-out':
      // Only a browser without a sign-in cookie is shown as signed out; anyone
      // else is sent through the normal session check.
      return RANDOM_TOKEN_PATTERN.test(parseCookies(request.headers.cookie)[cfg.ACCESS_COOKIE_NAME] ?? '')
        ? redirectTo('/session/select')
        : signedOutResponse();
  }

  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies['mvm-session'];
  const isControlRoute = request.uri === '/session/control';
  const isSuspendRoute = request.uri === '/session/suspend';
  const isResumeRoute = request.uri === '/session/resume';
  const needsSessionRow = Boolean(sessionId) && request.uri !== '/session/select' && request.uri !== '/session/start';

  const { authSession, sessionItem } = await loadRequestState(
    cookies[cfg.ACCESS_COOKIE_NAME],
    needsSessionRow ? sessionId : undefined,
  );
  if (!authSession) {
    return unauthenticatedResponse(request.headers, isControlRoute || isSuspendRoute || isResumeRoute);
  }

  if (request.uri === '/session/select') {
    return handleSessionSelection(request, sessionId, siteOrigin);
  }
  if (request.uri === '/session/start') {
    return redirectToSessionSelect();
  }

  if (!sessionId) {
    if (isControlRoute || isSuspendRoute || isResumeRoute) {
      return sessionControlResponse({ hasSession: false });
    }
    return redirectToSessionSelect();
  }

  if (!sessionItem?.microvmId?.S) {
    if (isControlRoute || isSuspendRoute || isResumeRoute) {
      return sessionControlResponse({ hasSession: false, clearSessionCookie: true });
    }
    return redirectToSessionSelect(true);
  }

  if (sessionItem.terminationPending?.BOOL === true) {
    return terminationResultResponse(sessionItem.microvmId.S, true);
  }
  const paused = sessionItem.paused?.BOOL === true;
  if (isControlRoute) {
    return sessionControlResponse({ hasSession: true, paused, sessionId });
  }
  if (isSuspendRoute) {
    return suspendSession(request, sessionId, sessionItem);
  }
  if (isResumeRoute) {
    return resumeSession(request, sessionId, sessionItem);
  }
  if (paused) {
    return pausedSessionResponse(request.headers);
  }

  let token = sessionItem.token.S;
  const expiry = Number(sessionItem.tokenExpiry.N);
  if (Date.now() > expiry - cfg.TOKEN_REFRESH_THRESHOLD * 60000) {
    try {
      const refreshed = await mvm.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: sessionItem.microvmId.S,
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
      // Within the refresh window the old token still works; once it has
      // expired, forwarding it would only produce an opaque origin 403.
      if (token === sessionItem.token.S && Date.now() >= expiry) {
        return tokenUnavailableResponse(request.headers);
      }
    }
  }

  const host = sessionItem.endpoint.S;
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
  stripEdgeCookies(request.headers);
  return request;
};

async function startSession(requestId, siteOrigin, image = DEFAULT_IMAGE) {
  // The chooser renders a fresh UUID into each "new" form. Using it as the
  // session ID and claiming it before RunMicrovm means a double-submitted form
  // starts one MicroVM, not two.
  const id = UUID_PATTERN.test(requestId ?? '') ? requestId.toLowerCase() : randomUUID();
  const claimedAt = Date.now();
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: cfg.TABLE,
        // No microvmId yet, so the chooser ignores this row until it is filled.
        Item: {
          sessionId: { S: id },
          createdAt: { N: String(claimedAt) },
          ttl: { N: String(Math.floor(claimedAt / 1000) + START_CLAIM_TTL_SEC) },
        },
        ConditionExpression: 'attribute_not_exists(sessionId)',
      }),
    );
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
    return chooserResponse({
      errorMessage:
        'This start request was already submitted and is still starting. Reload in a few seconds to connect.',
      status: '409',
    });
  }

  // Measured before RunMicrovm, so this is never later than the service-side
  // startedAt + maximumDurationInSeconds that actually terminates the MicroVM.
  const expiresAt = Date.now() + cfg.MAX_DURATION_SEC * 1000;
  let run;
  try {
    run = await mvm.send(
      new RunMicrovmCommand({
        imageIdentifier: image.arn,
        executionRoleArn: cfg.EXECUTION_ROLE_ARN,
        ingressNetworkConnectors: [cfg.INGRESS],
        egressNetworkConnectors: [cfg.EGRESS],
        idlePolicy: {
          autoResumeEnabled: true,
          maxIdleDurationSeconds: cfg.IDLE_SEC,
          suspendedDurationSeconds: cfg.SUSPENDED_SEC,
        },
        maximumDurationInSeconds: cfg.MAX_DURATION_SEC,
        // The image is shared by every distribution, so the IDE learns the
        // control page URL from the origin that started it, not from a build-time constant.
        runHookPayload: JSON.stringify({ sessionId: id, expiresAt, controlUrl: `${siteOrigin}/session/control` }),
      }),
    );
  } catch (error) {
    console.error('RunMicrovm failed', error?.name);
    return chooserResponse({ errorMessage: 'Could not start a new MicroVM. Please retry.', status: '502' });
  }

  try {
    await registerSession(id, run);
  } catch (error) {
    // Without a session row the MicroVM would be unreachable from the chooser
    // yet keep running and billing, so undo the start.
    console.error('New MicroVM could not be registered; terminating it', error?.name);
    let terminated = false;
    try {
      await mvm.send(new TerminateMicrovmCommand({ microvmIdentifier: run.microvmId }));
      terminated = true;
    } catch (terminateError) {
      console.error('Compensating TerminateMicrovm failed', terminateError?.name, run.microvmId);
    }
    return chooserResponse({
      errorMessage: terminated
        ? 'The new MicroVM could not be registered, so termination was requested. Please retry.'
        : `The new MicroVM could not be registered and termination failed. Check Untracked MicroVMs for ${run.microvmId}.`,
      status: '502',
    });
  }

  return startingPageResponse(id);
}

async function registerSession(id, run) {
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
}

function startingPageResponse(id) {
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

async function handleSessionSelection(request, currentSessionId, siteOrigin) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return chooserResponse({
      currentSessionId,
    });
  }
  if (request.method !== 'POST') {
    return methodNotAllowedResponse();
  }

  const form = parseFormBody(request.body);
  if (!form) {
    return chooserResponse({
      currentSessionId,
      errorMessage: 'The session request was invalid or too large.',
      status: '400',
    });
  }

  const action = form.get('action');
  if (action === 'new') {
    // Forms rendered before sizes existed carry no size; they get the default.
    const size = form.get('size');
    const image = size === null ? DEFAULT_IMAGE : cfg.IMAGES.find((candidate) => candidate.id === size);
    if (!image) {
      return chooserResponse({ currentSessionId, errorMessage: 'Choose one of the listed sizes.', status: '400' });
    }
    return startSession(form.get('requestId'), siteOrigin, image);
  }
  if (action === 'terminate-confirm' || action === 'terminate') {
    return handleTermination(form, currentSessionId, action === 'terminate');
  }
  if (action !== 'attach') {
    return chooserResponse({
      currentSessionId,
      errorMessage: 'Choose an existing session or start a new MicroVM.',
      status: '400',
    });
  }

  const selectedSessionId = form.get('sessionId') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(selectedSessionId)) {
    return chooserResponse({
      currentSessionId,
      errorMessage: 'The selected session ID was invalid.',
      status: '400',
    });
  }
  return attachSession(selectedSessionId, currentSessionId);
}

async function chooserResponse(options) {
  const { sessions, trackedMicrovmIds } = await listAvailableSessions();
  const untracked = await listUntrackedMicrovms(trackedMicrovmIds);
  return sessionSelectionResponse({ ...options, sessions, untracked });
}

async function listAvailableSessions() {
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: cfg.TABLE,
        ProjectionExpression: 'sessionId,microvmId,paused,terminationPending,createdAt,#ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        Limit: 25,
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  const sessions = await Promise.all(
    items.map(async (item) => {
      const sessionId = item.sessionId?.S;
      const microvmId = item.microvmId?.S;
      if (!sessionId || !microvmId) return null;
      try {
        const microvm = await mvm.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
        if (microvm.state === 'TERMINATED') {
          await deleteSessionRecord(sessionId, microvmId);
          return null;
        }
        if (microvm.state === 'TERMINATING') return null;
        return {
          sessionId,
          microvmId,
          state: microvm.state ?? 'UNKNOWN',
          imageVersion: microvm.imageVersion ?? '',
          sizeLabel: cfg.IMAGES.find((image) => image.arn === microvm.imageArn)?.label ?? '',
          paused: item.paused?.BOOL === true,
          terminationPending: item.terminationPending?.BOOL === true,
          createdAt: Number(item.createdAt?.N ?? 0),
          expiresAt: microvm.startedAt
            ? new Date(microvm.startedAt).getTime() + (microvm.maximumDurationInSeconds ?? cfg.MAX_DURATION_SEC) * 1000
            : 0,
          ttl: Number(item.ttl?.N ?? 0),
        };
      } catch (error) {
        if (error?.name === 'ResourceNotFoundException') {
          await deleteSessionRecord(sessionId, microvmId);
          return null;
        }
        console.error('Could not inspect MicroVM while listing sessions', error?.name);
        return null;
      }
    }),
  );

  return {
    sessions: sessions
      .filter(Boolean)
      .sort((left, right) => (right.createdAt || right.ttl * 1000) - (left.createdAt || left.ttl * 1000)),
    trackedMicrovmIds: new Set(items.map((item) => item.microvmId?.S).filter(Boolean)),
  };
}

/**
 * Live MicroVMs of these images with no session row: typically a start whose
 * registration failed and whose compensating terminate also failed. They are
 * unreachable through the proxy but keep billing, so the chooser shows them.
 */
async function listUntrackedMicrovms(trackedMicrovmIds) {
  const untracked = [];
  try {
    for (const image of cfg.IMAGES) {
      let nextToken;
      do {
        const result = await mvm.send(
          new ListMicrovmsCommand({ imageIdentifier: image.arn, maxResults: 50, nextToken }),
        );
        untracked.push(
          ...(result.items ?? [])
            .filter((item) => item.microvmId && item.imageArn === image.arn)
            .filter((item) => item.state !== 'TERMINATED' && item.state !== 'TERMINATING')
            .filter((item) => !trackedMicrovmIds.has(item.microvmId))
            .map((item) => ({
              microvmId: item.microvmId,
              state: item.state ?? 'UNKNOWN',
              startedAt: item.startedAt ? new Date(item.startedAt).getTime() : 0,
            })),
        );
        nextToken = result.nextToken;
      } while (nextToken);
    }
  } catch (error) {
    // Reconciliation must never hide the chooser itself.
    console.error('Could not list MicroVMs for reconciliation', error?.name);
  }
  return untracked;
}

async function deleteSessionRecord(sessionId, microvmId) {
  try {
    await ddb.send(
      new DeleteItemCommand({
        TableName: cfg.TABLE,
        Key: { sessionId: { S: sessionId } },
        ConditionExpression: 'microvmId = :id',
        ExpressionAttributeValues: { ':id': { S: microvmId } },
      }),
    );
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
  }
}

async function handleTermination(form, currentSessionId, confirmed) {
  const sessionId = form.get('sessionId') ?? '';
  const requestedMicrovmId = form.get('microvmId') ?? '';
  if (!UUID_PATTERN.test(sessionId)) {
    return chooserResponse({ currentSessionId, errorMessage: 'The session ID was invalid.', status: '400' });
  }

  try {
    const row = await ddb.send(
      new GetItemCommand({
        TableName: cfg.TABLE,
        Key: { sessionId: { S: sessionId } },
        ConsistentRead: true,
      }),
    );
    if (!row.Item?.microvmId?.S || (requestedMicrovmId && row.Item.microvmId.S !== requestedMicrovmId)) {
      return chooserResponse({ currentSessionId, errorMessage: 'The selected session has changed.', status: '409' });
    }
    const microvmId = row.Item.microvmId.S;

    const microvm = await mvm.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
    if (!cfg.IMAGES.some((image) => image.arn === microvm.imageArn) || microvm.microvmId !== microvmId) {
      return chooserResponse({
        currentSessionId,
        errorMessage: 'The MicroVM does not belong to this IDE.',
        status: '403',
      });
    }
    if (microvm.state === 'TERMINATED' || microvm.state === 'TERMINATING') {
      if (microvm.state === 'TERMINATED') await deleteSessionRecord(sessionId, microvmId);
      return chooserResponse({
        currentSessionId,
        errorMessage: 'This MicroVM is already terminating or terminated.',
        status: '409',
      });
    }
    if (!confirmed) return terminationConfirmationResponse(sessionId, microvmId, microvm.state);
    if (form.get('confirmation') !== microvmId || requestedMicrovmId !== microvmId) {
      return terminationConfirmationResponse(
        sessionId,
        microvmId,
        microvm.state,
        'Type the exact MicroVM ID to confirm.',
      );
    }
    // The API can time out after accepting termination. Keep this session
    // blocked until a terminal state is observed, even on an ambiguous error.
    await ddb.send(
      new UpdateItemCommand({
        TableName: cfg.TABLE,
        Key: { sessionId: { S: sessionId } },
        UpdateExpression: 'SET paused = :blocked, terminationPending = :blocked',
        ConditionExpression: 'microvmId = :id',
        ExpressionAttributeValues: { ':blocked': { BOOL: true }, ':id': { S: microvmId } },
      }),
    );
    let terminateError;
    try {
      await mvm.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    } catch (error) {
      terminateError = error;
      console.error('TerminateMicrovm outcome uncertain', error?.name, microvmId);
    }
    let state;
    try {
      state = await getMicrovmState(microvmId);
    } catch (error) {
      if (error?.name === 'ResourceNotFoundException') state = 'TERMINATED';
      else console.error('Could not verify MicroVM termination yet', error?.name);
    }
    if (state === 'TERMINATED') await deleteSessionRecord(sessionId, microvmId);
    const uncertain = Boolean(terminateError && state !== 'TERMINATED' && state !== 'TERMINATING');
    const response = terminationResultResponse(microvmId, uncertain);
    if (uncertain) {
      response.status = '502';
      response.statusDescription = 'Bad Gateway';
    } else if (sessionId === currentSessionId) {
      response.headers['set-cookie'] = [{ key: 'Set-Cookie', value: expiredSessionCookie() }];
    }
    return response;
  } catch (error) {
    console.error('Could not terminate MicroVM', error?.name);
    return chooserResponse({
      currentSessionId,
      errorMessage: 'Could not confirm termination. Check the session state and retry if it is still running.',
      status: '502',
    });
  }
}

function terminationConfirmationResponse(sessionId, microvmId, state, errorMessage = '') {
  return sessionControlResponse({
    hasSession: false,
    customControls: [
      '<p class="status error">Terminating permanently destroys this MicroVM. Commit and push your work first.</p>',
      `<p>MicroVM: <strong>${escapeHtml(microvmId)}</strong> (${escapeHtml(state)})</p>`,
      errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : '',
      '<form method="post" action="/session/select">',
      '<input type="hidden" name="action" value="terminate">',
      `<input type="hidden" name="sessionId" value="${escapeHtml(sessionId)}">`,
      `<input type="hidden" name="microvmId" value="${escapeHtml(microvmId)}">`,
      '<label>Type the MicroVM ID to confirm<input name="confirmation" required autocomplete="off"></label>',
      '<button class="danger" type="submit">Permanently terminate MicroVM</button></form>',
      '<a class="button secondary" href="/session/select">Cancel</a>',
    ].join(''),
  });
}

function terminationResultResponse(microvmId, uncertain = false) {
  return sessionControlResponse({
    hasSession: false,
    customControls: [
      `<p>${uncertain ? 'Termination outcome is unknown' : 'Termination requested'} for ${escapeHtml(microvmId)}.</p>`,
      '<p class="hint">Editor traffic is blocked until this MicroVM reaches TERMINATED. If it remains running, retry from the chooser.</p>',
      '<a class="button primary" href="/session/select">Check sessions</a>',
    ].join(''),
  });
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
    return chooserResponse({
      currentSessionId,
      errorMessage: 'That session no longer exists. Choose another session or start a new MicroVM.',
      status: '404',
    });
  }

  if (result.Item.terminationPending?.BOOL === true) {
    return chooserResponse({
      currentSessionId,
      errorMessage: 'Termination is pending for that MicroVM. Wait or retry termination.',
      status: '409',
    });
  }
  try {
    const microvmId = result.Item.microvmId.S;
    const state = await getMicrovmState(microvmId);
    if (state === 'TERMINATED' || state === 'TERMINATING') {
      return chooserResponse({
        currentSessionId,
        errorMessage: 'That MicroVM has terminated and cannot be resumed.',
        status: '410',
      });
    }
    if (state === 'SUSPENDING') {
      return chooserResponse({
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
    return chooserResponse({
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

async function setSessionPaused(sessionId, paused, microvmId) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: cfg.TABLE,
      Key: { sessionId: { S: sessionId } },
      UpdateExpression: 'SET paused = :paused',
      ConditionExpression: microvmId ? 'microvmId = :id' : undefined,
      ExpressionAttributeValues: {
        ':paused': { BOOL: paused },
        ...(microvmId ? { ':id': { S: microvmId } } : {}),
      },
    }),
  );
}

/**
 * Reads the browser's auth session and, when the route needs it, its MicroVM
 * session row. Both GetItems run concurrently so authentication adds no extra
 * round trip to the per-request DynamoDB read the proxy path already made.
 */
async function loadRequestState(accessCookie, sessionId) {
  if (!RANDOM_TOKEN_PATTERN.test(accessCookie ?? '')) {
    return { authSession: null, sessionItem: undefined };
  }
  const [auth, session] = await Promise.all([
    ddb.send(
      new GetItemCommand({
        TableName: cfg.AUTH_TABLE,
        Key: { id: { S: authSessionKey(accessCookie) } },
        // The row is written just before the post-login redirect.
        ConsistentRead: true,
      }),
    ),
    sessionId
      ? ddb.send(
          new GetItemCommand({
            TableName: cfg.TABLE,
            Key: { sessionId: { S: sessionId } },
            ConsistentRead: true,
          }),
        )
      : undefined,
  ]);
  // DynamoDB TTL deletes lazily, so an expired row must be rejected here.
  const expiresAt = Number(auth.Item?.expiresAt?.N ?? 0);
  const authSession = expiresAt > Date.now() ? { sub: auth.Item.sub?.S ?? '' } : null;
  return { authSession, sessionItem: session?.Item };
}

function authSessionKey(accessCookie) {
  return `sess#${createHash('sha256').update(accessCookie).digest('base64url')}`;
}

function randomToken() {
  return randomBytes(32).toString('base64url');
}

async function handleAuthLogin(request, siteOrigin) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowedResponse('GET, HEAD');
  }
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  let client;
  try {
    client = await getCognitoClient();
    const now = Date.now();
    await ddb.send(
      new PutItemCommand({
        TableName: cfg.AUTH_TABLE,
        Item: {
          id: { S: `login#${state}` },
          nonce: { S: nonce },
          verifier: { S: verifier },
          expiresAt: { N: String(now + cfg.LOGIN_TTL_SEC * 1000) },
          ttl: { N: String(Math.ceil(now / 1000) + cfg.LOGIN_TTL_SEC) },
        },
      }),
    );
  } catch (error) {
    console.error('Could not start Cognito sign-in', error?.name);
    return authPageResponse({ status: '502', title: 'Sign-in unavailable', message: 'Please retry in a moment.' });
  }
  const authorize = new URL(`https://${cfg.COGNITO_DOMAIN}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: `${siteOrigin}/auth/callback`,
    scope: 'openid email',
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: authorize.toString() }],
      // Lax, not Strict: the callback is a top-level navigation from Cognito's site.
      'set-cookie': [
        {
          key: 'Set-Cookie',
          value: `${cfg.OAUTH_COOKIE_NAME}=${state}; Path=/auth/callback; Secure; HttpOnly; SameSite=Lax; Max-Age=${cfg.LOGIN_TTL_SEC}`,
        },
      ],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
  };
}

async function handleAuthCallback(request, siteOrigin) {
  if (request.method !== 'GET') {
    return methodNotAllowedResponse('GET');
  }
  const params = new URLSearchParams(request.querystring ?? '');
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  const cookieState = parseCookies(request.headers.cookie)[cfg.OAUTH_COOKIE_NAME] ?? '';
  if (params.has('error')) {
    return authFailureResponse('400', 'Sign-in was cancelled or rejected by Cognito.');
  }
  // The state must match the cookie set by /auth/login in this same browser.
  if (!RANDOM_TOKEN_PATTERN.test(state) || !code || !secureEqual(state, cookieState)) {
    return authFailureResponse('400', 'This sign-in did not start in this browser or has expired.');
  }

  let pending;
  try {
    // Deleting with ALL_OLD makes each state usable exactly once.
    const deleted = await ddb.send(
      new DeleteItemCommand({
        TableName: cfg.AUTH_TABLE,
        Key: { id: { S: `login#${state}` } },
        ConditionExpression: 'attribute_exists(id)',
        ReturnValues: 'ALL_OLD',
      }),
    );
    pending = deleted.Attributes;
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
  }
  if (!pending?.verifier?.S || !pending.nonce?.S || Number(pending.expiresAt?.N ?? 0) <= Date.now()) {
    return authFailureResponse('400', 'This sign-in did not start in this browser or has expired.');
  }

  let claims;
  try {
    const client = await getCognitoClient();
    const tokens = await exchangeAuthorizationCode(client, code, pending.verifier.S, `${siteOrigin}/auth/callback`);
    claims = await getIdTokenVerifier(client).verify(tokens.id_token);
  } catch (error) {
    console.error('Cognito sign-in could not be completed', error?.name, error?.message);
    return authFailureResponse('502', 'Sign-in could not be completed.');
  }
  if (typeof claims.nonce !== 'string' || !secureEqual(claims.nonce, pending.nonce.S)) {
    return authFailureResponse('401', 'The identity token did not belong to this sign-in.');
  }

  const accessCookie = randomToken();
  const now = Date.now();
  const expiresAt = now + cfg.ACCESS_COOKIE_MAX_AGE_SEC * 1000;
  await ddb.send(
    new PutItemCommand({
      TableName: cfg.AUTH_TABLE,
      Item: {
        id: { S: authSessionKey(accessCookie) },
        sub: { S: claims.sub },
        createdAt: { N: String(now) },
        expiresAt: { N: String(expiresAt) },
        ttl: { N: String(Math.ceil(expiresAt / 1000)) },
      },
      ConditionExpression: 'attribute_not_exists(id)',
    }),
  );
  return signedInResponse(accessCookie);
}

async function exchangeAuthorizationCode(client, code, verifier, redirectUri) {
  const response = await fetch(`https://${cfg.COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Token endpoint returned ${response.status}`), { name: 'TokenExchangeError' });
  }
  const tokens = await response.json();
  if (typeof tokens?.id_token !== 'string') {
    throw Object.assign(new Error('Token response had no id_token'), { name: 'TokenExchangeError' });
  }
  return tokens;
}

async function handleAuthLogout(request, siteOrigin) {
  if (request.method !== 'POST') {
    return postOnlyResponse();
  }
  const accessCookie = parseCookies(request.headers.cookie)[cfg.ACCESS_COOKIE_NAME] ?? '';
  // SameSite=Strict keeps the cookie off cross-site POSTs, so a forged logout
  // arrives without it and changes nothing.
  if (!RANDOM_TOKEN_PATTERN.test(accessCookie)) {
    return redirectTo('/auth/signed-out', '303');
  }
  await ddb.send(
    new DeleteItemCommand({ TableName: cfg.AUTH_TABLE, Key: { id: { S: authSessionKey(accessCookie) } } }),
  );
  let response;
  try {
    const client = await getCognitoClient();
    // Also end the Managed Login session so the next sign-in asks for credentials.
    const logout = new URL(`https://${cfg.COGNITO_DOMAIN}/logout`);
    logout.search = new URLSearchParams({
      client_id: client.clientId,
      logout_uri: `${siteOrigin}/auth/signed-out`,
    }).toString();
    response = redirectTo(logout.toString(), '303');
  } catch (error) {
    console.error('Could not resolve the Cognito logout endpoint', error?.name);
    // The Cloud IDE session is gone, but Managed Login may still sign the
    // browser back in without credentials; say so instead of claiming success.
    response = authPageResponse({
      status: '502',
      title: 'Sign-out incomplete',
      message:
        'You are signed out of the Cloud IDE, but the Cognito sign-in session could not be ended. Sign in and sign out again to end it.',
    });
  }
  response.headers['set-cookie'] = [{ key: 'Set-Cookie', value: expiredAccessCookie() }];
  return response;
}

async function getCognitoClient() {
  if (cachedCognitoClient && Date.now() - cognitoClientCachedAt < COGNITO_CLIENT_CACHE_MS) {
    return cachedCognitoClient;
  }
  const parameter = await ssm.send(new GetParameterCommand({ Name: cfg.COGNITO_PARAMETER_NAME }));
  const { userPoolId, clientId } = JSON.parse(parameter.Parameter?.Value ?? '{}');
  if (!userPoolId || !clientId) {
    throw new Error('Cognito parameter is missing userPoolId or clientId');
  }
  const described = await cognitoIdp.send(
    new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
  );
  const clientSecret = described.UserPoolClient?.ClientSecret;
  if (!clientSecret) {
    throw new Error('Cognito app client has no secret');
  }
  cachedCognitoClient = { userPoolId, clientId, clientSecret };
  cognitoClientCachedAt = Date.now();
  return cachedCognitoClient;
}

/** One verifier per pool/client, so its JWKS cache survives across requests. */
function getIdTokenVerifier({ userPoolId, clientId }) {
  if (cachedIdTokenVerifier?.userPoolId !== userPoolId || cachedIdTokenVerifier.clientId !== clientId) {
    cachedIdTokenVerifier = {
      userPoolId,
      clientId,
      verifier: CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' }),
    };
  }
  return cachedIdTokenVerifier.verifier;
}

function unauthenticatedResponse(headers, framedRoute) {
  if (framedRoute) {
    // The control page runs inside the editor; Cognito refuses to be framed,
    // so sign-in must replace the whole tab.
    const response = sessionControlResponse({
      hasSession: false,
      customControls: [
        '<p class="status error">Your Cloud IDE sign-in has expired.</p>',
        '<a class="button primary" href="/auth/login" target="_top">Sign in again</a>',
      ].join(''),
    });
    response.status = '401';
    response.statusDescription = 'Unauthorized';
    return response;
  }
  if (isHtmlNavigation(headers)) {
    return redirectTo('/auth/login');
  }
  return {
    status: '401',
    statusDescription: 'Unauthorized',
    headers: {
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    },
    body: 'Sign in to the Cloud IDE at /auth/login.',
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

function createMicrovmSessionCookie(sessionId) {
  return `mvm-session=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${cfg.MAX_DURATION_SEC}`;
}

function createAccessCookie(value) {
  return `${cfg.ACCESS_COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${cfg.ACCESS_COOKIE_MAX_AGE_SEC}`;
}

function expiredAccessCookie() {
  return `${cfg.ACCESS_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function expiredOauthCookie() {
  return `${cfg.OAUTH_COOKIE_NAME}=; Path=/auth/callback; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function secureEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * Completes sign-in with a same-site navigation. A 302 would continue the
 * redirect chain that Cognito started cross-site, and browsers withhold
 * SameSite=Strict cookies from such a chain, looping back to sign-in.
 */
function signedInResponse(accessCookie) {
  const response = authPageResponse({
    title: 'Signed in',
    message: 'Opening the Cloud IDE session chooser...',
    refreshTo: '/session/select',
  });
  response.headers['set-cookie'] = [
    { key: 'Set-Cookie', value: createAccessCookie(accessCookie) },
    { key: 'Set-Cookie', value: expiredOauthCookie() },
  ];
  return response;
}

function authFailureResponse(status, message) {
  const response = authPageResponse({ status, title: 'Sign-in failed', message });
  response.headers['set-cookie'] = [{ key: 'Set-Cookie', value: expiredOauthCookie() }];
  return response;
}

function signedOutResponse() {
  return authPageResponse({ title: 'Signed out', message: 'You have signed out of the Cloud IDE.' });
}

function authPageResponse({ status = '200', title, message, refreshTo = '' }) {
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
          value: "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        },
      ],
    },
    body: [
      '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      refreshTo ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(refreshTo)}">` : '',
      `<title>${escapeHtml(title)} - OMP Cloud IDE</title>`,
      '<style>html{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;',
      'min-height:100vh;margin:0;display:grid;place-items:center}.card{width:min(24rem,calc(100% - 2rem));',
      'background:#1f2937;border:1px solid #374151;border-radius:12px;padding:2rem;box-shadow:0 20px 40px #0006}',
      'h1{font-size:1.35rem;margin:0 0 .5rem}p{color:#9ca3af;line-height:1.5}a{display:block;margin-top:1.25rem;',
      'padding:.75rem;border-radius:6px;background:#2563eb;color:#fff;font-weight:600;text-align:center;',
      'text-decoration:none}</style></head><body><main class="card">',
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
      refreshTo ? '' : '<a href="/auth/login">Sign in</a>',
      '</main></body></html>',
    ].join(''),
  };
}

function signOutForm() {
  // target=_top: the control page is framed, and Cognito's logout page refuses framing.
  return [
    '<form method="post" action="/auth/logout" target="_top">',
    '<button class="signout" type="submit">Sign out</button></form>',
  ].join('');
}

function sessionSelectionResponse({
  sessions,
  untracked = [],
  currentSessionId = '',
  errorMessage = '',
  status = '200',
  now = Date.now(),
  requestId = randomUUID(),
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
            `<p>${escapeHtml(session.sizeLabel || 'Unknown size')} · Image ${escapeHtml(session.imageVersion || 'unknown')} · ${escapeHtml(created)}${escapeHtml(lifetime)}</p>`,
            isCurrent ? '<p class="current-label">Currently selected in this browser</p>' : '',
            session.terminationPending
              ? '<p class="current-label">Termination pending; do not reconnect.</p>'
              : [
                  '<form method="post" action="/session/select">',
                  '<input type="hidden" name="action" value="attach">',
                  `<input type="hidden" name="sessionId" value="${escapeHtml(session.sessionId)}">`,
                  `<button class="primary" type="submit">${actionLabel}</button>`,
                  '</form>',
                ].join(''),
            '<form method="post" action="/session/select">',
            '<input type="hidden" name="action" value="terminate-confirm">',
            `<input type="hidden" name="sessionId" value="${escapeHtml(session.sessionId)}">`,
            '<button class="danger" type="submit">Terminate permanently...</button>',
            '</form></article>',
          ].join('');
        })
        .join('')
    : '<p class="empty">No resumable MicroVM sessions were found.</p>';
  const untrackedSection = untracked.length
    ? [
        '<section class="untracked"><h2>Untracked MicroVMs</h2>',
        '<p class="hint">These MicroVMs have no session record. A recently started MicroVM may appear briefly. ',
        'If one remains running after a failed start, verify its ID and terminate it using the AWS API or Console.</p>',
        ...untracked.map((microvm) =>
          [
            '<article class="session">',
            '<div class="session-heading">',
            `<strong>${escapeHtml(microvm.microvmId)}</strong>`,
            `<span class="state ${escapeHtml(String(microvm.state).toLowerCase())}">${escapeHtml(microvm.state)}</span>`,
            '</div>',
            `<p>Started ${escapeHtml(microvm.startedAt ? new Date(microvm.startedAt).toISOString() : 'unknown')}</p>`,
            '</article>',
          ].join(''),
        ),
        '</section>',
      ].join('')
    : '';

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
          value: `default-src 'none'; style-src 'unsafe-inline'; ${FORM_ACTION}; base-uri 'none'; frame-ancestors 'none'`,
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
      'border-top:1px solid #374151}h2{font-size:1.1rem;margin:2rem 0 .25rem}.untracked .session{border-color:#92400e}',
      '.session form+form{margin-top:.5rem}.danger{background:#991b1b}',
      '.signout{margin-top:1rem;background:transparent;border:1px solid #4b5563;color:#d1d5db}',
      '.sizes{border:1px solid #374151;border-radius:8px;margin:0 0 1rem;padding:.75rem 1rem}',
      '.sizes label{display:flex;gap:.5rem;align-items:center;padding:.25rem 0;color:#d1d5db}',
      '</style></head><body><main class="shell">',
      '<h1>Choose a Cloud IDE session</h1>',
      '<p class="hint">Reconnect to a running or suspended MicroVM, or start a clean session.</p>',
      error,
      `<section class="sessions">${sessionCards}</section>`,
      '<form class="new-session" method="post" action="/session/select">',
      '<input type="hidden" name="action" value="new">',
      `<input type="hidden" name="requestId" value="${escapeHtml(requestId)}">`,
      '<fieldset class="sizes"><legend>MicroVM size</legend>',
      ...cfg.IMAGES.map((image) =>
        [
          `<label><input type="radio" name="size" value="${escapeHtml(image.id)}"`,
          image === DEFAULT_IMAGE ? ' checked' : '',
          ` required>${escapeHtml(image.label)}</label>`,
        ].join(''),
      ),
      '</fieldset>',
      '<button class="new" type="submit">Start a new MicroVM</button></form>',
      untrackedSection,
      signOutForm(),
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
  sessionId = '',
  customControls = null,
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

  if (sessionId && hasSession) {
    controls += [
      '<form method="post" action="/session/select">',
      '<input type="hidden" name="action" value="terminate-confirm">',
      `<input type="hidden" name="sessionId" value="${escapeHtml(sessionId)}">`,
      '<button class="danger" type="submit">Terminate permanently...</button></form>',
    ].join('');
  }
  controls += signOutForm();
  if (customControls !== null) controls = customControls;

  const headers = {
    'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
    'x-content-type-options': [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
    'content-security-policy': [
      {
        key: 'Content-Security-Policy',
        value: `default-src 'none'; style-src 'unsafe-inline'; ${FORM_ACTION}; base-uri 'none'; frame-ancestors 'self'`,
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
      'margin-top:.75rem}.signout{background:transparent;border:1px solid #4b5563;color:#d1d5db}',
      '</style></head><body><main class="card"><h1>OMP Cloud IDE Control</h1>',
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

function tokenUnavailableResponse(headers) {
  const message = 'Could not renew access to the MicroVM. Reload to retry.';
  if (isHtmlNavigation(headers)) {
    const response = sessionControlResponse({ hasSession: true, paused: false, message, error: true });
    response.status = '503';
    response.statusDescription = 'Service Unavailable';
    response.headers['retry-after'] = [{ key: 'Retry-After', value: '5' }];
    return response;
  }
  return {
    status: '503',
    statusDescription: 'Service Unavailable',
    headers: {
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      'retry-after': [{ key: 'Retry-After', value: '5' }],
    },
    body: message,
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

function methodNotAllowedResponse(allow = 'GET, HEAD, POST') {
  return {
    status: '405',
    statusDescription: 'Method Not Allowed',
    headers: {
      allow: [{ key: 'Allow', value: allow }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    },
    body: 'Method not allowed',
  };
}

function redirectTo(location, status = '302') {
  return {
    status,
    statusDescription: status === '303' ? 'See Other' : 'Found',
    headers: {
      location: [{ key: 'Location', value: location }],
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

function stripEdgeCookies(headers) {
  if (!headers.cookie) return;
  const forwarded = headers.cookie
    .map((header) => ({
      key: header.key,
      value: header.value
        .split(';')
        .map((part) => part.trim())
        .filter((part) => {
          const separator = part.indexOf('=');
          const name = separator < 0 ? '' : part.slice(0, separator).trim();
          return name !== cfg.ACCESS_COOKIE_NAME && name !== cfg.OAUTH_COOKIE_NAME && name !== 'mvm-session';
        })
        .join('; '),
    }))
    .filter((header) => header.value);
  if (forwarded.length) headers.cookie = forwarded;
  else delete headers.cookie;
}

function parseCookies(cookieHeaders) {
  const cookies = {};
  for (const header of cookieHeaders ?? []) {
    for (const cookie of header.value.split(';')) {
      const separator = cookie.indexOf('=');
      if (separator > 0) {
        cookies[cookie.substring(0, separator).trim()] = cookie.substring(separator + 1).trim();
      }
    }
  }
  return cookies;
}

exports.__test = {
  authSessionKey,
  createMicrovmSessionCookie,
  escapeHtml,
  getIdTokenVerifier,
  pausedSessionResponse,
  parseCookies,
  postOnlyResponse,
  resumingPageResponse,
  sessionAttachedResponse,
  sessionControlResponse,
  sessionSelectionResponse,
  startSession,
};
