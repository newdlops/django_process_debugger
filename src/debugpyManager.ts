import { spawn, execFile } from 'child_process';
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

    const pipArgs = [
      'install',
      '--target', this.debugpyDir,
      '--no-user',
      '--upgrade',
      'debugpy',
    ];

    let result = await this.tryPipInstall(pythonPath, pipArgs);

    // If killed by SIGKILL, likely macOS code signature issue — auto-repair and retry
    if (result.signal === 'SIGKILL' && process.platform === 'darwin') {
      log(`[DebugpyManager] SIGKILL detected — attempting macOS code signature repair...`);
      const repaired = await this.repairCodeSignature(pythonPath);
      if (repaired) {
        log(`[DebugpyManager] Code signature repaired, retrying pip install...`);
        result = await this.tryPipInstall(pythonPath, pipArgs);
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
   * Try pip install: python -m pip first, then pip3 binary fallback.
   */
  private async tryPipInstall(
    pythonPath: string,
    pipArgs: string[],
  ): Promise<{ code: number; signal: string | null; stdout: string; stderr: string }> {
    // Strategy 1: python -m pip
    const args1 = ['-m', 'pip', ...pipArgs];
    log(`[DebugpyManager] Running: ${pythonPath} ${args1.join(' ')}`);
    let result = await this.runProcess(pythonPath, args1);

    // Strategy 2: pip3 binary
    if (result.code !== 0 && result.signal !== 'SIGKILL') {
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

    return result;
  }

  /**
   * Repair macOS code signature for a Python binary and related binaries in the same dir.
   * Returns true if repair was attempted.
   */
  private async repairCodeSignature(pythonPath: string): Promise<boolean> {
    const binDir = path.dirname(pythonPath);
    let repaired = false;

    try {
      // Find real path (resolve symlinks)
      const realPath = await fs.realpath(pythonPath);
      const realBinDir = path.dirname(realPath);

      // Collect all python/pip binaries in both dirs
      const binaries = new Set<string>();
      for (const dir of new Set([binDir, realBinDir])) {
        try {
          const files = await fs.readdir(dir);
          for (const f of files) {
            if (/^(python|pip)\d?(\.\d+)*$/.test(f)) {
              try {
                const real = await fs.realpath(path.join(dir, f));
                binaries.add(real);
              } catch { /* broken symlink */ }
            }
          }
        } catch { /* dir not found */ }
      }

      for (const bin of binaries) {
        try {
          // Remove quarantine xattr
          await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', bin], { timeout: 5_000 }).catch(() => {});
          // Re-sign
          await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', bin], { timeout: 10_000 });
          log(`[DebugpyManager] Re-signed: ${bin}`);
          repaired = true;
        } catch (err) {
          logError(`[DebugpyManager] Failed to re-sign ${bin}`, err);
        }
      }

      // Also clear xattrs on the bin directory
      await execFileAsync('xattr', ['-cr', realBinDir], { timeout: 5_000 }).catch(() => {});

      // Verify python works
      if (repaired) {
        const check = await this.runProcess(realPath, ['-S', '-c', 'print("ok")']);
        if (check.code === 0) {
          log(`[DebugpyManager] Python binary verified working after repair`);
        } else {
          log(`[DebugpyManager] Python still broken after repair (code=${check.code}, signal=${check.signal})`);
          repaired = false;
        }
      }
    } catch (err) {
      logError(`[DebugpyManager] Code signature repair failed`, err);
    }

    return repaired;
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
