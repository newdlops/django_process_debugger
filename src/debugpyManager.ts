import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { log, logError } from './logger';

const execFileAsync = promisify(execFile);

/**
 * Manages a private debugpy installation bundled within the extension's
 * globalStorage directory. This ensures debugpy is available without
 * requiring users to install it in their project's virtualenv.
 */
export class DebugpyManager {
  private debugpyDir: string;

  constructor(context: vscode.ExtensionContext) {
    this.debugpyDir = path.join(context.globalStorageUri.fsPath, 'debugpy');
  }

  getDebugpyDir(): string {
    return this.debugpyDir;
  }

  /**
   * Returns the path to the directory containing the bundled debugpy package.
   * Installs it on first use. Uses the given pythonPath to run pip.
   */
  async ensureInstalled(pythonPath: string): Promise<string> {
    const markerFile = path.join(this.debugpyDir, '.installed');

    try {
      await fs.access(markerFile);
      log(`[DebugpyManager] Bundled debugpy already installed at ${this.debugpyDir}`);
      return this.debugpyDir;
    } catch {
      // not installed yet
    }

    log(`[DebugpyManager] Installing debugpy into ${this.debugpyDir} using ${pythonPath}...`);
    await fs.mkdir(this.debugpyDir, { recursive: true });

    try {
      const { stdout, stderr } = await execFileAsync(pythonPath, [
        '-m', 'pip', 'install',
        '--target', this.debugpyDir,
        '--no-user',
        '--upgrade',
        'debugpy',
      ], {
        timeout: 120_000,
      });
      if (stdout) { log(`[DebugpyManager] pip stdout: ${stdout.trim()}`); }
      if (stderr) { log(`[DebugpyManager] pip stderr: ${stderr.trim()}`); }

      await fs.writeFile(markerFile, new Date().toISOString(), 'utf-8');
      log(`[DebugpyManager] debugpy installed successfully`);
      return this.debugpyDir;
    } catch (err) {
      logError('[DebugpyManager] Failed to install debugpy', err);
      throw new Error(
        `Failed to install debugpy using ${pythonPath}. ` +
        `Ensure pip is available: ${pythonPath} -m pip --version`
      );
    }
  }

  /**
   * Check if debugpy is already installed.
   */
  async isInstalled(): Promise<boolean> {
    try {
      await fs.access(path.join(this.debugpyDir, '.installed'));
      return true;
    } catch {
      return false;
    }
  }
}
