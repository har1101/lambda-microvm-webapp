import base64
import errno
import io
import os
import re
import tempfile
import shutil
import tomllib
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import vm_resources as resources
from vm_fs import secure_write


class Resources(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def capacity(self, free):
        return types.SimpleNamespace(f_blocks=64*1024, f_bavail=free*1024, f_frsize=1024)

    def test_64mib_reserve_and_transfer_peak(self):
        with patch('os.statvfs', return_value=self.capacity(24)):
            self.assertEqual(resources.require_space(self.root, 16*resources.MIB)['total'], 64*resources.MIB)
            with self.assertRaises(ValueError): resources.require_space(self.root, 17*resources.MIB)
        with patch('os.statvfs', return_value=self.capacity(7)):
            self.assertTrue(resources.usage(self.root)['warning'])
            with self.assertRaises(ValueError): resources.require_space(self.root)

    def test_worktree_budget_counts_ignored_files_without_reading_them(self):
        folder = self.root / 't3/worktrees/repo/thread/node_modules'
        folder.mkdir(parents=True)
        with (folder / 'large').open('wb') as stream: stream.truncate(9*resources.MIB)
        with self.assertRaisesRegex(ValueError, 'budget'): resources.require_space(self.root)

    def test_cleanup_only_removes_exact_regular_trace_and_stdout_files(self):
        logs = self.root / 't3/userdata/logs'
        logs.mkdir(parents=True)
        for name in ['server.trace.ndjson', 'server.trace.ndjson.1', 'server.trace.ndjson.4']:
            (logs/name).write_bytes(b'x')
        unrelated = logs/'keep'; unrelated.write_bytes(b'keep')
        auth = self.root/'gh-token'; auth.write_bytes(b'synthetic-original')
        resources.clean_logs(self.root)
        self.assertEqual(unrelated.read_bytes(), b'keep')
        self.assertEqual(auth.read_bytes(), b'synthetic-original')
        (logs/'server.trace.ndjson').symlink_to(auth)
        with self.assertRaises(ValueError): resources.clean_logs(self.root)
        self.assertEqual(auth.read_bytes(), b'synthetic-original')

    def test_real_codex_disables_catalog_and_preserves_auth_history_and_other_config(self):
        self.assertIsNotNone(shutil.which('codex'))
        codex = self.root / 'codex'; codex.mkdir()
        (codex / 'config.toml').write_text('model = "gpt-6.1-sol"\n[features]\nremote_plugin = true\n')
        for name in ['auth.json', 'sessions/history.jsonl', 'cache/remote_plugin_catalog/keep.json']:
            path = codex / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'synthetic-original')
        resources.disable_remote_catalog(self.root)
        config = tomllib.loads((codex / 'config.toml').read_text())
        self.assertFalse(config['features']['remote_plugin'])
        self.assertEqual(config['model'], 'gpt-6.1-sol')
        for name in ['auth.json', 'sessions/history.jsonl', 'cache/remote_plugin_catalog/keep.json']:
            self.assertEqual((codex / name).read_bytes(), b'synthetic-original')
        resources.disable_remote_catalog(self.root)
        self.assertFalse(tomllib.loads((codex / 'config.toml').read_text())['features']['remote_plugin'])

    def test_catalog_policy_rejects_links_before_invoking_codex(self):
        codex = self.root / 'codex'; codex.mkdir()
        auth = codex / 'auth.json'; auth.write_bytes(b'synthetic-original')
        config = codex / 'config.toml'; config.symlink_to(auth)
        with patch('vm_resources.subprocess.run') as run:
            with self.assertRaises(OSError): resources.disable_remote_catalog(self.root)
            run.assert_not_called()
        config.unlink(); os.link(auth, config)
        with patch('vm_resources.subprocess.run') as run:
            with self.assertRaises(ValueError): resources.disable_remote_catalog(self.root)
            run.assert_not_called()
        self.assertEqual(auth.read_bytes(), b'synthetic-original')

    def failing_fdopen(self):
        original = os.fdopen
        class Partial:
            def __init__(self, stream): self.stream = stream
            def __getattr__(self, name): return getattr(self.stream, name)
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def write(self, data):
                self.stream.write(data[:max(1, len(data)//2)])
                self.stream.flush()
                raise OSError(errno.ENOSPC, 'synthetic full tmpfs')
        return lambda *a, **kw: Partial(original(*a, **kw))

    def test_partial_enospc_snapshot_write_keeps_existing_file_and_cleans_temp(self):
        target = self.root/'snapshot'; target.write_bytes(b'old complete snapshot')
        with patch('os.fdopen', self.failing_fdopen()):
            with self.assertRaises(OSError): secure_write(self.root, 'snapshot', b'new partial snapshot')
        self.assertEqual(target.read_bytes(), b'old complete snapshot')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['snapshot'])

    def test_real_gh_token_writer_preserves_previous_token_on_enospc(self):
        source = (Path(__file__).parent/'ghapp.mjs').read_text()
        program = re.search(r'const program = `([\s\S]*?)`;', source).group(1)
        program = program.replace('/dev/shm', str(self.root))
        target = self.root/'gh-token'; target.write_bytes(b'synthetic-old')
        stdin = types.SimpleNamespace(buffer=io.BytesIO(base64.b64encode(b'synthetic-new')+b'\n'))
        with patch('os.fdopen', self.failing_fdopen()), patch('sys.stdin', stdin):
            with self.assertRaises(OSError): exec(compile(program, 'gh-token-writer', 'exec'), {})
        self.assertEqual(target.read_bytes(), b'synthetic-old')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['gh-token'])


if __name__ == '__main__': unittest.main()
