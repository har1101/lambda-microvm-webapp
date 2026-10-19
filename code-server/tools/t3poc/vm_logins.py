"""Minimal OAuth login snapshots. Secrets leave the guest only on explicit capture."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import stat
import tarfile
from pathlib import Path

from vm_fs import secure_write, guest_owner

ROOTS = {'claude': Path('/dev/shm/claude'), 'codex': Path('/dev/shm/codex')}
ALLOWED = set(ROOTS.values())
MAX_BYTES = 256 * 1024
STATE_KEYS = ('oauthAccount', 'hasCompletedOnboarding', 'lastOnboardingVersion')
ACCOUNT_KEYS = ('accountUuid', 'emailAddress', 'organizationUuid', 'displayName')


class LoginRejected(Exception):
    pass


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def object_json(data):
    value = json.loads(data)
    if not isinstance(value, dict):
        raise LoginRejected()
    return value


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def minimal_files(kind, files):
    """Structural validation only; never call a provider or inspect token claims."""
    if kind == 'codex':
        if set(files) != {'auth.json'}:
            raise LoginRejected()
        auth = object_json(files['auth.json'])
        tokens = auth.get('tokens')
        if not isinstance(tokens, dict) or not all(nonempty(tokens.get(k)) for k in ('access_token', 'refresh_token', 'id_token')):
            raise LoginRejected()
        if auth.get('auth_mode') not in (None, 'chatgpt'):
            raise LoginRejected()
        # Preserve refresh metadata and account binding used by Codex.
        return {'auth.json': json_bytes(auth)}
    if kind != 'claude' or set(files) != {'.credentials.json', '.claude.json'}:
        raise LoginRejected()
    credentials = object_json(files['.credentials.json'])
    oauth = credentials.get('claudeAiOauth')
    if not isinstance(oauth, dict) or not all(nonempty(oauth.get(k)) for k in ('accessToken', 'refreshToken')):
        raise LoginRejected()
    state = object_json(files['.claude.json'])
    account = state.get('oauthAccount')
    if not isinstance(account, dict) or not nonempty(account.get('accountUuid')):
        raise LoginRejected()
    # Headless OAuth login can succeed before interactive onboarding completes.
    # Preserve its actual value (or absence), rather than inventing completion.
    if 'hasCompletedOnboarding' in state and not isinstance(state['hasCompletedOnboarding'], bool):
        raise LoginRejected()
    minimal = {key: state[key] for key in STATE_KEYS if key in state}
    minimal['oauthAccount'] = {key: account[key] for key in ACCOUNT_KEYS if key in account}
    return {'.credentials.json': json_bytes({'claudeAiOauth': oauth}), '.claude.json': json_bytes(minimal)}


def pack(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def validate_login(blob, kind):
    if len(blob) > MAX_BYTES:
        raise LoginRejected()
    files = {}
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:') as archive:
        for member in archive.getmembers():
            if not member.isfile() or member.name in files or member.size > MAX_BYTES:
                raise LoginRejected()
            if member.name not in ('auth.json', '.credentials.json', '.claude.json'):
                raise LoginRejected()
            files[member.name] = archive.extractfile(member).read()
    return minimal_files(kind, files)


def read_file(root, name):
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, 'rb') as stream:
            st = os.fstat(stream.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > MAX_BYTES:
                raise LoginRejected()
            data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise LoginRejected()
            return data
    finally:
        os.close(directory)


def snapshot(kind, root=None):
    root = root or ROOTS[kind]
    names = ('auth.json',) if kind == 'codex' else ('.credentials.json', '.claude.json')
    return pack(minimal_files(kind, {name: read_file(root, name) for name in names}))


def extract_login(dest, blob, allowed=None, kind=None):
    root = Path(os.path.abspath(dest))
    if root not in (allowed or ALLOWED):
        raise LoginRejected()
    files = validate_login(blob, kind or root.name)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        owner = guest_owner(root)
        if owner is not None:
            os.fchown(directory, *owner)
        os.fchmod(directory, 0o700)
    finally:
        os.close(directory)
    for name, data in files.items():
        secure_write(root, name, data)
    # Existing directories may have been created with 0755 by a CLI.
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def main(argv):
    import sys
    try:
        command = argv[1]
        if command == 'validate':
            validate_login(sys.stdin.buffer.read(MAX_BYTES + 1), argv[2])
            print('T3POC_LOGIN_TAR_OK')
        elif command == 'normalize':
            files = validate_login(sys.stdin.buffer.read(MAX_BYTES + 1), argv[2])
            print(base64.b64encode(pack(files)).decode())
        elif command == 'extract':
            extract_login(Path(argv[2]), Path(argv[3]).read_bytes())
            print('T3POC_LOGIN_OK')
        else:
            action, kind = command.split('-', 1)
            if action not in ('probe', 'capture') or kind not in ROOTS:
                raise LoginRejected()
            try:
                blob = snapshot(kind)
            except (FileNotFoundError, LoginRejected):
                print('T3POC_LOGIN_EMPTY')
                return 0
            digest = hashlib.sha256(blob).hexdigest()
            if action == 'probe':
                print('T3POC_LOGIN_HASH ' + digest)
            else:
                expected = Path(argv[2]).read_text().strip()
                if digest != expected:
                    raise LoginRejected()
                print('T3POC_LOGIN_BUNDLE ' + base64.b64encode(blob).decode())
        return 0
    except Exception:
        # No filenames, parse errors, token contents, or tracebacks in diagnostics.
        print('T3POC_LOGIN_REJECTED')
        return 2


if __name__ == '__main__':
    import sys
    raise SystemExit(main(sys.argv))
