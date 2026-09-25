import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { OmpCloudIdeEdgeStack, OmpCloudIdeMicrovmStack } from '../lib/lambda-microvm-stack';

type EdgeTestHelpers = {
  createAccessCookie: (password: string, now?: number) => string;
  createMicrovmSessionCookie: (sessionId: string) => string;
  isAccessCookieValidForPassword: (value: string, password: string, now?: number) => boolean;
  loginPageResponse: (
    errorMessage?: string,
    status?: string,
  ) => {
    status: string;
    headers: Record<string, Array<{ key: string; value: string }>>;
    body: string;
  };
  parseLoginForm: (body: { data: string; encoding: string; inputTruncated?: boolean }) => {
    username: string;
    password: string;
  } | null;
  pausedSessionResponse: (headers: Record<string, Array<{ key: string; value: string }>>) => {
    status: string;
    headers: Record<string, Array<{ key: string; value: string }>>;
    body?: string;
  };
  postOnlyResponse: () => {
    status: string;
    headers: Record<string, Array<{ key: string; value: string }>>;
  };
  resumingPageResponse: () => { status: string; body: string };
  sessionAttachedResponse: (
    sessionId: string,
    resuming: boolean,
  ) => { status: string; headers: Record<string, Array<{ key: string; value: string }>>; body?: string };
  sessionControlResponse: (options: {
    hasSession: boolean;
    paused?: boolean;
    message?: string;
    error?: boolean;
    clearSessionCookie?: boolean;
  }) => {
    status: string;
    headers: Record<string, Array<{ key: string; value: string }>>;
    body: string;
  };
  sessionSelectionResponse: (options: {
    sessions: Array<{
      sessionId: string;
      microvmId: string;
      state: string;
      imageVersion: string;
      paused: boolean;
      createdAt: number;
      expiresAt?: number;
      ttl: number;
    }>;
    currentSessionId?: string;
    errorMessage?: string;
    status?: string;
    now?: number;
  }) => {
    status: string;
    headers: Record<string, Array<{ key: string; value: string }>>;
    body: string;
  };
  signAccessCookie: (payload: string, password: string) => string;
  startSession: (requestId?: string) => Promise<{ status: string; headers: Record<string, unknown>; body: string }>;
};

type EdgeModule = {
  handler: (event: unknown) => Promise<{ status: string; headers: Record<string, unknown>; body?: string }>;
  __test: EdgeTestHelpers;
};

let edgeTemplate: Template | undefined;
let edgeModule: EdgeModule | undefined;

function getEdgeTemplate(): Template {
  if (!edgeTemplate) {
    const app = new cdk.App();
    const stack = new OmpCloudIdeEdgeStack(app, 'TestEdge', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    edgeTemplate = Template.fromStack(stack);
  }
  return edgeTemplate;
}

function getEdgeModule(): EdgeModule {
  // The stack generates artifact/edge/config.json because Lambda@Edge does not
  // support environment variables. Synthesizing first keeps tests runnable from
  // a clean clone where that generated file is intentionally ignored by Git.
  getEdgeTemplate();
  edgeModule ??= require('../artifact/edge/index.js') as EdgeModule;
  return edgeModule;
}

type AwsInput = Record<string, unknown>;
type AwsCall = { name: string; input: AwsInput };

async function withAwsMocks<T>(
  overrides: Record<string, (input: AwsInput) => unknown>,
  run: () => Promise<T>,
): Promise<{ calls: AwsCall[]; result: T }> {
  const { LambdaMicrovmsClient } = require('../artifact/edge/node_modules/@aws-sdk/client-lambda-microvms');
  const { DynamoDBClient } = require('../artifact/edge/node_modules/@aws-sdk/client-dynamodb');
  const { SecretsManagerClient } = require('../artifact/edge/node_modules/@aws-sdk/client-secrets-manager');
  const calls: AwsCall[] = [];
  const defaults: Record<string, (input: AwsInput) => unknown> = {
    PutItemCommand: () => ({}),
    UpdateItemCommand: () => ({}),
    DeleteItemCommand: () => ({}),
    ScanCommand: () => ({ Items: [] }),
    ListMicrovmsCommand: () => ({ items: [] }),
    RunMicrovmCommand: () => ({ microvmId: 'mvm-test', endpoint: 'mvm-test.example' }),
    CreateMicrovmAuthTokenCommand: () => ({ authToken: { 'X-aws-proxy-auth': 'test-token' } }),
    TerminateMicrovmCommand: () => ({}),
  };
  const mockSend = async (...args: unknown[]) => {
    const command = args[0];
    if (
      !command ||
      typeof command !== 'object' ||
      !('input' in command) ||
      !command.input ||
      typeof command.input !== 'object'
    ) {
      throw new Error('Invalid AWS command');
    }
    const input = command.input as AwsInput;
    const name = command.constructor.name;
    calls.push({ name, input });
    const respond = overrides[name] ?? defaults[name];
    if (!respond) throw new Error(`Unexpected AWS command: ${name}`);
    return respond(input);
  };
  const clients = [LambdaMicrovmsClient, DynamoDBClient, SecretsManagerClient];
  const spies = clients.map((client) => jest.spyOn(client.prototype, 'send').mockImplementation(mockSend));
  try {
    return { calls, result: await run() };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe('OMP Cloud IDE infrastructure', () => {
  test('synthesizes encrypted state and lifecycle-enabled MicroVM image in Tokyo', async () => {
    const app = new cdk.App();
    const stack = new OmpCloudIdeMicrovmStack(app, 'TestMicrovm', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
            },
          },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
      // Auth-state versions are the only recovery path, but must not grow without bound.
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 30, NewerNoncurrentVersions: 10 },
          }),
        ],
      },
    });
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Name: 'omp-cloud-ide',
      BaseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
      BaseImageVersion: '1',
      Hooks: {
        Port: 9000,
        MicrovmImageHooks: Match.objectLike({ Ready: 'ENABLED', Validate: 'ENABLED' }),
        MicrovmHooks: Match.objectLike({
          Run: 'ENABLED',
          Resume: 'ENABLED',
          Suspend: 'ENABLED',
          Terminate: 'ENABLED',
        }),
      },
      EnvironmentVariables: Match.arrayWith([{ Key: 'PI_CODING_AGENT_DIR', Value: '/home/vscode/.omp/agent' }]),
    });
  });

  test('uses an edge login form before exposing the IDE', async () => {
    const template = getEdgeTemplate();

    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          LambdaFunctionAssociations: Match.arrayWith([
            Match.objectLike({ EventType: 'origin-request', IncludeBody: true }),
            Match.objectLike({ EventType: 'origin-response', IncludeBody: false }),
          ]),
          ResponseHeadersPolicyId: Match.anyValue(),
        }),
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: 'omp-cloud-ide-security-headers',
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: Match.objectLike({ Override: false }),
          StrictTransportSecurity: Match.objectLike({ Override: true }),
        }),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:CreateMicrovmAuthToken',
            Effect: 'Allow',
            Resource: 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:omp-cloud-ide',
          }),
          Match.objectLike({
            Action: Match.arrayWith([
              'lambda:GetMicrovm',
              'lambda:SuspendMicrovm',
              'lambda:ResumeMicrovm',
              'lambda:TerminateMicrovm',
            ]),
            Effect: 'Allow',
            Resource: [
              'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:omp-cloud-ide',
              'arn:aws:lambda:ap-northeast-1:123456789012:microvm:*',
            ],
          }),
          Match.objectLike({ Action: 'lambda:ListMicrovms', Effect: 'Allow', Resource: '*' }),
          Match.objectLike({
            Action: 'iam:PassRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::123456789012:role/omp-cloud-ide-microvm-execution',
            Condition: Match.absent(),
          }),
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:Scan']),
            Effect: 'Allow',
          }),
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });

  test('renders an in-page login instead of a browser Basic auth challenge', async () => {
    const edge = getEdgeModule();
    const response = await edge.handler({
      Records: [{ cf: { request: { method: 'GET', uri: '/login', headers: {} } } }],
    });

    expect(response.status).toBe('200');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(String(response.body)).toContain('<form method="post" action="/login"');

    const redirect = await edge.handler({
      Records: [{ cf: { request: { method: 'GET', uri: '/', headers: {} } } }],
    });
    expect(redirect.status).toBe('302');
    expect(redirect.headers.location).toEqual([{ key: 'Location', value: '/login' }]);
  });

  test('parses login bodies and rejects tampered or out-of-window access cookies', () => {
    const helpers = getEdgeModule().__test;
    const encoded = Buffer.from('username=har1101&password=a%26b%3Dc').toString('base64');
    expect(helpers.parseLoginForm({ data: encoded, encoding: 'base64' })).toEqual({
      username: 'har1101',
      password: 'a&b=c',
    });
    expect(helpers.parseLoginForm({ data: encoded, encoding: 'base64', inputTruncated: true })).toBeNull();

    const now = 1_800_000_000_000;
    const password = 'test-only-password';
    const setCookie = helpers.createAccessCookie(password, now);
    const value = setCookie.split(';', 1)[0]?.split('=', 2)[1];
    expect(value).toBeDefined();
    if (!value) throw new Error('access cookie value was not generated');
    expect(helpers.isAccessCookieValidForPassword(value, password, now + 1_000)).toBe(true);
    expect(helpers.isAccessCookieValidForPassword(`${value}tampered`, password, now + 1_000)).toBe(false);
    expect(helpers.isAccessCookieValidForPassword(value, 'wrong-password', now + 1_000)).toBe(false);
    expect(helpers.isAccessCookieValidForPassword(value, password, now + 28_801_000)).toBe(false);

    const beyondWindow = String(Math.floor(now / 1000) + 28_861);
    const futureCookie = `${beyondWindow}.${helpers.signAccessCookie(beyondWindow, password)}`;
    expect(helpers.isAccessCookieValidForPassword(futureCookie, password, now)).toBe(false);
  });

  test('escapes login errors and sends restrictive login-page security headers', () => {
    const response = getEdgeModule().__test.loginPageResponse('<invalid>', '401');
    expect(response.status).toBe('401');
    expect(response.body).toContain('&lt;invalid&gt;');
    expect(response.body).not.toContain('<invalid>');
    expect(response.headers['content-security-policy'][0].value).toContain("form-action 'self'");
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  test('renders explicit suspend and resume controls without starting a session', () => {
    const helpers = getEdgeModule().__test;

    const noSession = helpers.sessionControlResponse({ hasSession: false });
    expect(noSession.body).toContain('No active Cloud IDE session');
    expect(noSession.body).toContain('href="/session/select">Choose a session</a>');
    expect(noSession.body).not.toContain('action="/session/suspend"');

    const running = helpers.sessionControlResponse({ hasSession: true });
    expect(running.body).toContain('method="post" action="/session/suspend"');
    expect(running.body).toContain('Suspend Cloud IDE');
    expect(running.body).toContain('href="/session/select">Switch session</a>');
    expect(running.headers['content-security-policy'][0].value).toContain("frame-ancestors 'self'");

    const paused = helpers.sessionControlResponse({ hasSession: true, paused: true });
    expect(paused.body).toContain('method="post" action="/session/resume"');
    expect(paused.body).toContain('Resume editor');

    const error = helpers.sessionControlResponse({ hasSession: true, error: true, message: '<failed>' });
    expect(error.body).toContain('class="status error"');
    expect(error.body).toContain('&lt;failed&gt;');
  });

  test('renders a safe chooser for existing and new MicroVM sessions', () => {
    const helpers = getEdgeModule().__test;
    const sessionId = '7d041485-dff5-4033-bdbc-a921757e217b';
    const response = helpers.sessionSelectionResponse({
      currentSessionId: sessionId,
      sessions: [
        {
          sessionId,
          microvmId: 'microvm-<unsafe>',
          state: 'SUSPENDED',
          imageVersion: '11.0',
          paused: false,
          createdAt: 1_800_000_000_000,
          expiresAt: 1_800_028_800_000,
          ttl: 0,
        },
      ],
      now: 1_800_019_800_000,
    });

    expect(response.status).toBe('200');
    expect(response.body).toContain('Choose a Cloud IDE session');
    expect(response.body).toContain('microvm-&lt;unsafe&gt;');
    expect(response.body).not.toContain('microvm-<unsafe>');
    expect(response.body).toContain('Currently selected in this browser');
    expect(response.body).toContain('Resume and connect');
    expect(response.body).toContain('name="sessionId" value="7d041485-dff5-4033-bdbc-a921757e217b"');
    expect(response.body).toContain('Start a new MicroVM');
    expect(response.headers['content-security-policy'][0].value).toContain("form-action 'self'");
    expect(response.body).toContain('Ends 2027-01-15T16:00:00.000Z (2h 30m left)');

    const attached = helpers.sessionAttachedResponse(sessionId, false);
    expect(attached.status).toBe('303');
    expect(attached.headers.location).toEqual([{ key: 'Location', value: '/' }]);
    expect(attached.headers['set-cookie'][0].value).toContain(`mvm-session=${sessionId}`);
    expect(attached.headers['set-cookie'][0].value).toContain('HttpOnly');

    const resuming = helpers.sessionAttachedResponse(sessionId, true);
    expect(resuming.status).toBe('200');
    expect(resuming.body).toContain('Resuming the Cloud IDE');
    expect(resuming.headers['set-cookie'][0].value).toContain(`mvm-session=${sessionId}`);
  });

  test('passes a MicroVM lifetime deadline no later than the real one to the run hook', async () => {
    const helpers = getEdgeModule().__test;
    let runCalledAt = 0;
    const startedBefore = Date.now();
    const { calls } = await withAwsMocks(
      {
        RunMicrovmCommand: () => {
          runCalledAt = Date.now();
          return { microvmId: 'mvm-test', endpoint: 'mvm-test.example' };
        },
      },
      async () => expect((await helpers.startSession()).status).toBe('200'),
    );

    const payload = JSON.parse(String(calls.find((c) => c.name === 'RunMicrovmCommand')?.input.runHookPayload));
    expect(payload.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // The service starts its 8-hour clock no earlier than the RunMicrovm call.
    expect(payload.expiresAt).toBeGreaterThanOrEqual(startedBefore + 28_800_000);
    expect(payload.expiresAt).toBeLessThanOrEqual(runCalledAt + 28_800_000);
  });

  test('terminates a new MicroVM that could not be registered', async () => {
    const helpers = getEdgeModule().__test;
    const { calls } = await withAwsMocks(
      {
        RunMicrovmCommand: () => ({ microvmId: 'mvm-orphan', endpoint: 'mvm-orphan.example' }),
        CreateMicrovmAuthTokenCommand: () => {
          throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
        },
      },
      async () => {
        const response = await helpers.startSession();
        expect(response.status).toBe('502');
        // The browser must not be bound to a session that has no MicroVM.
        expect(response.headers['set-cookie']).toBeUndefined();
      },
    );
    expect(calls.filter((c) => c.name === 'TerminateMicrovmCommand').map((c) => c.input.microvmIdentifier)).toEqual([
      'mvm-orphan',
    ]);
  });

  test('shows a MicroVM whose compensating termination failed without binding a cookie', async () => {
    const { result } = await withAwsMocks(
      {
        RunMicrovmCommand: () => ({ microvmId: 'mvm-orphan', endpoint: 'mvm-orphan.example' }),
        CreateMicrovmAuthTokenCommand: () => {
          throw new Error('registration failed');
        },
        TerminateMicrovmCommand: () => {
          throw new Error('termination failed');
        },
        ListMicrovmsCommand: () => ({
          items: [
            {
              microvmId: 'mvm-orphan',
              imageArn: 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:omp-cloud-ide',
              state: 'RUNNING',
            },
          ],
        }),
      },
      () => getEdgeModule().__test.startSession(),
    );
    expect(result.body).toContain('mvm-orphan');
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  test('reconciles all session and MicroVM pages before reporting untracked machines', async () => {
    const edge = getEdgeModule();
    const password = 'test-only-password';
    const accessCookie = edge.__test.createAccessCookie(password).split(';', 1)[0];
    const imageArn = 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:omp-cloud-ide';
    const { result } = await withAwsMocks(
      {
        GetSecretValueCommand: () => ({ SecretString: password }),
        ScanCommand: (input) =>
          input.ExclusiveStartKey
            ? { Items: [{ sessionId: { S: 'tracked' }, microvmId: { S: 'mvm-tracked' } }] }
            : { Items: [], LastEvaluatedKey: { sessionId: { S: 'last' } } },
        GetMicrovmCommand: () => ({ state: 'RUNNING', imageVersion: '1' }),
        ListMicrovmsCommand: (input) =>
          input.nextToken
            ? { items: [{ microvmId: 'mvm-orphan', imageArn, state: 'RUNNING' }] }
            : { items: [{ microvmId: 'mvm-tracked', imageArn, state: 'RUNNING' }], nextToken: 'next' },
      },
      () =>
        edge.handler({
          Records: [
            {
              cf: {
                request: {
                  method: 'GET',
                  uri: '/session/select',
                  headers: {
                    cookie: [{ key: 'Cookie', value: accessCookie }],
                  },
                },
              },
            },
          ],
        }),
    );
    expect(result.body).toContain('mvm-tracked');
    expect(result.body).toContain('mvm-orphan');
    expect(result.body?.match(/<strong>mvm-tracked<\/strong>/g)).toHaveLength(1);
  });

  test('starts one MicroVM for a double-submitted start form', async () => {
    const helpers = getEdgeModule().__test;
    const requestId = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
    const claimed = new Set<string>();
    const { calls } = await withAwsMocks(
      {
        PutItemCommand: (input) => {
          const item = input.Item as { sessionId: { S: string }; microvmId?: unknown };
          if (input.ConditionExpression && claimed.has(item.sessionId.S)) {
            throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
          }
          claimed.add(item.sessionId.S);
          return {};
        },
      },
      async () => {
        expect((await helpers.startSession(requestId)).status).toBe('200');
        expect((await helpers.startSession(requestId)).status).toBe('409');
      },
    );
    expect(calls.filter((c) => c.name === 'RunMicrovmCommand')).toHaveLength(1);
    expect(JSON.parse(String(calls.find((c) => c.name === 'RunMicrovmCommand')?.input.runHookPayload)).sessionId).toBe(
      requestId,
    );
  });

  test('does not forward an expired proxy token when renewal fails', async () => {
    const edge = getEdgeModule();
    const password = 'test-only-password';
    const accessCookie = edge.__test.createAccessCookie(password).split(';', 1)[0];
    const sessionId = '7d041485-dff5-4033-bdbc-a921757e217b';
    type Forwarded = { status?: string; headers: Record<string, Array<{ value: string }>> };
    const requestWithTokenExpiry = async (tokenExpiry: number) =>
      (
        await withAwsMocks(
          {
            GetSecretValueCommand: () => ({ SecretString: password }),
            GetItemCommand: () => ({
              Item: {
                sessionId: { S: sessionId },
                microvmId: { S: 'mvm-test' },
                endpoint: { S: 'mvm-test.example' },
                token: { S: 'old-token' },
                tokenExpiry: { N: String(tokenExpiry) },
                paused: { BOOL: false },
              },
            }),
            CreateMicrovmAuthTokenCommand: () => {
              throw Object.assign(new Error('down'), { name: 'InternalServerException' });
            },
          },
          () =>
            edge.handler({
              Records: [
                {
                  cf: {
                    request: {
                      method: 'GET',
                      uri: '/',
                      headers: {
                        accept: [{ key: 'Accept', value: 'text/html' }],
                        cookie: [{ key: 'Cookie', value: `${accessCookie}; mvm-session=${sessionId}` }],
                      },
                    },
                  },
                },
              ],
            }),
        )
      ).result as Forwarded;

    expect((await requestWithTokenExpiry(Date.now() - 1_000)).status).toBe('503');
    // Still inside the refresh window: the old token keeps working, so forward it.
    const forwarded = await requestWithTokenExpiry(Date.now() + 5 * 60_000);
    expect(forwarded.headers['x-aws-proxy-auth'][0].value).toBe('old-token');
  });

  test('requires an exact second confirmation, then cleans up only the terminated session', async () => {
    const edge = getEdgeModule();
    const password = 'test-only-password';
    const accessCookie = edge.__test.createAccessCookie(password).split(';', 1)[0];
    const sessionId = '7d041485-dff5-4033-bdbc-a921757e217b';
    const microvmId = 'microvm-40287cea-cb68-32ac-a059-02188a827bff';
    const imageArn = 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:omp-cloud-ide';
    let state = 'RUNNING';
    let rowExists = true;
    const row = { sessionId: { S: sessionId }, microvmId: { S: microvmId }, paused: { BOOL: true } };
    const post = (action: string, confirmation = '') =>
      edge.handler({
        Records: [
          {
            cf: {
              request: {
                method: 'POST',
                uri: '/session/select',
                headers: { cookie: [{ key: 'Cookie', value: `${accessCookie}; mvm-session=${sessionId}` }] },
                body: {
                  encoding: 'text',
                  data: new URLSearchParams({ action, sessionId, microvmId, confirmation }).toString(),
                },
              },
            },
          },
        ],
      });
    const { calls } = await withAwsMocks(
      {
        GetSecretValueCommand: () => ({ SecretString: password }),
        GetItemCommand: () => ({ Item: rowExists ? row : undefined }),
        GetMicrovmCommand: () => ({ microvmId, imageArn, state }),
        ScanCommand: () => ({ Items: rowExists ? [row] : [] }),
        TerminateMicrovmCommand: () => {
          state = 'TERMINATING';
          return {};
        },
        DeleteItemCommand: () => {
          rowExists = false;
          return {};
        },
      },
      async () => {
        const confirmation = await post('terminate-confirm');
        expect(confirmation.body).toContain(`Type the MicroVM ID to confirm`);
        expect(confirmation.body).toContain(microvmId);
        expect((await post('terminate', 'wrong-id')).body).toContain('Type the exact MicroVM ID');
        const result = await post('terminate', microvmId);
        expect(result.body).toContain('Termination requested');
        expect(result.headers['set-cookie']).toEqual([
          { key: 'Set-Cookie', value: expect.stringContaining('mvm-session=;') },
        ]);
        expect(rowExists).toBe(true);
        state = 'TERMINATED';
        const chooser = await edge.handler({
          Records: [
            {
              cf: {
                request: {
                  method: 'GET',
                  uri: '/session/select',
                  headers: { cookie: [{ key: 'Cookie', value: accessCookie }] },
                },
              },
            },
          ],
        });
        expect(chooser.body).not.toContain(microvmId);
        expect(rowExists).toBe(false);
      },
    );
    expect(calls.filter((call) => call.name === 'TerminateMicrovmCommand')).toHaveLength(1);
    expect(calls.find((call) => call.name === 'DeleteItemCommand')?.input.ConditionExpression).toBe('microvmId = :id');
  });

  test('keeps an uncertain termination blocked and rejects untracked termination requests', async () => {
    const edge = getEdgeModule();
    const password = 'test-only-password';
    const accessCookie = edge.__test.createAccessCookie(password).split(';', 1)[0];
    const sessionId = '7d041485-dff5-4033-bdbc-a921757e217b';
    const microvmId = 'microvm-11111111-2222-4333-8444-555555555555';
    const row = {
      sessionId: { S: sessionId },
      microvmId: { S: microvmId },
      paused: { BOOL: false },
      terminationPending: { BOOL: false },
    };
    const invoke = (method: string, uri: string, data?: URLSearchParams) =>
      edge.handler({
        Records: [
          {
            cf: {
              request: {
                method,
                uri,
                headers: { cookie: [{ key: 'Cookie', value: `${accessCookie}; mvm-session=${sessionId}` }] },
                body: data ? { encoding: 'text', data: data.toString() } : undefined,
              },
            },
          },
        ],
      });
    const { calls } = await withAwsMocks(
      {
        GetSecretValueCommand: () => ({ SecretString: password }),
        GetItemCommand: () => ({ Item: row }),
        ScanCommand: () => ({ Items: [row] }),
        GetMicrovmCommand: () => ({
          microvmId,
          imageArn: 'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:omp-cloud-ide',
          state: 'RUNNING',
        }),
        UpdateItemCommand: () => {
          row.terminationPending.BOOL = true;
          row.paused.BOOL = true;
          return {};
        },
        TerminateMicrovmCommand: () => {
          throw Object.assign(new Error('lost response'), { name: 'TimeoutError' });
        },
      },
      async () => {
        const untracked = await invoke(
          'POST',
          '/session/select',
          new URLSearchParams({ action: 'terminate', microvmId, confirmation: microvmId }),
        );
        expect(untracked.status).toBe('400');
        const result = await invoke(
          'POST',
          '/session/select',
          new URLSearchParams({ action: 'terminate', sessionId, microvmId, confirmation: microvmId }),
        );
        expect(result.status).toBe('502');
        expect(result.body).toContain('Termination outcome is unknown');
        expect(result.headers['set-cookie']).toBeUndefined();
        expect((await invoke('GET', '/session/control')).body).not.toContain('Resume editor');
        expect((await invoke('GET', '/')).status).toBe('200');
        const chooser = await invoke('GET', '/session/select');
        expect(chooser.body).toContain('Termination pending; do not reconnect.');
        expect(chooser.body).not.toContain('name="action" value="attach"');
      },
    );
    expect(calls.filter((call) => call.name === 'TerminateMicrovmCommand')).toHaveLength(1);
    expect(row.terminationPending.BOOL).toBe(true);
  });

  test('forwards editor cookies but never forwards Edge access or session cookies', async () => {
    const edge = getEdgeModule();
    const password = 'test-only-password';
    const accessCookie = edge.__test.createAccessCookie(password).split(';', 1)[0];
    const sessionId = '7d041485-dff5-4033-bdbc-a921757e217b';
    const forward = (other = '') =>
      edge.handler({
        Records: [
          {
            cf: {
              request: {
                method: 'GET',
                uri: '/api/editor',
                headers: {
                  cookie: [
                    { key: 'Cookie', value: accessCookie },
                    { key: 'Cookie', value: `mvm-session=${sessionId}${other}` },
                  ],
                },
              },
            },
          },
        ],
      });
    await withAwsMocks(
      {
        GetSecretValueCommand: () => ({ SecretString: password }),
        GetItemCommand: () => ({
          Item: {
            microvmId: { S: 'mvm-test' },
            endpoint: { S: 'mvm-test.example' },
            token: { S: 'valid-token' },
            tokenExpiry: { N: String(Date.now() + 60 * 60_000) },
          },
        }),
      },
      async () => {
        const forwarded = await forward('; vscode-web=foo=bar; theme=dark');
        expect(forwarded.headers.cookie).toEqual([{ key: 'Cookie', value: 'vscode-web=foo=bar; theme=dark' }]);
        expect(forwarded.headers['x-aws-proxy-auth']).toEqual([{ key: 'X-aws-proxy-auth', value: 'valid-token' }]);
        expect((await forward()).headers.cookie).toBeUndefined();
      },
    );
  });

  test('lifecycle.py persistence and run hook behave as specified (test/lifecycle_test.py)', () => {
    const result = spawnSync('python3', [path.join(__dirname, 'lifecycle_test.py')], { encoding: 'utf8' });
    expect(`${result.stderr}`).toMatch(/\nOK\s*$/);
    expect(result.status).toBe(0);
  });

  test('counts down the MicroVM lifetime and warns once per crossed threshold', () => {
    const timer = require('../artifact/base-image/omp-cloud-ide-controls/session-timer.js') as {
      clockOffsetMs: (dateHeader: string | null, sentAt: number, receivedAt: number) => number | null;
      dueNotification: (remainingMs: number, notified: Set<number>) => number | undefined;
      formatRemaining: (remainingMs: number) => string;
      parseSessionDeadline: (text: string) => number | null;
      severity: (remainingMs: number) => string;
      describeAuthSync: (
        status: unknown,
        nowMs: number,
        syncIntervalMs: number,
      ) => { text: string; level: string; detail: string };
    };
    const minutes = (value: number) => value * 60_000;

    expect(timer.parseSessionDeadline('{"expiresAt":1800028800000}')).toBe(1_800_028_800_000);
    expect(timer.parseSessionDeadline('{"expiresAt":"1800028800000"}')).toBeNull();
    expect(timer.parseSessionDeadline('{')).toBeNull();

    expect(timer.formatRemaining(minutes(8 * 60))).toBe('8:00');
    expect(timer.formatRemaining(minutes(65) - 1)).toBe('1:04');

    expect(timer.severity(minutes(30) + 1)).toBe('normal');
    expect(timer.severity(minutes(30))).toBe('warning');
    expect(timer.severity(minutes(10))).toBe('error');

    expect(timer.dueNotification(minutes(60) + 1, new Set())).toBeUndefined();
    expect(timer.dueNotification(minutes(60), new Set())).toBe(60);
    // Opening the IDE late announces only the tightest crossed threshold.
    expect(timer.dueNotification(minutes(12), new Set())).toBe(15);
    expect(timer.dueNotification(minutes(12), new Set([60, 15]))).toBeUndefined();
    expect(timer.dueNotification(minutes(5), new Set([60, 15]))).toBe(5);
    expect(timer.dueNotification(0, new Set())).toBeUndefined();

    // A guest clock 10 minutes behind (e.g. after Resume) is corrected from the Date header.
    const trueNow = Date.parse('2027-01-15T12:00:00.500Z');
    const localNow = trueNow - minutes(10);
    expect(timer.clockOffsetMs('Fri, 15 Jan 2027 12:00:00 GMT', localNow - 100, localNow + 100)).toBe(minutes(10));
    expect(timer.clockOffsetMs(null, localNow, localNow)).toBeNull();

    // Auth-sync status: failures outrank age; a sync older than 3 intervals is stale.
    const now = 1_800_000_000_000;
    const interval = minutes(5);
    const ok = { lastSuccessAt: now - minutes(4), failed: [], restoreFailed: [] };
    expect(timer.describeAuthSync(ok, now, interval)).toMatchObject({ text: '$(cloud) 認証 4分前', level: 'normal' });
    expect(timer.describeAuthSync({ ...ok, lastSuccessAt: now - minutes(16) }, now, interval).level).toBe('warning');
    expect(timer.describeAuthSync({ ...ok, failed: ['omp/agent.db'] }, now, interval)).toMatchObject({
      text: '$(warning) 認証保存失敗',
      level: 'error',
    });
    expect(
      timer.describeAuthSync({ ...ok, failed: ['x'], restoreFailed: ['github/hosts.yml'] }, now, interval).text,
    ).toBe('$(warning) 認証復元失敗');
    // A conflict is not a generic failure: the fix is choosing whose credentials win.
    expect(
      timer.describeAuthSync({ ...ok, failed: ['github/hosts.yml'], conflicts: ['github/hosts.yml'] }, now, interval)
        .text,
    ).toBe('$(warning) 認証競合');
    expect(timer.describeAuthSync(null, now, interval).level).toBe('warning');
  });

  test('preserves the session cookie when a MicroVM origin temporarily returns 502', async () => {
    const responseHandler = require('../artifact/edge-response/index.js').handler as (
      event: unknown,
    ) => Promise<{ status: string; headers: Record<string, unknown> }>;
    const response = await responseHandler({
      Records: [
        {
          cf: {
            request: {
              headers: {
                accept: [{ key: 'Accept', value: 'text/html' }],
                cookie: [{ key: 'Cookie', value: 'mvm-session=test-session' }],
              },
            },
            response: { status: '502', headers: {} },
          },
        },
      ],
    });

    expect(response.status).toBe('302');
    expect(response.headers.location).toEqual([{ key: 'Location', value: '/session/select' }]);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  test('uses a CSP-compatible start-page redirect', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'artifact', 'edge', 'index.js'), 'utf8');
    expect(source).toContain('<meta http-equiv="refresh" content="8;url=/">');
    expect(source).not.toContain("<script>setTimeout(()=>location.href='/',8000)</script>");
  });

  test('blocks paused editor traffic and only permits POST lifecycle actions', () => {
    const helpers = getEdgeModule().__test;
    const navigation = helpers.pausedSessionResponse({ accept: [{ key: 'Accept', value: 'text/html' }] });
    expect(navigation.status).toBe('302');
    expect(navigation.headers.location).toEqual([{ key: 'Location', value: '/session/control' }]);

    const websocket = helpers.pausedSessionResponse({});
    expect(websocket.status).toBe('409');
    expect(websocket.headers['retry-after']).toEqual([{ key: 'Retry-After', value: '5' }]);

    const method = helpers.postOnlyResponse();
    expect(method.status).toBe('405');
    expect(method.headers.allow).toEqual([{ key: 'Allow', value: 'POST' }]);

    expect(helpers.resumingPageResponse().body).toContain('content="5;url=/"');
  });

  test('pins OMP and runs code-server as an unprivileged user', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'artifact', 'base-image', 'Dockerfile'), 'utf8');
    const ompConfig = fs.readFileSync(path.join(__dirname, '..', 'artifact', 'base-image', 'omp-config.yml'), 'utf8');
    const settings = fs.readFileSync(path.join(__dirname, '..', 'artifact', 'base-image', 'settings.json'), 'utf8');
    const controlsPackage = fs.readFileSync(
      path.join(__dirname, '..', 'artifact', 'base-image', 'omp-cloud-ide-controls', 'package.json'),
      'utf8',
    );
    expect(dockerfile).toContain('ARG OMP_VERSION=18.2.11');
    expect(dockerfile).toContain('useradd --uid 1000');
    expect(dockerfile).toContain('USER vscode');
    expect(dockerfile).toContain('ripgrep');
    expect(dockerfile).toContain('ARG CHROMIUM_VERSION=149.0.0');
    expect(dockerfile).toContain(
      'CHROMIUM_ARM64_PACK_SHA256=9c42e7850d746cbf0ac0e68eaa48af277af8255a5ee12a813c08573671f231f6',
    );
    expect(dockerfile).toContain('AWS_EXECUTION_ENV=AWS_Lambda_nodejs24.x TMPDIR=/opt/chromium');
    expect(dockerfile).toContain('PUPPETEER_EXECUTABLE_PATH=/opt/chromium/chromium');
    expect(dockerfile).toContain('/opt/chromium/chromium --version');
    expect(dockerfile).toContain(
      ['COPY omp-cloud-ide-controls $', '{EXTENSIONS_DIR}/har1101.omp-cloud-ide-controls-0.1.0'].join(''),
    );
    expect(dockerfile).not.toContain('useradd -o -u 0');
    expect(ompConfig).toContain('approvalMode: yolo');
    expect(ompConfig).toContain('continuationModes:\n    - interactive');
    expect(ompConfig).toContain('ask:\n  enabled: true');
    expect(ompConfig).toContain(
      'browser:\n  enabled: true\n  headless: true\n  screenshotDir: /home/vscode/workspace/.artifacts/screenshots',
    );
    expect(ompConfig).toContain('- match: "rm -rf *"\n      approval: deny');
    expect(ompConfig).toContain('- match: "git push --force*"\n      approval: deny');
    expect(settings).toContain('"ompCloudIde.controlUrl"');
    expect(controlsPackage).toContain('"onCommand:ompCloudIde.openControl"');
  });
});
