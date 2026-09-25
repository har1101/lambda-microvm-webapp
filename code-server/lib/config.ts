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
  imageName: 'omp-cloud-ide',
  imageDescription: 'Personal OMP cloud IDE on Lambda MicroVM',
  baseImageArn: `arn:aws:lambda:${MICROVM_REGION}:aws:microvm-image:al2023-1`,
  baseImageVersion: '1',
  minimumMemoryInMiB: 2048,
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
    accessSecretName: 'omp-cloud-ide/access-password',
    basicAuthUsername: 'har1101',
    accessCookieName: 'omp-cloud-ide-auth',
    accessCookieMaxAgeSec: 28800,
    tokenDurationMin: 60,
    tokenRefreshThresholdMin: 15,
    maxDurationSec: 28800,
    idleSec: 300,
    suspendedSec: 28800,
  },
} as const;

export const imageArn =
  `arn:aws:lambda:${config.microvmRegion}:${config.account}:microvm-image:${config.imageName}` as const;
export const executionRoleArn = `arn:aws:iam::${config.account}:role/omp-cloud-ide-microvm-execution` as const;

export const ingressConnectorArn = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
export const egressConnectorArn = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
