import fs from 'node:fs';

const WORKTREES = fs.readFileSync(new URL('./vm_worktrees.py', import.meta.url));
const encoded = (source) => Buffer.from(source).toString('base64');

// Extend the existing private-RAM Python transport without changing its shared
// command contract. Modules are loaded from source, never from the image disk.
export function withWorktrees(source, { history = false } = {}) {
  const modules = [
    ['vm_resources', fs.readFileSync(new URL('./vm_resources.py', import.meta.url))],
    ['vm_worktrees', WORKTREES],
  ];
  if (history) modules.push(['vm_history', fs.readFileSync(new URL('./vm_history.py', import.meta.url))]);
  const lines = ['import sys, types, base64'];
  for (const [name, bytes] of modules) {
    lines.push(
      `module = types.ModuleType('${name}')`,
      `sys.modules['${name}'] = module`,
      `exec(compile(base64.b64decode('${encoded(bytes)}'), '${name}.py', 'exec'), module.__dict__)`,
    );
  }
  lines.push(`exec(compile(base64.b64decode('${encoded(source)}'), 'worktree-command.py', 'exec'), globals())`);
  return lines.join('\n');
}
