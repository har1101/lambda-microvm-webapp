import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { config, egressConnectorArn, executionRoleArn, imageArn, ingressConnectorArn } from './config';

const microvmSourceArn = `arn:aws:lambda:${config.microvmRegion}:${config.account}:microvm-image:*` as const;

function hardenMicrovmRoleTrust(role: iam.Role): void {
  const cfnRole = role.node.defaultChild as iam.CfnRole;
  cfnRole.assumeRolePolicyDocument = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        Condition: {
          StringEquals: { 'aws:SourceAccount': config.account },
          ArnLike: { 'aws:SourceArn': microvmSourceArn },
        },
      },
    ],
  };
}

export class OmpCloudIdeMicrovmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const authKey = new kms.Key(this, 'AuthStateKey', {
      alias: 'alias/omp-cloud-ide-auth-state',
      description: 'Encrypts persisted OMP and GitHub OAuth state',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const authBucket = new s3.Bucket(this, 'AuthStateBucket', {
      bucketName: config.authState.bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: authKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const imageLogGroup = new logs.LogGroup(this, 'MicrovmLogGroup', {
      logGroupName: `/aws/lambda-microvms/${config.imageName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      // Keep failed build output available when cdkd rolls back a new stack.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtectionEnabled: true,
    });

    const codeArtifact = new s3assets.Asset(this, 'CodeArtifact', {
      path: path.join(__dirname, '..', config.artifactDir),
      exclude: ['**/__pycache__/**', '**/*.pyc'],
    });

    const buildRole = new iam.Role(this, 'MicrovmBuildRole', {
      roleName: 'omp-cloud-ide-microvm-build',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Build-only role for the OMP Lambda MicroVM image',
    });
    hardenMicrovmRoleTrust(buildRole);
    codeArtifact.grantRead(buildRole);
    imageLogGroup.grantWrite(buildRole);

    const executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
      roleName: 'omp-cloud-ide-microvm-execution',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Runtime role scoped to encrypted Cloud IDE auth state',
    });
    hardenMicrovmRoleTrust(executionRole);
    authBucket.grantReadWrite(executionRole, `${config.authState.prefix}/*`);
    imageLogGroup.grantWrite(executionRole);

    const microvmImage = new cdk.CfnResource(this, 'MicrovmImage', {
      type: 'AWS::Lambda::MicrovmImage',
      properties: {
        Name: config.imageName,
        Description: config.imageDescription,
        BaseImageArn: config.baseImageArn,
        BaseImageVersion: config.baseImageVersion,
        BuildRoleArn: buildRole.roleArn,
        CodeArtifact: { Uri: codeArtifact.s3ObjectUrl },
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        AdditionalOsCapabilities: [],
        EgressNetworkConnectors: [egressConnectorArn(config.microvmRegion)],
        EnvironmentVariables: [
          { Key: 'AUTH_STATE_BUCKET', Value: authBucket.bucketName },
          { Key: 'AUTH_STATE_PREFIX', Value: config.authState.prefix },
          { Key: 'AUTH_SYNC_INTERVAL_SECONDS', Value: String(config.authState.syncIntervalSeconds) },
          { Key: 'PI_CODING_AGENT_DIR', Value: '/home/vscode/.omp/agent' },
        ],
        Hooks: {
          Port: 9000,
          MicrovmImageHooks: {
            Ready: 'ENABLED',
            ReadyTimeoutInSeconds: 120,
            Validate: 'ENABLED',
            ValidateTimeoutInSeconds: 30,
          },
          MicrovmHooks: {
            Run: 'ENABLED',
            RunTimeoutInSeconds: 30,
            Resume: 'ENABLED',
            ResumeTimeoutInSeconds: 10,
            Suspend: 'ENABLED',
            SuspendTimeoutInSeconds: 45,
            Terminate: 'ENABLED',
            TerminateTimeoutInSeconds: 45,
          },
        },
        Resources: [{ MinimumMemoryInMiB: config.minimumMemoryInMiB }],
        Logging: { CloudWatch: { LogGroup: imageLogGroup.logGroupName } },
      },
    });
    microvmImage.node.addDependency(codeArtifact, buildRole, imageLogGroup);

    new cdk.CfnOutput(this, 'MicrovmImageArn', {
      value: imageArn,
      description: 'Lambda MicroVM image ARN used by the edge control plane',
    });
    new cdk.CfnOutput(this, 'MicrovmExecutionRoleArn', {
      value: executionRole.roleArn,
      description: 'Least-privilege role assumed inside a running MicroVM',
    });
    new cdk.CfnOutput(this, 'AuthStateBucketName', {
      value: authBucket.bucketName,
      description: 'KMS-encrypted bucket that persists OAuth state',
    });
  }
}

export class OmpCloudIdeEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const accessPassword = new secretsmanager.Secret(this, 'AccessPassword', {
      secretName: config.edge.accessSecretName,
      description: 'HTTP Basic password checked before a MicroVM can be started',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    const table = new dynamodb.Table(this, 'SessionsTable', {
      tableName: config.edge.tableName,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const edgeRole = new iam.Role(this, 'EdgeRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com'),
      ),
      description: 'Starts and proxies only the personal OMP MicroVM image',
    });
    edgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:RunMicrovm'],
        resources: [imageArn],
      }),
    );
    edgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:CreateMicrovmAuthToken'],
        resources: [`arn:aws:lambda:${config.microvmRegion}:${config.account}:microvm:*`],
      }),
    );
    edgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:PassNetworkConnector'],
        resources: [ingressConnectorArn(config.microvmRegion), egressConnectorArn(config.microvmRegion)],
      }),
    );
    edgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [executionRoleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
      }),
    );
    table.grant(edgeRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    accessPassword.grantRead(edgeRole);
    edgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:*:${config.account}:log-group:/aws/lambda/*`],
      }),
    );

    const edgeAssetDir = path.join(__dirname, '..', 'artifact', 'edge');
    this.writeEdgeConfig(edgeAssetDir, {
      MVM_REGION: config.microvmRegion,
      TABLE_REGION: config.edgeRegion,
      TABLE: config.edge.tableName,
      IMAGE_ARN: imageArn,
      EXECUTION_ROLE_ARN: executionRoleArn,
      INGRESS: ingressConnectorArn(config.microvmRegion),
      EGRESS: egressConnectorArn(config.microvmRegion),
      // Lambda@Edge does not support environment variables. Embed the stable
      // secret name instead of an unresolved CDK token so asset hashes remain
      // deterministic and Secrets Manager resolves the current ARN at runtime.
      AUTH_SECRET_ID: config.edge.accessSecretName,
      AUTH_SECRET_REGION: config.edgeRegion,
      BASIC_AUTH_USERNAME: config.edge.basicAuthUsername,
      TOKEN_DURATION_MIN: config.edge.tokenDurationMin,
      TOKEN_REFRESH_THRESHOLD: config.edge.tokenRefreshThresholdMin,
      MAX_DURATION_SEC: config.edge.maxDurationSec,
      IDLE_SEC: config.edge.idleSec,
      SUSPENDED_SEC: config.edge.suspendedSec,
    });

    const edgeFn = new lambda.Function(this, 'EdgeFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(edgeAssetDir, {
        bundling: {
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: ['bash', '-c', 'cp -r /asset-input/. /asset-output && cd /asset-output && npm ci --omit=dev'],
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(`cp -r "${edgeAssetDir}/." "${outputDir}" && cd "${outputDir}" && npm ci --omit=dev`, {
                  stdio: 'inherit',
                });
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      role: edgeRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Authenticates users and routes CloudFront to a Lambda MicroVM',
    });

    const edgeResponseRole = new iam.Role(this, 'EdgeResponseRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com'),
      ),
    });
    edgeResponseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:*:${config.account}:log-group:/aws/lambda/*`],
      }),
    );

    const edgeResponseFn = new lambda.Function(this, 'EdgeResponseFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'artifact', 'edge-response')),
      role: edgeResponseRole,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'Recovers browser sessions after a MicroVM expires',
    });

    // Lambda@Edge replicates published versions to edge regions. AWS rejects
    // immediate deletion while those replicas exist, so version replacements
    // must leave the retired physical versions in place for later cleanup.
    const edgeVersion = edgeFn.currentVersion;
    const edgeResponseVersion = edgeResponseFn.currentVersion;
    edgeVersion.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    edgeResponseVersion.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: config.imageDescription,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: new origins.HttpOrigin('example.com', {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
          readTimeout: cdk.Duration.seconds(60),
          keepaliveTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        edgeLambdas: [
          {
            functionVersion: edgeVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            includeBody: false,
          },
          {
            functionVersion: edgeResponseVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
            includeBody: false,
          },
        ],
      },
    });

    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Open this URL and authenticate with the configured Basic Auth user',
    });
    new cdk.CfnOutput(this, 'AccessPasswordSecretArn', {
      value: accessPassword.secretArn,
      description: 'Reveal this value manually in Secrets Manager when signing in',
    });
    new cdk.CfnOutput(this, 'BasicAuthUsername', {
      value: config.edge.basicAuthUsername,
    });
    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: table.tableName,
    });
  }

  private writeEdgeConfig(dir: string, cfg: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  }
}
