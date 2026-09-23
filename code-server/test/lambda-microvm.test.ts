import * as fs from 'node:fs';
import * as path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { OmpCloudIdeEdgeStack, OmpCloudIdeMicrovmStack } from '../lib/lambda-microvm-stack';

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

  test('authenticates at Lambda@Edge before exposing the IDE', async () => {
    const app = new cdk.App();
    const stack = new OmpCloudIdeEdgeStack(app, 'TestEdge', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          LambdaFunctionAssociations: Match.arrayWith([
            Match.objectLike({ EventType: 'origin-request', IncludeBody: false }),
            Match.objectLike({ EventType: 'origin-response', IncludeBody: false }),
          ]),
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

  test('pins OMP and runs code-server as an unprivileged user', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'artifact', 'base-image', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('ARG OMP_VERSION=18.2.11');
    expect(dockerfile).toContain('useradd --uid 1000');
    expect(dockerfile).toContain('USER vscode');
    expect(dockerfile).not.toContain('useradd -o -u 0');
  });
});
