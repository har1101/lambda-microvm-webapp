const vscode = require('vscode');

function activate(context) {
  const rawUrl = vscode.workspace.getConfiguration('ompCloudIde').get('controlUrl', '');
  let controlUrl;
  try {
    controlUrl = new URL(rawUrl);
  } catch {
    controlUrl = undefined;
  }

  const openControl = vscode.commands.registerCommand('ompCloudIde.openControl', async () => {
    if (controlUrl?.protocol !== 'https:') {
      void vscode.window.showErrorMessage('OMP Cloud IDE control URL must be a valid HTTPS URL.');
      return;
    }
    await vscode.commands.executeCommand('vscode.open', controlUrl.toString());
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = 'OMP Cloud IDE suspend control';
  status.text = '$(debug-pause) Suspend Cloud IDE';
  status.tooltip = 'Open the suspend/resume controls';
  status.command =
    controlUrl?.protocol === 'https:'
      ? {
          command: 'vscode.open',
          title: 'Open Cloud IDE controls',
          arguments: [controlUrl.toString()],
        }
      : 'ompCloudIde.openControl';
  status.show();

  context.subscriptions.push(openControl, status);
}

function deactivate() {}

module.exports = { activate, deactivate };
