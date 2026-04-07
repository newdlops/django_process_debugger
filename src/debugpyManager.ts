import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { log, logError } from './logger';

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

    // Try python -m pip first, then fall back to pip binary directly
    const pipArgs = [
      'install',
      '--target', this.debugpyDir,
      '--no-user',
      '--upgrade',
      'debugpy',
    ];

    // Strategy 1: python -m pip
    const args1 = ['-m', 'pip', ...pipArgs];
    log(`[DebugpyManager] Running: ${pythonPath} ${args1.join(' ')}`);
    let result = await this.runProcess(pythonPath, args1);

    // Strategy 2: If python -m pip failed, try pip binary next to python
    if (result.code !== 0) {
      log(`[DebugpyManager] python -m pip failed (code=${result.code}, signal=${result.signal}). Trying pip binary...`);
      if (result.stdout) { log(`[DebugpyManager] stdout:\n${result.stdout}`); }
      if (result.stderr) { log(`[DebugpyManager] stderr:\n${result.stderr}`); }

      const pipBin = path.join(path.dirname(pythonPath), 'pip3');
      try {
        await fs.access(pipBin);
        log(`[DebugpyManager] Running: ${pipBin} ${pipArgs.join(' ')}`);
        result = await this.runProcess(pipBin, pipArgs);
      } catch {
        log(`[DebugpyManager] pip3 binary not found at ${pipBin}`);
      }
    }

    if (result.stdout) { log(`[DebugpyManager] pip stdout:\n${result.stdout}`); }
    if (result.stderr) { log(`[DebugpyManager] pip stderr:\n${result.stderr}`); }

    if (result.code !== 0) {
      const signalInfo = result.signal ? ` (signal: ${result.signal})` : '';
      logError(`[DebugpyManager] pip exited with code ${result.code}${signalInfo}`);
      const detail = result.stderr || result.stdout || `exit code ${result.code}${signalInfo}`;
      throw new Error(
        `Failed to install debugpy using ${pythonPath}.\n${detail}`
      );
    }

    await fs.writeFile(markerFile, new Date().toISOString(), 'utf-8');
    log(`[DebugpyManager] debugpy installed successfully`);
    return this.debugpyDir;
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

  private runProcess(command: string, args: string[]): Promise<{ code: number; signal: string | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        timeout: 120_000,
        env: { ...process.env },
      });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      proc.stdout.on('data', (data: Buffer) => { stdoutChunks.push(data.toString()); });
      proc.stderr.on('data', (data: Buffer) => { stderrChunks.push(data.toString()); });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn ${command}: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        resolve({
          code: code ?? (signal ? 1 : 0),
          signal: signal,
          stdout: stdoutChunks.join('').trim(),
          stderr: stderrChunks.join('').trim(),
        });
      });
    });
  }

  /**
   * Remove existing debugpy installation and reinstall using the given pythonPath.
   */
  async reinstall(pythonPath: string): Promise<string> {
    log(`[DebugpyManager] Removing existing debugpy at ${this.debugpyDir}...`);
    try {
      await fs.rm(this.debugpyDir, { recursive: true, force: true });
    } catch {
      // directory may not exist
    }
    log(`[DebugpyManager] Reinstalling debugpy with ${pythonPath}...`);
    return this.ensureInstalled(pythonPath);
  }
}
