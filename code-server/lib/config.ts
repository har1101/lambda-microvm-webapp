const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT;

if (!ACCOUNT) {
  throw new Error('CDK_DEFAULT_ACCOUNT is required. Run with an authenticated AWS profile.');
}

const MICROVM_REGION = 'ap-northeast-1';
const EDGE_REGION = 'us-east-1';

export const config = {
  account: ACCOUNT,
  microvmRegion: MICROVM_REGION,
  edgeRegion: EDGE_REGION,
  microvmStackName: 'OmpCloudIdeMicrovmStack',
  edgeStackName: 'OmpCloudIdeEdgeStack',
  // One MicroVM image per baseline size: RunMicrovm cannot override memory, and
  // disk scales with it (https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html#microvms-images-sizing).
  // The first entry is the chooser default. Every image builds from the same artifact.
  // `roles` lists the Cognito roles (see edge.groups) allowed to start the size.
  sizes: [
    {
      id: '2gb',
      imageName: 'omp-cloud-ide',
      minimumMemoryInMiB: 2048,
      label: '2 GB / 1 vCPU (peak 8 GB / 4 vCPU), disk 8 GB',
      roles: ['admin', 'guest'],
    },
    {
      id: '4gb',
      imageName: 'omp-cloud-ide-4gb',
      minimumMemoryInMiB: 4096,
      label: '4 GB / 2 vCPU (peak 16 GB / 8 vCPU), disk 16 GB, 2x baseline cost',
      roles: ['admin', 'guest'],
    },
    {
      id: '8gb',
      imageName: 'omp-cloud-ide-8gb',
      minimumMemoryInMiB: 8192,
      label: '8 GB / 4 vCPU (peak 32 GB / 16 vCPU), disk 32 GB, 4x baseline cost',
      roles: ['admin'],
    },
  ],
  imageDescription: 'Personal OMP cloud IDE on Lambda MicroVM',
  baseImageArn: `arn:aws:lambda:${MICROVM_REGION}:aws:microvm-image:al2023-1`,
  baseImageVersion: '1',
  artifactDir: 'artifact/base-image',
  authState: {
    bucketName: `omp-cloud-ide-auth-${ACCOUNT}-${MICROVM_REGION}`,
    prefix: 'personal',
    syncIntervalSeconds: 300,
    noncurrentVersionRetentionDays: 30,
    noncurrentVersionsToRetain: 10,
  },
  edge: {
    tableName: 'omp-cloud-ide-sessions',
    authTableName: 'omp-cloud-ide-auth-sessions',
    // Cognito group per role. Users in neither group cannot sign in. Admins get
    // the shared OAuth state and see every session; guests get neither.
    groups: { admin: 'admins', guest: 'guests' },
    // Lambda@Edge cannot read stack outputs or environment variables, so the
    // generated User Pool/Client IDs are published under this stable name.
    cognitoParameterName: '/omp-cloud-ide/cognito',
    cognitoDomainPrefix: `omp-cloud-ide-${ACCOUNT}`,
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
export const executionRoleArn = `arn:aws:iam::${config.account}:role/omp-cloud-ide-microvm-execution` as const;
export const guestExecutionRoleArn = `arn:aws:iam::${config.account}:role/omp-cloud-ide-microvm-guest` as const;

export const ingressConnectorArn = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
export const egressConnectorArn = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
