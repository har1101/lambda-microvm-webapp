const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const timer = require('./session-timer');
const gitView = require('./git-status');

// Written by /opt/cloud-ide/lifecycle.py when the /run hook delivers the Edge deadline.
const SESSION_FILE = path.join(os.homedir(), '.cache', 'omp-cloud-ide', 'session.json');
// Written by lifecycle.py after every restore/save attempt.
const AUTH_SYNC_FILE = path.join(os.homedir(), '.cache', 'omp-cloud-ide', 'auth-sync.json');
const SYNC_INTERVAL_MS = Math.max(60, Number(process.env.AUTH_SYNC_INTERVAL_SECONDS) || 300) * 1000;
const TICK_MS = 15_000;
const CLOCK_SYNC_MS = 60_000;
const WORKSPACE_DIR = path.join(os.homedir(), 'workspace');
// Repositories are usually cloned directly under the workspace; allow one grouping level.
const GIT_SCAN_DEPTH = 2;
const GIT_REFRESH_MS = 60_000;

function activate(context) {
  context.subscriptions.push(
    ...createSuspendControl(),
    createLifetimeCountdown(),
    ...createAuthSyncStatus(),
    ...createWorkspaceGitStatus(),
  );
}

function createSuspendControl() {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = 'OMP Cloud IDE suspend control';
  status.text = '$(debug-pause) Suspend Cloud IDE';
  status.tooltip = 'Open the suspend/resume controls';
  status.command = 'ompCloudIde.openControl';
  status.show();

  // The /run hook records the control URL of the distribution that started
  // this MicroVM; the image itself is not bound to one CloudFront domain.
  let controlUrl = null;
  const readControlUrl = () => fs.readFile(SESSION_FILE, 'utf8').then(timer.parseControlUrl, () => null);
  const openControl = vscode.commands.registerCommand('ompCloudIde.openControl', async () => {
    controlUrl ??= await readControlUrl();
    if (controlUrl === null) {
      void vscode.window.showErrorMessage(
        '制御画面のURLを取得できません。control URLの実行時注入に対応する前に起動したVMか、/run hookが受け取れませんでした。',
      );
      return;
    }
    await vscode.commands.executeCommand('vscode.open', controlUrl);
  });

  // Bind the URL directly to the status bar item once known, so the click
  // opens the tab synchronously within the browser's user gesture.
  const load = async () => {
    controlUrl ??= await readControlUrl();
    if (controlUrl === null) return;
    clearInterval(interval);
    status.command = { command: 'vscode.open', title: 'Open Cloud IDE controls', arguments: [controlUrl] };
  };
  const interval = setInterval(load, TICK_MS);
  void load();

  return [openControl, status, new vscode.Disposable(() => clearInterval(interval))];
}

function createLifetimeCountdown() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  item.name = 'OMP Cloud IDE remaining lifetime';
  item.command = 'workbench.view.scm';
  item.show();

  const timeZone = validTimeZone(vscode.workspace.getConfiguration('ompCloudIde').get('timeZone', 'Asia/Tokyo'));
  const clockUrl = process.env.AWS_REGION
    ? `https://s3.${process.env.AWS_REGION}.amazonaws.com/`
    : 'https://s3.amazonaws.com/';
  const notified = new Set();
  let expiresAt = null;
  let clockOffset = 0;
  let clockSynced = false;
  let lastClockSync = 0;

  async function syncClock() {
    lastClockSync = Date.now();
    const sentAt = Date.now();
    try {
      const response = await fetch(clockUrl, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
      const offset = timer.clockOffsetMs(response.headers.get('date'), sentAt, Date.now());
      if (offset !== null) {
        clockOffset = offset;
        clockSynced = true;
      }
    } catch {
      // Keep the previous offset; the tooltip reports whether one was ever measured.
    }
  }

  async function refresh() {
    if (expiresAt === null) {
      expiresAt = await fs.readFile(SESSION_FILE, 'utf8').then(timer.parseSessionDeadline, () => null);
    }
    if (Date.now() - lastClockSync >= CLOCK_SYNC_MS) {
      await syncClock();
    }
    render();
  }

  function render() {
    if (expiresAt === null) {
      item.text = '$(clock) 残り時間不明';
      item.tooltip =
        'MicroVMの終了予定時刻を取得できません。期限表示に対応する前に起動したVMか、/run hookが期限を受け取れませんでした。';
      item.backgroundColor = undefined;
      return;
    }

    const remaining = expiresAt - (Date.now() + clockOffset);
    const level = timer.severity(remaining);
    item.text = remaining > 0 ? `$(clock) 残り ${timer.formatRemaining(remaining)}` : '$(clock) 寿命到達';
    item.backgroundColor = level === 'normal' ? undefined : new vscode.ThemeColor(`statusBarItem.${level}Background`);
    const endsAt = new Date(expiresAt).toLocaleString('ja-JP', { timeZone, timeZoneName: 'short' });
    const clockNote = clockSynced ? `時計補正 ${Math.round(clockOffset / 1000)}秒` : '時計補正未実施（VM内時計を使用）';
    item.tooltip = `MicroVMはRUNNING/SUSPENDEDを問わず ${endsAt} に終了します（${clockNote}）。クリックでソース管理を開きます。`;

    const due = timer.dueNotification(remaining, notified);
    if (due !== undefined) {
      for (const minutes of timer.NOTIFY_MINUTES) {
        if (minutes >= due) notified.add(minutes);
      }
      void vscode.window
        .showWarningMessage(
          `Cloud IDEのMicroVMは残り約${Math.max(1, Math.floor(remaining / 60_000))}分で終了し、workspaceは失われます。未commit・未pushの変更を確認してください。`,
          'ソース管理を開く',
        )
        .then((choice) => choice && vscode.commands.executeCommand('workbench.view.scm'));
    }
  }

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    refresh()
      .catch((error) => console.error('OMP Cloud IDE countdown refresh failed', error))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const interval = setInterval(tick, TICK_MS);
  // Reconnecting after Resume focuses the window; resync before the next tick.
  const focus = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      lastClockSync = 0;
      tick();
    }
  });

  return new vscode.Disposable(() => {
    clearInterval(interval);
    focus.dispose();
    item.dispose();
  });
}

function createAuthSyncStatus() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  item.name = 'OMP Cloud IDE auth-state sync';
  item.command = 'ompCloudIde.persistAuthState';
  item.show();

  // Guest MicroVMs have nothing to save; clicking must not claim a save to S3.
  let saveable = true;
  const refresh = async () => {
    const status = await fs
      .readFile(AUTH_SYNC_FILE, 'utf8')
      .then(JSON.parse, () => null)
      .catch(() => null);
    const view = timer.describeAuthSync(status, Date.now(), SYNC_INTERVAL_MS);
    saveable = view.saveable !== false;
    item.text = view.text;
    item.tooltip = `OMP/GitHubの認証状態(S3): ${view.detail}`;
    item.command = saveable ? 'ompCloudIde.persistAuthState' : undefined;
    item.backgroundColor =
      view.level === 'normal' ? undefined : new vscode.ThemeColor(`statusBarItem.${view.level}Background`);
  };

  let saving = false;
  const persist = vscode.commands.registerCommand('ompCloudIde.persistAuthState', async () => {
    if (saving) return;
    if (!saveable) {
      void vscode.window.showInformationMessage('このMicroVMでは認証状態を保存しません(ゲスト用)。');
      return;
    }
    saving = true;
    try {
      const { failed, output } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '認証状態をS3へ保存しています…' },
        () =>
          new Promise((resolve) => {
            execFile('/usr/local/bin/persist-auth-state', { timeout: 150_000 }, (error, stdout, stderr) => {
              resolve({ failed: Boolean(error), output: `${stdout}${stderr}`.trim() });
            });
          }),
      );
      if (failed) {
        void vscode.window.showErrorMessage(`認証状態を保存できませんでした。\n${output}`);
      } else {
        void vscode.window.showInformationMessage('認証状態をS3へ保存しました。');
      }
    } finally {
      saving = false;
      await refresh();
    }
  });

  void refresh();
  const interval = setInterval(() => void refresh(), TICK_MS);
  return [persist, item, new vscode.Disposable(() => clearInterval(interval))];
}

// The workspace is lost when the MicroVM ends; Git is the only persistence
// boundary. Surface repositories with uncommitted or unpushed work.
function createWorkspaceGitStatus() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  item.name = 'OMP Cloud IDE unsaved Git work';
  item.command = 'workbench.view.scm';
  item.show();

  const git = (repo, args) =>
    new Promise((resolve) => {
      execFile('git', ['-C', repo, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
        resolve(error ? null : stdout),
      );
    });

  let running = false;
  const refresh = async () => {
    if (running) return;
    running = true;
    try {
      const repos = [];
      for (const dir of await findRepositories(WORKSPACE_DIR, GIT_SCAN_DEPTH)) {
        const porcelain = await git(dir, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']);
        if (porcelain === null) continue;
        // Commits on no remote-tracking ref: catches detached HEAD and deleted upstreams too.
        // Fails (null) before the first commit, when there is nothing to lose.
        const localOnly = Number((await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])) ?? 0);
        repos.push({
          name: path.relative(WORKSPACE_DIR, dir) || '.',
          ...gitView.summarizeRepository(porcelain, localOnly),
        });
      }
      const view = gitView.describeWorkspace(repos);
      item.text = view.text;
      item.tooltip = `${view.detail}\nクリックでソース管理を開きます。`;
      item.backgroundColor =
        view.level === 'normal' ? undefined : new vscode.ThemeColor(`statusBarItem.${view.level}Background`);
    } finally {
      running = false;
    }
  };

  const tick = () => void refresh().catch((error) => console.error('OMP Cloud IDE git status failed', error));
  tick();
  const interval = setInterval(tick, GIT_REFRESH_MS);
  const saved = vscode.workspace.onDidSaveTextDocument(tick);
  const focus = vscode.window.onDidChangeWindowState((state) => state.focused && tick());
  return [item, saved, focus, new vscode.Disposable(() => clearInterval(interval))];
}

/** Directories under root (including root) that contain a `.git` entry, up to `depth` levels down. */
async function findRepositories(root, depth) {
  const found = [];
  const walk = async (dir, level) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === '.git')) {
      found.push(dir);
      return;
    }
    if (level >= depth) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await walk(path.join(dir, entry.name), level + 1);
      }
    }
  };
  await walk(root, 0);
  return found;
}

function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('ja-JP', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
