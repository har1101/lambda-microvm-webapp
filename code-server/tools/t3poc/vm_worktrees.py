"""Portable, credential-free linked-worktree snapshots for T3 history.

Never copy .git, config, hooks, reflogs, or packed/compressed object stores.
Only validated raw reachable objects, index entries, and non-ignored files are
serialized. Any unsupported state fails closed before the old VM is removed.
"""
from __future__ import annotations
import base64
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

from vm_fs import secure_write
from vm_resources import require_space

PREFIX = 't3/worktree-state/'
MAX_STATE_BYTES = 16 * 1024 * 1024
MAX_ITEM_BYTES = 8 * 1024 * 1024
MAX_ITEMS = 100000
HEX = re.compile(r'[0-9a-f]{40}')
NAME = re.compile(r'[A-Za-z0-9._-]+')


def git(repo, *args, data=None, check=True):
    # Do not expose git stderr: remote/config errors can contain credentials.
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    p = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(repo), *args],
                       input=data, capture_output=True, timeout=120, env=env)
    if check and p.returncode:
        raise ValueError('worktree git operation failed: ' + args[0])
    return p.stdout


def component(value):
    if not isinstance(value, str) or not NAME.fullmatch(value) or value in ('.', '..'):
        raise ValueError('invalid worktree path component')
    return value


def snapshot_path(repo, name):
    # Archive names are opaque IDs. A legitimate repo/branch slug containing
    # "token" or "secret" must not collide with the history exclusion policy.
    repo_id = hashlib.sha256(component(repo).encode()).hexdigest()
    worktree_id = hashlib.sha256(component(name).encode()).hexdigest()
    return PREFIX + repo_id + '/' + worktree_id + '.json'


def relpath(value):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ValueError('invalid worktree file path')
    parts = value.split('/')
    if any(p in ('', '.', '..', '.git') for p in parts):
        raise ValueError('unsafe worktree file path')
    return value


def private_path(value, filename=True):
    parts = value.lower().split('/')
    return (filename and (any(word in parts[-1] for word in ('token', 'secret', 'credential', 'password'))
                          or parts[-1].endswith(('.sqlite-wal', '.sqlite-shm', '.db-wal', '.db-shm',
                                                '.sqlite-journal', '.db-journal')))) or any(p in ('.ssh', '.aws', '.codex', '.claude', 'secrets', '.git-credentials', '.gitconfig',
                     'credentials.json', 'auth.json', 'hosts.yml', '.netrc', '_netrc', '.npmrc', '.pypirc',
                     'id_rsa', 'id_ed25519', '.gitmodules') or p == '.env' or p.startswith('.env.')
               for p in parts)


def check_tree(raw):
    offset = 0
    while offset < len(raw):
        end = raw.index(b'\0', offset)
        mode, name = raw[offset:end].split(b' ', 1)
        text = name.decode()
        if '/' in text or text in ('.', '..', '.git') or private_path(text, filename=mode not in (b'40000', b'040000')):
            raise ValueError('private or unsafe path in reachable git history')
        offset = end + 21  # NUL then the SHA-1's 20 raw bytes
        if offset > len(raw):
            raise ValueError('truncated worktree tree object')


def b64(data):
    return base64.b64encode(data).decode('ascii')


def decode(value):
    if not isinstance(value, str) or len(value) > MAX_ITEM_BYTES * 4 // 3 + 8:
        raise ValueError('worktree item too large')
    raw = base64.b64decode(value, validate=True)
    if len(raw) > MAX_ITEM_BYTES:
        raise ValueError('decoded worktree item exceeds size limit')
    return raw


def read_file(path):
    # Inspect the opened inode as well as refusing symlinks. A regular-looking
    # worktree path must not alias an external config/credential via hardlink.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_ITEM_BYTES:
            raise ValueError('unsupported, hardlinked, or oversized worktree file')
        data = stream.read(MAX_ITEM_BYTES + 1)
        if len(data) > MAX_ITEM_BYTES or os.fstat(stream.fileno()).st_nlink != 1:
            raise ValueError('worktree file exceeds size limit or became hardlinked')
    return data


def no_links(path):
    for p in (path, *path.parents):
        if p.is_symlink():
            raise ValueError('worktree path contains a symlink')


def capture(root, workspace, scan):
    require_space(root)
    folder = root / 't3/worktrees'
    if not folder.exists():
        return []
    no_links(folder)
    entries = []
    total = 0
    # Scan actual directories, not git worktree list: deleted/prunable entries
    # must never resurrect. A present but broken .git is an error, not a skip.
    for repo_dir in sorted(folder.iterdir()):
        component(repo_dir.name)
        no_links(repo_dir)
        if not repo_dir.is_dir():
            raise ValueError('unexpected worktree repository entry')
        base = workspace / repo_dir.name
        for wt in sorted(repo_dir.iterdir()):
            component(wt.name)
            no_links(wt)
            if not wt.is_dir():
                raise ValueError('unexpected worktree entry')
            no_links(wt / '.git')
            if not (wt / '.git').exists():
                if any(wt.iterdir()):
                    raise ValueError('worktree directory has no git metadata')
                continue
            no_links(base)
            no_links(base / '.git')
            common = Path(git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip())
            no_links(common)
            if common.resolve() != (base / '.git').resolve():
                raise ValueError('worktree base is outside the configured workspace')
            head = git(wt, 'rev-parse', '--verify', 'HEAD').decode().strip()
            branch = git(wt, 'symbolic-ref', '-q', 'HEAD', check=False).decode().strip() or None
            index = git(wt, 'ls-files', '--stage', '-z')
            index_flags = {}
            for row in git(wt, 'ls-files', '-v', '-z').split(b'\0'):
                if not row:
                    continue
                flag, name = row[:1].decode(), row[2:].decode()
                if flag in ('S', 'h', 's'):
                    index_flags[name] = flag
                elif flag not in ('H', 'M'):
                    raise ValueError('unsupported worktree index flag')
            objects = set(git(wt, 'rev-list', '--objects', '--no-object-names', 'HEAD').decode().splitlines())
            for row in index.split(b'\0'):
                if row:
                    fields, name = row.split(b'\t', 1)
                    mode, oid, stage = fields.decode().split()
                    if mode == '160000':
                        raise ValueError('submodule worktree cannot be snapshotted')
                    objects.add(oid)
            # Batch object inspection bounds both transfer size and process
            # count. Never store Git's opaque pack files in the history tar.
            if len(objects) > MAX_ITEMS:
                raise ValueError('worktree object count limit exceeded')
            query = ('\n'.join(sorted(objects)) + '\n').encode()
            headers = git(wt, 'cat-file', '--batch-check', data=query).decode().splitlines()
            budget = 0
            for header in headers:
                oid, kind, size = header.split()
                budget += int(size)
                if int(size) > MAX_ITEM_BYTES or budget > MAX_STATE_BYTES:
                    raise ValueError('worktree object size limit exceeded')
            packed = io.BytesIO(git(wt, 'cat-file', '--batch', data=query))
            raw_objects = {}
            for _ in headers:
                oid, kind, size = packed.readline().decode().strip().split()
                raw = packed.read(int(size))
                if len(raw) != int(size) or packed.read(1) != b'\n':
                    raise ValueError('incomplete worktree object')
                scan(raw, 'worktree git object')
                if kind == 'tree':
                    check_tree(raw)
                raw_objects[oid] = [kind, b64(raw)]
            files = {}
            tracked = set(git(wt, 'ls-files', '-z').split(b'\0'))
            paths = set(git(wt, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0')) - {b''}
            if len(paths) + len(objects) > MAX_ITEMS:
                raise ValueError('worktree entry count limit exceeded')
            for raw_name in sorted(paths):
                name = relpath(raw_name.decode())
                if private_path(name):
                    if raw_name in tracked:
                        raise ValueError('private tracked worktree path')
                    continue  # never upload untracked login/env/credential files
                path = wt / name
                no_links(path)
                if not path.exists():
                    continue  # unstaged deletion
                raw = read_file(path)
                budget += len(raw)
                if budget > MAX_STATE_BYTES:
                    raise ValueError('worktree size limit exceeded')
                scan(raw, 'worktree file')
                files[name] = [0o755 if path.stat().st_mode & 0o111 else 0o644, b64(raw)]
            shallow_path = Path(git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'shallow').decode().strip())
            shallow = shallow_path.read_text().splitlines() if shallow_path.exists() else []
            state = dict(version=1, repo=repo_dir.name, name=wt.name, head=head, branch=branch,
                         shallow=[s for s in shallow if s in objects], index=b64(index), index_flags=index_flags, objects=raw_objects, files=files)
            blob = json.dumps(state, separators=(',', ':')).encode()
            validate(blob, scan)
            total += len(blob)
            if total > MAX_STATE_BYTES:
                raise ValueError('total worktree snapshot size limit exceeded')
            entries.append((snapshot_path(repo_dir.name, wt.name), blob))
    return entries


def validate(blob, scan):
    if len(blob) > MAX_STATE_BYTES:
        raise ValueError('worktree snapshot size limit exceeded')
    state = json.loads(blob)
    if state.get('version') != 1:
        raise ValueError('unsupported worktree snapshot version')
    component(state['repo']); component(state['name'])
    if not HEX.fullmatch(state['head']):
        raise ValueError('invalid worktree HEAD')
    branch = state['branch']
    if branch is not None and (not isinstance(branch, str) or not branch.startswith('refs/heads/')
                               or subprocess.run(['git', 'check-ref-format', branch], capture_output=True).returncode):
        raise ValueError('invalid worktree branch')
    objects = state['objects']
    if len(objects) + len(state['files']) > MAX_ITEMS:
        raise ValueError('worktree entry count limit exceeded')
    for oid, (kind, encoded) in objects.items():
        if not HEX.fullmatch(oid) or kind not in ('blob', 'tree', 'commit', 'tag'):
            raise ValueError('invalid worktree object')
        raw = decode(encoded)
        scan(raw, 'worktree git object')
        if kind == 'tree':
            check_tree(raw)
        if hashlib.sha1(f'{kind} {len(raw)}\0'.encode() + raw).hexdigest() != oid:
            raise ValueError('worktree object hash mismatch')
    if state['head'] not in objects or objects[state['head']][0] != 'commit':
        raise ValueError('worktree HEAD object missing')
    for oid in state['shallow']:
        if not HEX.fullmatch(oid) or oid not in objects:
            raise ValueError('invalid shallow boundary')
    index = decode(state['index'])
    scan(index, 'worktree index entries')
    index_names = set()
    for row in index.split(b'\0'):
        if not row:
            continue
        fields, raw_name = row.split(b'\t', 1)
        mode, oid, stage = fields.decode().split()
        name = relpath(raw_name.decode())
        index_names.add(name)
        if private_path(name) or mode not in ('100644', '100755', '120000') or stage not in ('0', '1', '2', '3'):
            raise ValueError('unsupported worktree index entry')
        if oid not in objects or objects[oid][0] != 'blob':
            raise ValueError('worktree index object missing')
    flags = state.get('index_flags', {})
    if not isinstance(flags, dict) or len(flags) > len(index_names):
        raise ValueError('invalid worktree index flags')
    for name, flag in flags.items():
        if name not in index_names or flag not in ('S', 'h', 's'):
            raise ValueError('invalid worktree index flag')
    allocation = 0
    directories = set()
    for name, (mode, encoded) in state['files'].items():
        relpath(name)
        if private_path(name) or mode not in (0o644, 0o755):
            raise ValueError('private or unsupported worktree file')
        raw = decode(encoded)
        scan(raw, 'worktree file')
        allocation += max(4096, (len(raw) + 4095) // 4096 * 4096)
        directories.update(Path(name).parents)
    if allocation + len(directories) * 4096 > 8 * 1024 * 1024:
        raise ValueError('restored worktree RAM budget exceeded')
    return state


def restore_pending(root, workspace, scan):
    require_space(root)
    folder = root / PREFIX
    if not folder.exists():
        return
    no_links(folder)
    for entry in sorted(folder.glob('*/*.json')):
        no_links(entry)
        if entry.stat().st_size > MAX_STATE_BYTES:
            raise ValueError("worktree snapshot size limit exceeded")
        state = validate(entry.read_bytes(), scan)
        if entry.relative_to(root).as_posix() != snapshot_path(state['repo'], state['name']):
            raise ValueError('worktree manifest path mismatch')
        base = workspace / state['repo']
        target = root / 't3/worktrees' / state['repo'] / state['name']
        no_links(base); no_links(base / '.git'); no_links(target)
        common = Path(git(base, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip())
        no_links(common)
        if common.resolve() != (base / '.git').resolve():
            raise ValueError('unexpected base git directory')
        digest = hashlib.sha256(entry.read_bytes()).hexdigest().encode()
        if target.exists():
            no_links(target / '.git')
            gitdir = Path(git(target, 'rev-parse', '--absolute-git-dir').decode().strip())
            marker = gitdir / 't3poc-restored-snapshot'
            if gitdir.is_relative_to(common / 'worktrees') and marker.is_file() and marker.read_bytes() == digest:
                entry.unlink()  # crash after atomic move, before manifest removal
                continue
            raise ValueError('refusing to overwrite an existing thread worktree')
        # Import exact objects in at most four Git processes, rather than one
        # process per object (which can exceed the shell deadline for small
        # files even when the archive is comfortably below its size limit).
        with tempfile.TemporaryDirectory(prefix='t3poc-objects-', dir=common) as object_folder:
            scratch = Path(object_folder)
            groups = {}
            for oid, (kind, encoded) in state['objects'].items():
                secure_write(scratch, oid, decode(encoded))
                groups.setdefault(kind, []).append(oid)
            for kind, oids in groups.items():
                paths = ''.join(str(scratch / oid) + '\n' for oid in oids).encode()
                actual = git(base, 'hash-object', '-w', '--no-filters', '-t', kind, '--stdin-paths', data=paths).decode().splitlines()
                if actual != oids:
                    raise ValueError('restored worktree object mismatch')
        shallow = common / 'shallow'
        previous_boundaries = set(shallow.read_text().splitlines() if shallow.exists() else [])
        # Imported commits that were complete in the source no longer need a
        # shallow boundary inherited from the new clone's --depth 1 checkout.
        complete = {oid for oid, item in state['objects'].items()
                    if item[0] == 'commit' and oid not in state['shallow']}
        boundaries = (previous_boundaries - complete) | set(state['shallow'])
        if boundaries:
            secure_write(common, 'shallow', ('\n'.join(sorted(boundaries)) + '\n').encode())
        elif shallow.exists():
            shallow.unlink()
        branch = state['branch']
        if branch:
            current = git(base, 'rev-parse', '--verify', '-q', branch, check=False).decode().strip()
            checked = git(base, 'worktree', 'list', '--porcelain').decode()
            for record in checked.strip().split('\n\n'):
                if ('branch ' + branch) not in record.splitlines():
                    continue
                where = record.splitlines()[0].removeprefix('worktree ')
                # A new clone may have checked out the thread's branch as its
                # default. Detach only a clean base; never move a dirty checkout
                # or another linked worktree behind its owner's back.
                if Path(where).resolve() != base.resolve() or git(base, 'status', '--porcelain'):
                    raise ValueError('restored branch conflicts with an active worktree')
                git(base, 'checkout', '--detach', 'HEAD')
            git(base, 'update-ref', branch, state['head'])
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix='.t3poc-restore-', dir=target.parent))
        temporary.rmdir()
        try:
            git(base, 'worktree', 'add', '--no-checkout', '--detach', str(temporary), state['head'])
            for name, (mode, encoded) in state['files'].items():
                secure_write(temporary, name, decode(encoded))
                (temporary / name).chmod(mode)
            git(temporary, 'update-index', '-z', '--index-info', data=decode(state['index']))
            flags = state.get('index_flags', {})
            for option, enabled in [('--skip-worktree', ('S', 's')), ('--assume-unchanged', ('h', 's'))]:
                names = [name for name, flag in flags.items() if flag in enabled]
                if names:
                    git(temporary, 'update-index', option, '-z', '--stdin',
                        data=b''.join(name.encode() + b'\0' for name in names))
            if branch:
                git(temporary, 'symbolic-ref', 'HEAD', branch)
            gitdir = Path(git(temporary, 'rev-parse', '--absolute-git-dir').decode().strip())
            secure_write(gitdir, 't3poc-restored-snapshot', digest)
            git(base, 'worktree', 'move', str(temporary), str(target))
            # Completion is atomic per worktree. Remove only this consumed
            # manifest, so later readiness retries never overwrite new edits.
            entry.unlink()
        finally:
            if temporary.exists():
                git(base, 'worktree', 'remove', '--force', str(temporary), check=False)
                shutil.rmtree(temporary, ignore_errors=True)


def main():
    from vm_history import scan_worktree_bytes
    restore_pending(Path('/dev/shm'), Path('/home/vscode/workspace'), scan_worktree_bytes)
    print('T3POC_WORKTREES_OK')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        print('T3POC_BACKUP_ABORT worktree restore failed')
        raise SystemExit(2)
