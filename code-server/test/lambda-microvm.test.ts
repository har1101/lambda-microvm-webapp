import * as fs from 'node:fs';
import * as path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { OmpCloudIdeEdgeStack, OmpCloudIdeMicrovmStack } from '../lib/lambda-microvm-stack';

type EdgeTestHelpers = {
  createAccessCookie: (password: string, now?: number) => string;
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
  signAccessCookie: (payload: string, password: string) => string;
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
            Action: Match.arrayWith(['lambda:GetMicrovm', 'lambda:SuspendMicrovm', 'lambda:ResumeMicrovm']),
            Effect: 'Allow',
            Resource: [
              'arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:omp-cloud-ide',
              'arn:aws:lambda:ap-northeast-1:123456789012:microvm:*',
            ],
          }),
          Match.objectLike({
            Action: 'iam:PassRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::123456789012:role/omp-cloud-ide-microvm-execution',
            Condition: Match.absent(),
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
    expect(noSession.body).toContain('href="/">Start editor</a>');
    expect(noSession.body).not.toContain('action="/session/suspend"');

    const running = helpers.sessionControlResponse({ hasSession: true });
    expect(running.body).toContain('method="post" action="/session/suspend"');
    expect(running.body).toContain('Suspend Cloud IDE');
    expect(running.headers['content-security-policy'][0].value).toContain("frame-ancestors 'self'");

    const paused = helpers.sessionControlResponse({ hasSession: true, paused: true });
    expect(paused.body).toContain('method="post" action="/session/resume"');
    expect(paused.body).toContain('Resume editor');

    const error = helpers.sessionControlResponse({ hasSession: true, error: true, message: '<failed>' });
    expect(error.body).toContain('class="status error"');
    expect(error.body).toContain('&lt;failed&gt;');
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
    const controlsExtension = fs.readFileSync(
      path.join(__dirname, '..', 'artifact', 'base-image', 'omp-cloud-ide-controls', 'extension.js'),
      'utf8',
    );
    expect(dockerfile).toContain('ARG OMP_VERSION=18.2.11');
    expect(dockerfile).toContain('useradd --uid 1000');
    expect(dockerfile).toContain('USER vscode');
    expect(dockerfile).toContain('ripgrep');
    expect(dockerfile).toContain(
      ['COPY omp-cloud-ide-controls $', '{EXTENSIONS_DIR}/har1101.omp-cloud-ide-controls-0.1.0'].join(''),
    );
    expect(dockerfile).not.toContain('useradd -o -u 0');
    expect(ompConfig).toContain('approvalMode: yolo');
    expect(ompConfig).toContain('continuationModes:\n    - interactive');
    expect(ompConfig).toContain('ask:\n  enabled: true');
    expect(ompConfig).toContain('- match: "rm -rf *"\n      approval: deny');
    expect(ompConfig).toContain('- match: "git push --force*"\n      approval: deny');
    expect(settings).toContain('"ompCloudIde.controlUrl"');
    expect(controlsPackage).toContain('"onCommand:ompCloudIde.openControl"');
    expect(controlsExtension).toContain("status.text = '$(debug-pause) Suspend Cloud IDE'");
    expect(controlsExtension).toContain("controlUrl?.protocol !== 'https:'");
    expect(controlsExtension).toContain("command: 'vscode.open'");
    expect(controlsExtension).not.toContain('vscode.env.openExternal');
  });
});
