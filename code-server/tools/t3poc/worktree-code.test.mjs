import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withWorktrees } from './worktree-code.mjs';

test('portable Python modules run in the real transport layout without image-installed helpers', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-module-'));
  try {
    fs.copyFileSync(new URL('./vm_fs.py', import.meta.url), path.join(folder, 'vm_fs.py'));
    const hasHistory = fs.existsSync(new URL('./vm_history.py', import.meta.url));
    const source = `import pathlib, tempfile
from vm_worktrees import restore_pending
${hasHistory ? 'from vm_history import build_split, check_tar, scan_bytes' : 'scan_bytes = lambda *args: None'}
with tempfile.TemporaryDirectory() as name:
 root = pathlib.Path(name).resolve()
 ${hasHistory ? 'blob, pairing = build_split(root, root / "scratch", root / "workspace"); check_tar(blob)' : 'pass'}
 restore_pending(root, root / "workspace", scan_bytes)
print('MODULES_OK')`;
    fs.writeFileSync(path.join(folder, 'run.py'), withWorktrees(source, { history: hasHistory }));
    const env = { ...process.env };
    delete env.PYTHONPATH;
    const result = spawnSync('python3.14', [path.join(folder, 'run.py')], {
      cwd: folder,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /MODULES_OK/);
    assert.equal(fs.existsSync(path.join(folder, 'vm_history.py')), false);
    assert.equal(fs.existsSync(path.join(folder, 'vm_worktrees.py')), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
