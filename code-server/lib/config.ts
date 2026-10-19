const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT;

if (!ACCOUNT) {
  throw new Error('CDK_DEFAULT_ACCOUNT is required. Run with an authenticated AWS profile.');
}

const MICROVM_REGION = 'ap-northeast-1';
const EDGE_REGION = 'us-east-1';

// T3 PoC: a T3 task image (t3 serve + Claude Code + Codex, RAM-only logins).
// T3_POC_ONLY=1 deploys only the T3 image (one image build, minimal cost).
// T3_MAX_DURATION_SEC shortens T3 VM lifetime for the expiry test (default 8h).
const T3_POC_ONLY = process.env.T3_POC_ONLY === '1';
// A T3-only PoC deploys as separate stacks/resources (prefix t3-poc) so it never
// touches an existing OMP Cloud IDE deployment in the same account.
export const NAME_PREFIX = T3_POC_ONLY ? 't3poc' : 'omp-cloud-ide';
const T3_MAX_DURATION_SEC = Number(process.env.T3_MAX_DURATION_SEC ?? 28800);
if (!Number.isInteger(T3_MAX_DURATION_SEC) || T3_MAX_DURATION_SEC < 900 || T3_MAX_DURATION_SEC > 28800) {
  throw new Error('T3_MAX_DURATION_SEC must be an integer between 900 and 28800');
}

type Size = {
  id: string;
  imageName: string;
  minimumMemoryInMiB: number;
  label: string;
  roles: readonly ('admin' | 'guest')[];
  kind: 'ide' | 't3';
};

const IDE_SIZES: Size[] = [
  {
    id: '2gb',
    imageName: 'omp-cloud-ide',
    minimumMemoryInMiB: 2048,
    label: '2 GB / 1 vCPU (peak 8 GB / 4 vCPU), disk 8 GB',
    roles: ['admin', 'guest'],
    kind: 'ide',
  },
  {
    id: '4gb',
    imageName: 'omp-cloud-ide-4gb',
    minimumMemoryInMiB: 4096,
    label: '4 GB / 2 vCPU (peak 16 GB / 8 vCPU), disk 16 GB, 2x baseline cost',
    roles: ['admin', 'guest'],
    kind: 'ide',
  },
  {
    id: '8gb',
    imageName: 'omp-cloud-ide-8gb',
    minimumMemoryInMiB: 8192,
    label: '8 GB / 4 vCPU (peak 32 GB / 16 vCPU), disk 32 GB, 4x baseline cost',
    roles: ['admin'],
    kind: 'ide',
  },
];

const T3_SIZE: Size = {
  id: 't3-2gb',
  imageName: 't3poc-task',
  minimumMemoryInMiB: 2048,
  label: 'T3 task (PoC): t3 serve + Claude Code + Codex, logins in RAM only, 2 GB / 1 vCPU',
  roles: ['admin'],
  kind: 't3',
};

export const config = {
  account: ACCOUNT,
  microvmRegion: MICROVM_REGION,
  edgeRegion: EDGE_REGION,
  microvmStackName: T3_POC_ONLY ? 'T3pocMicrovmStack' : 'OmpCloudIdeMicrovmStack',
  edgeStackName: T3_POC_ONLY ? 'T3pocEdgeStack' : 'OmpCloudIdeEdgeStack',
  // One MicroVM image per baseline size: RunMicrovm cannot override memory, and
  // disk scales with it (https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html#microvms-images-sizing).
  // The first entry is the chooser default. Every image builds from the same artifact.
  // `roles` lists the Cognito roles (see edge.groups) allowed to start the size.
  sizes: T3_POC_ONLY ? [T3_SIZE] : [...IDE_SIZES, T3_SIZE],
  t3: { idleSec: 28800, maxDurationSec: T3_MAX_DURATION_SEC },
  // T3-only PoC: no CloudFront/Cognito/Edge stack; the Mac runs `tools/t3poc`.
  deployEdge: !T3_POC_ONLY,
  imageDescription: 'Personal OMP cloud IDE on Lambda MicroVM',
  baseImageArn: `arn:aws:lambda:${MICROVM_REGION}:aws:microvm-image:al2023-1`,
  baseImageVersion: '1',
  artifactDir: 'artifact/base-image',
  authState: {
    bucketName: `${NAME_PREFIX}-auth-${ACCOUNT}-${MICROVM_REGION}`,
    prefix: 'personal',
    syncIntervalSeconds: 300,
    noncurrentVersionRetentionDays: 30,
    noncurrentVersionsToRetain: 10,
  },
  edge: {
    tableName: `${NAME_PREFIX}-sessions`,
    authTableName: `${NAME_PREFIX}-auth-sessions`,
    // Cognito group per role. Users in neither group cannot sign in. Admins get
    // the shared OAuth state and see every session; guests get neither.
    groups: { admin: 'admins', guest: 'guests' },
    // Lambda@Edge cannot read stack outputs or environment variables, so the
    // generated User Pool/Client IDs are published under this stable name.
    cognitoParameterName: `/${NAME_PREFIX}/cognito`,
    cognitoDomainPrefix: `${NAME_PREFIX}-${ACCOUNT}`,
    accessCookieName: 'omp-cloud-ide-auth',
    accessCookieMaxAgeSec: 28800,
    oauthCookieName: 'omp-cloud-ide-oauth',
    loginTtlSec: 600,
    tokenDurationMin: 60,
    tokenRefreshThresholdMin: 15,
    maxDurationSec: 28800,
    idleSec: 300,
    suspendedSec: 28800,
  },
} as const;

export const imageArn = (imageName: string) =>
  `arn:aws:lambda:${config.microvmRegion}:${config.account}:microvm-image:${imageName}` as const;
export const imageArns = config.sizes.map((size) => imageArn(size.imageName));
// Admins: shared OAuth state in S3. Guests: no S3/KMS access at all.
export const executionRoleArn = `arn:aws:iam::${config.account}:role/${NAME_PREFIX}-microvm-execution` as const;
export const guestExecutionRoleArn = `arn:aws:iam::${config.account}:role/${NAME_PREFIX}-microvm-guest` as const;

export const ingressConnectorArn = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
export const egressConnectorArn = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
