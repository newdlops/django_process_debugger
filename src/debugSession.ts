import * as vscode from 'vscode';
import { DebugpyInjector } from './debugpyInjector';
import { log, logError, getLogger } from './logger';

/**
 * Bridges between our "django-process" debug type and the underlying
 * debugpy debug adapter. When VS Code starts a "django-process" attach
 * session, this factory activates debugpy via SIGUSR1 first,
 * then delegates to debugpy's adapter via TCP.
 */
export class DjangoDebugSessionFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  constructor(
    private readonly injector: DebugpyInjector,
  ) {}

  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): Promise<vscode.DebugAdapterDescriptor | null> {
    const config = session.configuration;
    const pid: number | undefined = config.pid;
    const host: string = config.host ?? '127.0.0.1';
    const port: number = config.port ?? 5678;

    log(`[DebugSession] createDebugAdapterDescriptor: pid=${pid} host=${host} port=${port}`);

    if (pid) {
      try {
        await this.injector.activate(pid, port);
        log(`[DebugSession] Activation succeeded, connecting to ${host}:${port}`);
      } catch (err) {
        logError(`[DebugSession] Activation failed`, err);
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg, 'Show Logs').then((c) => {
          if (c === 'Show Logs') { getLogger().show(); }
        });
        return null;
      }
    }

    return new vscode.DebugAdapterServer(port, host);
  }
}
