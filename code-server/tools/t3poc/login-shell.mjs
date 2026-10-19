import fs from 'node:fs';
import { SHELL_DONE, VM_PYTHON } from './vm-shell.mjs';

const FS_SOURCE = fs.readFileSync(new URL('./vm_fs.py', import.meta.url), 'utf8');
const encoded = (value) =>
  Buffer.from(value)
    .toString('base64')
    .match(/.{1,76}/g)
    ?.join('\n') ?? '';

export function loginInvocation(source, command, payload, dest) {
  if (!/^(extract|(?:probe|capture)-(?:claude|codex))$/.test(command)) throw new Error('invalid login command');
  if (command === 'extract' && !['/dev/shm/claude', '/dev/shm/codex'].includes(dest))
    throw new Error('invalid login destination');
  // Force vm-shell's existing acknowledged raw receiver even for tiny payloads.
  // This public padding contains no credential data and keeps shared files unchanged.
  const lines = [
    'set +x',
    `#${'login-transfer '.repeat(1300)}`,
    '(set -eu',
    'umask 077',
    'task=$(mktemp -d /dev/shm/t3poc-login.XXXXXXXX)',
    'trap \'rm -rf "$task"\' EXIT',
    'base64 -d > "$task/run.py" << \'PY\'',
    encoded(source),
    'PY',
    'base64 -d > "$task/vm_fs.py" << \'FS\'',
    encoded(FS_SOURCE),
    'FS',
  ];
  if (payload) lines.push('base64 -d > "$task/payload" << \'DATA\'', encoded(payload), 'DATA');
  // Root performs descriptor-relative ownership repair; all paths are fixed.
  lines.push(
    `${VM_PYTHON} "$task/run.py" ${command}${dest ? ` ${dest}` : ''}${payload ? ' "$task/payload"' : ''}`,
    ')',
    `echo ${SHELL_DONE}`,
  );
  return lines.join('\n');
}
