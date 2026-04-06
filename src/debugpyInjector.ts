import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class DebugpyInjector {
  /**
   * Inject debugpy into a running Python process.
   *
   * This uses the target process's Python interpreter to execute a
   * small bootstrap script that imports debugpy and starts listening,
   * without modifying any workspace files.
   */
  async inject(pid: number, port: number): Promise<void> {
    const pythonPath = await this.resolvePythonForPid(pid);

    // Verify debugpy is available in the target environment
    await this.ensureDebugpyAvailable(pythonPath);

    // Use debugpy's ability to attach to a running process by PID
    // This injects the debug adapter into the target process at runtime
    const script = `
import debugpy
debugpy.listen(("127.0.0.1", ${port}))
print("debugpy listening on port ${port}")
`;

    try {
      await execFileAsync(pythonPath, [
        '-c',
        `import debugpy; debugpy.attach_pid(${pid}, ("127.0.0.1", ${port}))`,
      ], {
        timeout: 10_000,
      });
    } catch (err: unknown) {
      throw new DebugpyInjectionError(
        `Failed to inject debugpy into PID ${pid}`,
        pid,
        port,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private async resolvePythonForPid(pid: number): Promise<string> {
    try {
      // On macOS, resolve the python path from /proc equivalent
      const { stdout } = await execFileAsync('ps', [
        '-p', String(pid), '-o', 'command=',
      ]);
      const match = stdout.trim().match(/^(\S*python\S*)/);
      return match ? match[1] : 'python3';
    } catch {
      return 'python3';
    }
  }

  private async ensureDebugpyAvailable(pythonPath: string): Promise<void> {
    try {
      await execFileAsync(pythonPath, ['-c', 'import debugpy']);
    } catch {
      throw new DebugpyNotFoundError(pythonPath);
    }
  }
}

export class DebugpyInjectionError extends Error {
  constructor(
    message: string,
    public readonly pid: number,
    public readonly port: number,
    public readonly cause: Error,
  ) {
    super(message);
    this.name = 'DebugpyInjectionError';
  }
}

export class DebugpyNotFoundError extends Error {
  constructor(public readonly pythonPath: string) {
    super(
      `debugpy is not installed in the Python environment at "${pythonPath}". ` +
      `Install it with: ${pythonPath} -m pip install debugpy`
    );
    this.name = 'DebugpyNotFoundError';
  }
}
