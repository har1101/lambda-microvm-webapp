import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { App, Stack } from 'aws-cdk-lib/core';
import { config } from '../lib/config';
import { assembleT3pocImage, t3pocAssetOptions } from '../lib/t3poc-image';

const root = path.join(__dirname, '..');
const baseDir = path.join(root, 'artifact/base-image');
const overlayDir = path.join(root, 'artifact/t3poc-image');

test('existing image remains identical to the base; only PoC adds pinned Python 3.14', () => {
  const base = fs.readFileSync(path.join(baseDir, 'Dockerfile'), 'utf8');
  const original = execFileSync('git', ['show', '8ec2787:code-server/artifact/base-image/Dockerfile'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(base).toBe(original);
  expect(config.artifactDir).toBe('artifact/base-image');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-image-'));
  assembleT3pocImage(baseDir, overlayDir, out);
  const assembled = fs.readFileSync(path.join(out, 'Dockerfile'), 'utf8');
  expect(assembled).toContain('uv python install 3.14.4');
  expect(assembled).toContain('/usr/local/bin/python3.14');
  expect(assembled.match(/user.name haruki-fukuchi/g)).toHaveLength(1);
  expect(assembled).toContain('COPY lifecycle.py');
  expect(fs.readFileSync(path.join(out, 'autopush.py'), 'utf8')).toBe(
    fs.readFileSync(path.join(overlayDir, 'autopush.py'), 'utf8'),
  );
  expect(fs.readFileSync(path.join(out, 'start-cloud-ide.sh'), 'utf8')).toContain(
    '/usr/local/bin/python3.14 /opt/cloud-ide/autopush.py &',
  );
  expect(fs.readFileSync(path.join(out, 'start-cloud-ide.sh'), 'utf8')).toContain(
    '/usr/local/bin/python3.14 /opt/cloud-ide/lifecycle.py &',
  );
  expect(fs.readFileSync(path.join(baseDir, 'autopush.py'), 'utf8')).toBe(
    execFileSync('git', ['show', '8ec2787:code-server/artifact/base-image/autopush.py'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );

  expect(fs.readFileSync(path.join(baseDir, 'Dockerfile'), 'utf8')).toBe(base);
});

test('changing external base content changes the PoC asset hash', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-hash-'));
  const base = path.join(tmp, 'base');
  fs.cpSync(baseDir, base, { recursive: true });
  const hash = () => {
    const app = new App({ outdir: fs.mkdtempSync(path.join(tmp, 'out-')) });
    const stack = new Stack(app, 'Test');
    return new Asset(stack, 'Code', t3pocAssetOptions(base, overlayDir)).assetHash;
  };
  const before = hash();
  fs.appendFileSync(path.join(base, 'lifecycle.py'), '\n# regression: external base changed\n');
  expect(hash()).not.toBe(before);
});

test('overlay dollar sequences remain literal Dockerfile content', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-literal-'));
  const overlay = path.join(tmp, 'overlay');
  fs.mkdirSync(overlay);
  fs.writeFileSync(path.join(overlay, 'python.dockerfile'), 'RUN echo "$& $$"');
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out);
  assembleT3pocImage(baseDir, overlay, out);
  expect(fs.readFileSync(path.join(out, 'Dockerfile'), 'utf8')).toContain('RUN echo "$& $$"');
});
