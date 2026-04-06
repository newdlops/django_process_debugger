import * as vscode from 'vscode';
import { DjangoProcessFinder } from './processFinder';
import { DebugpyInjector } from './debugpyInjector';
import { DjangoDebugSessionFactory } from './debugSession';
import { DiagnosticReporter } from './diagnostics';

export function activate(context: vscode.ExtensionContext) {
  const processFinder = new DjangoProcessFinder();
  const injector = new DebugpyInjector();
  const diagnostics = new DiagnosticReporter();

  const findCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.findDjangoProcesses',
    async () => {
      const processes = await processFinder.findDjangoProcesses();
      if (processes.length === 0) {
        vscode.window.showInformationMessage(
          'No running Django processes found.'
        );
        return [];
      }
      return processes;
    }
  );

  const attachCmd = vscode.commands.registerCommand(
    'djangoProcessDebugger.attachToProcess',
    async () => {
      const processes = await processFinder.findDjangoProcesses();
      if (processes.length === 0) {
        vscode.window.showWarningMessage(
          'No running Django processes found. Start a Django server first.'
        );
        return;
      }

      const items = processes.map((p) => ({
        label: `PID: ${p.pid}`,
        description: p.command,
        detail: `Python: ${p.pythonPath}`,
        process: p,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Django process to attach debugger',
      });

      if (!selected) {
        return;
      }

      const pid = selected.process.pid;
      const port = 5678;

      try {
        await injector.inject(pid, port);
      } catch (err) {
        const message = diagnostics.diagnoseAttachFailure(err, selected.process);
        vscode.window.showErrorMessage(message);
        return;
      }

      await vscode.debug.startDebugging(undefined, {
        type: 'debugpy',
        request: 'attach',
        name: `Django (PID: ${pid})`,
        connect: {
          host: '127.0.0.1',
          port,
        },
        justMyCode: true,
      });
    }
  );

  const factory = new DjangoDebugSessionFactory(injector, diagnostics);
  const descriptorFactory = vscode.debug.registerDebugAdapterDescriptorFactory(
    'django-process',
    factory
  );

  context.subscriptions.push(findCmd, attachCmd, descriptorFactory);
}

export function deactivate() {}
