import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AssetProps } from 'aws-cdk-lib/aws-s3-assets';
import { AssetHashType, DockerImage } from 'aws-cdk-lib/core';

const CMD = 'CMD ["/usr/local/bin/start-cloud-ide"]';

/** Keep the shared image untouched; only the PoC copy receives this overlay. */
export function assembleT3pocImage(baseDir: string, overlayDir: string, outputDir: string): void {
  fs.cpSync(baseDir, outputDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== '__pycache__' && !src.endsWith('.pyc'),
  });
  const snippet = fs.readFileSync(path.join(overlayDir, 'python.dockerfile'), 'utf8').trim();
  const dockerfilePath = path.join(outputDir, 'Dockerfile');
  const base = fs.readFileSync(dockerfilePath, 'utf8');
  if (!base.includes(CMD)) throw new Error('base Dockerfile is missing its CMD');
  fs.writeFileSync(
    dockerfilePath,
    base.replace(CMD, () => `${snippet}\n\n${CMD}`),
  );
}

export function t3pocAssetOptions(baseDir: string, overlayDir: string): AssetProps {
  return {
    path: overlayDir,
    // baseDir is outside path: hash the complete generated context, not just the overlay.
    assetHashType: AssetHashType.OUTPUT,
    bundling: {
      image: DockerImage.fromRegistry('public.ecr.aws/docker/library/node:22-bookworm-slim'),
      local: {
        tryBundle(outputDir: string) {
          assembleT3pocImage(baseDir, overlayDir, outputDir);
          return true;
        },
      },
    },
  };
}
