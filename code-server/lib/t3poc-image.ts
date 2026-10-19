import * as fs from 'node:fs';
import * as path from 'node:path';

const CMD = 'CMD ["/usr/local/bin/start-cloud-ide"]';

/** Copy the shared base image and append the t3poc-only git identity / GH_HOST snippet. */
export function assembleT3pocImage(baseDir: string, overlayDir: string, outputDir: string): void {
  fs.cpSync(baseDir, outputDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== '__pycache__' && !src.endsWith('.pyc'),
  });
  const snippetPath = path.join(overlayDir, 'git-identity.dockerfile');
  const snippet = fs.readFileSync(snippetPath, 'utf8').trim();
  if (!snippet.includes('git config --global user.name haruki-fukuchi')) {
    throw new Error(`t3poc overlay ${snippetPath} is missing the git identity`);
  }
  if (!snippet.includes('export GH_HOST=ai-native-factory-ltd.ghe.com')) {
    throw new Error(`t3poc overlay ${snippetPath} is missing GH_HOST`);
  }
  const dockerfilePath = path.join(outputDir, 'Dockerfile');
  const base = fs.readFileSync(dockerfilePath, 'utf8');
  if (base.includes('user.name haruki-fukuchi') || base.includes('GH_HOST=ai-native-factory-ltd.ghe.com')) {
    throw new Error('shared base-image Dockerfile still contains t3poc git identity / GH_HOST');
  }
  if (!base.includes(CMD)) throw new Error('base Dockerfile is missing its CMD');
  const normalized = base.endsWith('\n') ? base : `${base}\n`;
  fs.writeFileSync(dockerfilePath, normalized.replace(CMD, `${snippet}\n\n${CMD}`));
}
