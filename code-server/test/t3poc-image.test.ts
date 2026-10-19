import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from '../lib/config';
import { assembleT3pocImage } from '../lib/t3poc-image';

const root = path.join(__dirname, '..');

test('shared base image has no t3poc git identity; T3_POC_ONLY uses t3poc-image', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'artifact', 'base-image', 'Dockerfile'), 'utf8');
  expect(dockerfile).not.toContain('user.name haruki-fukuchi');
  expect(dockerfile).not.toContain('GH_HOST=ai-native-factory-ltd.ghe.com');
  expect(config.artifactDir).toBe('artifact/base-image');

  const source = fs.readFileSync(path.join(root, 'lib', 'config.ts'), 'utf8');
  expect(source).toContain("artifactDir: T3_POC_ONLY ? 'artifact/t3poc-image' : 'artifact/base-image'");

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-image-'));
  assembleT3pocImage(path.join(root, 'artifact', 'base-image'), path.join(root, 'artifact', 't3poc-image'), out);
  const assembled = fs.readFileSync(path.join(out, 'Dockerfile'), 'utf8');
  expect(assembled).toContain('git config --global user.name haruki-fukuchi');
  expect(assembled).toContain('export GH_HOST=ai-native-factory-ltd.ghe.com');
  expect(assembled).toContain('if [ -s /dev/shm/gh-token ]');
  expect(assembled).toContain('COPY lifecycle.py /opt/cloud-ide/lifecycle.py');
  expect(fs.readFileSync(path.join(root, 'artifact', 'base-image', 'Dockerfile'), 'utf8')).not.toContain(
    'haruki-fukuchi',
  );
  expect(fs.existsSync(path.join(out, '__pycache__'))).toBe(false);

  const dirty = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-dirty-'));
  fs.cpSync(path.join(root, 'artifact', 'base-image'), dirty, { recursive: true });
  fs.mkdirSync(path.join(dirty, '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(dirty, '__pycache__', 'x.pyc'), 'pyc');
  fs.writeFileSync(path.join(dirty, 'note.pyc'), 'pyc');
  const cleaned = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-clean-'));
  assembleT3pocImage(dirty, path.join(root, 'artifact', 't3poc-image'), cleaned);
  expect(fs.existsSync(path.join(cleaned, '__pycache__'))).toBe(false);
  expect(fs.existsSync(path.join(cleaned, 'note.pyc'))).toBe(false);
  expect(fs.existsSync(path.join(cleaned, 'lifecycle.py'))).toBe(true);

  const child = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '-e',
      "import { config } from './lib/config.ts'; if (config.artifactDir !== 'artifact/t3poc-image') process.exit(1)",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        T3_POC_ONLY: '1',
        CDK_DEFAULT_ACCOUNT: '123456789012',
        CDKD_STATE_BUCKET: 't3poc-cdkd-state-123456789012',
      },
      encoding: 'utf8',
    },
  );
  expect(child.status).toBe(0);
});
