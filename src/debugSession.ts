import * as vscode from 'vscode';
import { DebugpyInjector } from './debugpyInjector';
import { DiagnosticReporter } from './diagnostics';

/**
 * Bridges between our "django-process" debug type and the underlying
 * debugpy debug adapter. When VS Code starts a "django-process" attach
 * session, this factory injects debugpy into the target process first,
 * then delegates to the debugpy extension's adapter.
 */
export class DjangoDebugSessionFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  constructor(
    private readonly injector: DebugpyInjector,
    private readonly diagnostics: DiagnosticReporter,
  ) {}

  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): Promise<vscode.DebugAdapterDescriptor | null> {
    const config = session.configuration;
    const pid: number | undefined = config.pid;
    const host: string = config.host ?? '127.0.0.1';
    const port: number = config.port ?? 5678;

    if (pid) {
      try {
        await this.injector.inject(pid, port);
      } catch (err) {
        const message = this.diagnostics.diagnoseAttachFailure(err, { pid, arch: process.arch });
        vscode.window.showErrorMessage(message);
        return null;
      }
    }

    // Delegate to debugpy's debug adapter via TCP connection
    return new vscode.DebugAdapterServer(port, host);
  }
}
