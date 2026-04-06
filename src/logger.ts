import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Django Process Debugger');
  }
  return outputChannel;
}

export function log(message: string): void {
  const timestamp = new Date().toISOString();
  getLogger().appendLine(`[${timestamp}] ${message}`);
}

export function logError(message: string, err?: unknown): void {
  const timestamp = new Date().toISOString();
  const logger = getLogger();
  logger.appendLine(`[${timestamp}] ERROR: ${message}`);
  if (err instanceof Error) {
    logger.appendLine(`  ${err.name}: ${err.message}`);
    if (err.stack) {
      logger.appendLine(`  Stack: ${err.stack}`);
    }
    // Capture stderr from child_process errors
    const anyErr = err as unknown as Record<string, unknown>;
    if (anyErr['stderr']) {
      logger.appendLine(`  stderr: ${anyErr['stderr']}`);
    }
    if (anyErr['stdout']) {
      logger.appendLine(`  stdout: ${anyErr['stdout']}`);
    }
  } else if (err !== undefined) {
    logger.appendLine(`  ${String(err)}`);
  }
}

export function showAndLog(message: string): void {
  log(message);
  getLogger().show(true);
}
