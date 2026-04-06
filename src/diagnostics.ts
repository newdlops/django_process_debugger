import { DebugpyInjectionError, DebugpyNotFoundError } from './debugpyInjector';

interface ProcessInfo {
  pid: number;
  arch?: string;
}

/**
 * Provides human-readable diagnostic messages when attachment fails.
 * Covers common failure modes on macOS Apple Silicon.
 */
export class DiagnosticReporter {
  diagnoseAttachFailure(err: unknown, process: ProcessInfo): string {
    if (err instanceof DebugpyNotFoundError) {
      return (
        `debugpy is not installed in the target Python environment.\n` +
        `Install it with: pip install debugpy\n` +
        `Path: ${err.pythonPath}`
      );
    }

    if (err instanceof DebugpyInjectionError) {
      const causes = this.analyzeInjectionFailure(err, process);
      return (
        `Failed to attach debugger to PID ${process.pid}.\n\n` +
        `Possible causes:\n${causes.map((c) => `• ${c}`).join('\n')}`
      );
    }

    if (err instanceof Error) {
      return `Debugger attach failed: ${err.message}`;
    }

    return `Debugger attach failed with an unknown error.`;
  }

  private analyzeInjectionFailure(
    err: DebugpyInjectionError,
    proc: ProcessInfo,
  ): string[] {
    const causes: string[] = [];
    const msg = err.cause?.message ?? '';

    // macOS SIP / code signing
    if (msg.includes('Operation not permitted') || msg.includes('EPERM')) {
      causes.push(
        'macOS System Integrity Protection (SIP) is blocking process attachment. ' +
        'The target Python binary may need to be code-signed or run with appropriate entitlements.'
      );
      causes.push(
        'Try: codesign --force --sign - $(which python3)'
      );
    }

    // Port already in use
    if (msg.includes('Address already in use') || msg.includes('EADDRINUSE')) {
      causes.push(
        `Port ${err.port} is already in use. Another debugpy session may be active. ` +
        `Try a different port or stop the existing debug session.`
      );
    }

    // Process not found
    if (msg.includes('No such process') || msg.includes('ESRCH')) {
      causes.push(
        `Process ${proc.pid} no longer exists. The Django server may have stopped.`
      );
    }

    // Architecture mismatch on Apple Silicon
    if (proc.arch === 'arm64') {
      causes.push(
        'If Python is running under Rosetta (x86_64), ensure debugpy matches the architecture. ' +
        'Run `file $(which python3)` to check.'
      );
    }

    // Permission denied
    if (msg.includes('Permission denied') || msg.includes('EACCES')) {
      causes.push(
        'Permission denied. You may need to run VS Code with elevated privileges, ' +
        'or the target process is owned by a different user.'
      );
    }

    if (causes.length === 0) {
      causes.push(`Underlying error: ${msg || 'Unknown'}`);
    }

    return causes;
  }
}
