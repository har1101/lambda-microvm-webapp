#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { config } from '../lib/config';
import { OmpCloudIdeEdgeStack, OmpCloudIdeMicrovmStack } from '../lib/lambda-microvm-stack';

const app = new cdk.App();

const microvmStack = new OmpCloudIdeMicrovmStack(app, config.microvmStackName, {
  env: {
    account: config.account,
    region: config.microvmRegion,
  },
  description: 'Tokyo-region Lambda MicroVM image and encrypted OAuth state',
});

const edgeStack = new OmpCloudIdeEdgeStack(app, config.edgeStackName, {
  env: {
    account: config.account,
    region: config.edgeRegion,
  },
  description: 'CloudFront, Lambda@Edge authentication, and IDE session control plane',
});

edgeStack.addStackDependency(microvmStack);
