const cfg = require('./config.json');

const {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
} = require('@aws-sdk/client-lambda-microvms');
const { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { GetSecretValueCommand, SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const { randomUUID, timingSafeEqual } = require('node:crypto');

const mvm = new LambdaMicrovmsClient({ region: cfg.MVM_REGION });
const ddb = new DynamoDBClient({ region: cfg.TABLE_REGION });
const secrets = new SecretsManagerClient({ region: cfg.AUTH_SECRET_REGION });

let cachedPassword;
let passwordCachedAt = 0;
const PASSWORD_CACHE_MS = 5 * 60 * 1000;

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;

  if (!(await isAuthorized(request.headers))) {
    return unauthorizedResponse();
  }
  delete request.headers.authorization;

  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies['mvm-session'];

  if (request.uri === '/session/start') {
    return startSession();
  }

  if (!sessionId) {
    return redirectToStart();
  }

  const result = await ddb.send(
    new GetItemCommand({
      TableName: cfg.TABLE,
      Key: { sessionId: { S: sessionId } },
    }),
  );
  if (!result.Item) {
    return redirectToStart(true);
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
      runHookPayload: JSON.stringify({ sessionId: id }),
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
          value: `mvm-session=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${cfg.MAX_DURATION_SEC}`,
        },
      ],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'x-content-type-options': [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
    },
    body: [
      "<!DOCTYPE html><html><head><meta charset='utf-8'>",
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>Starting OMP Cloud IDE...</title>',
      '<style>body{font-family:system-ui;display:flex;flex-direction:column;justify-content:center;',
      'align-items:center;height:100vh;margin:0;background:#1e1e1e;color:#ccc}',
      '.spinner{border:4px solid #333;border-top:4px solid #007acc;border-radius:50%;',
      'width:40px;height:40px;animation:spin 1s linear infinite;margin-bottom:20px}',
      '@keyframes spin{to{transform:rotate(360deg)}}</style></head>',
      "<body><div class='spinner'></div>",
      '<p>Starting your OMP Cloud IDE...</p>',
      "<p style='font-size:0.8em;color:#888'>Usually ready in 5–15 seconds</p>",
      "<script>setTimeout(()=>location.href='/',8000)</script>",
      '</body></html>',
    ].join(''),
  };
}

async function isAuthorized(headers) {
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

function unauthorizedResponse() {
  return {
    status: '401',
    statusDescription: 'Unauthorized',
    headers: {
      'www-authenticate': [{ key: 'WWW-Authenticate', value: 'Basic realm="OMP Cloud IDE", charset="UTF-8"' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      'x-content-type-options': [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
    },
    body: 'Authentication required',
  };
}

function redirectToStart(clearCookie = false) {
  const headers = {
    location: [{ key: 'Location', value: '/session/start' }],
    'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
  };
  if (clearCookie) {
    headers['set-cookie'] = [
      {
        key: 'Set-Cookie',
        value: 'mvm-session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0',
      },
    ];
  }
  return { status: '302', headers };
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
