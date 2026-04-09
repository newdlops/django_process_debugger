import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { log, logError } from './logger';

const execFileAsync = promisify(execFile);

export type DebugpyProvisionSource = 'vendored' | 'pip';

export interface DebugpyProvisioningInfo {
  path: string;
  source: DebugpyProvisionSource;
  version?: string;
}

interface StoredProvisioningInfo extends DebugpyProvisioningInfo {
  preparedAt: string;
}

/**
 * Manages the private debugpy bundle exposed to target runtimes.
 * The preferred path is a vendored copy that ships with the extension.
 * If that asset is unavailable, we fall back to pip install into globalStorage.
 */
export class DebugpyManager {
  private debugpyDir: string;
  private metadataFile: string;
  private vendoredRoot: string;

  constructor(context: vscode.ExtensionContext) {
    this.debugpyDir = path.join(context.globalStorageUri.fsPath, 'debugpy');
    this.metadataFile = path.join(this.debugpyDir, '.metadata.json');
    this.vendoredRoot = path.join(context.extensionUri.fsPath, 'vendor', 'python');
  }

  getDebugpyDir(): string {
    return this.debugpyDir;
  }

  async getProvisioningInfo(): Promise<DebugpyProvisioningInfo> {
    const prepared = await this.getPreparedInstallInfo();
    if (prepared) {
      return prepared;
    }

    const vendored = await this.getVendoredBundleInfo();
    if (vendored) {
      return vendored;
    }

    return {
      path: this.debugpyDir,
      source: 'pip',
    };
  }

  /**
   * Ensures a usable debugpy bundle exists in globalStorage and returns
   * the path that should be inserted into sys.path.
   */
  async ensureInstalled(pythonPath?: string): Promise<DebugpyProvisioningInfo> {
    const prepared = await this.getPreparedInstallInfo();
    const vendored = await this.getVendoredBundleInfo();

    if (vendored && (!prepared || prepared.source !== 'vendored' || prepared.version !== vendored.version)) {
      log('[DebugpyManager] Preparing vendored debugpy bundle...');
      return this.installFromVendored(vendored.version);
    }

    if (prepared) {
      log(`[DebugpyManager] Bundled debugpy already prepared at ${prepared.path} (${prepared.source})`);
      return prepared;
    }

    if (vendored) {
      return this.installFromVendored(vendored.version);
    }

    if (!pythonPath) {
      throw new Error(
        'No vendored debugpy bundle found. Select a Python interpreter with pip support to provision debugpy.'
      );
    }

    return this.installWithPip(pythonPath);
  }

  /**
   * Check if debugpy is already prepared in globalStorage.
   */
  async isInstalled(): Promise<boolean> {
    try {
      await fs.access(path.join(this.debugpyDir, '.installed'));
      return true;
    } catch {
      return false;
    }
  }

  private async getPreparedInstallInfo(): Promise<DebugpyProvisioningInfo | null> {
    try {
      await fs.access(path.join(this.debugpyDir, '.installed'));
    } catch {
      return null;
    }

    const metadata = await this.readStoredMetadata();
    if (metadata) {
      return metadata;
    }

    return {
      path: this.debugpyDir,
      source: 'pip',
      version: await this.readDebugpyVersion(this.debugpyDir),
    };
  }

  private async getVendoredBundleInfo(): Promise<DebugpyProvisioningInfo | null> {
    try {
      await fs.access(path.join(this.vendoredRoot, 'debugpy', '__init__.py'));
      return {
        path: this.vendoredRoot,
        source: 'vendored',
        version: await this.readDebugpyVersion(this.vendoredRoot),
      };
    } catch {
      return null;
    }
  }

  private async readStoredMetadata(): Promise<StoredProvisioningInfo | null> {
    try {
      const raw = await fs.readFile(this.metadataFile, 'utf-8');
      return JSON.parse(raw) as StoredProvisioningInfo;
    } catch {
      return null;
    }
  }

  private async markInstalled(info: StoredProvisioningInfo): Promise<void> {
    await fs.writeFile(path.join(this.debugpyDir, '.installed'), info.preparedAt, 'utf-8');
    await fs.writeFile(this.metadataFile, JSON.stringify(info, null, 2), 'utf-8');
  }

  private async readDebugpyVersion(rootDir: string): Promise<string | undefined> {
    try {
      const versionFile = await fs.readFile(path.join(rootDir, 'debugpy', '_version.py'), 'utf-8');
      const match = versionFile.match(/"version"\s*:\s*"([^"]+)"/);
      if (match) {
        return match[1];
      }
    } catch {
      // ignore
    }

    return undefined;
  }

  private async installFromVendored(version?: string): Promise<DebugpyProvisioningInfo> {
    log(`[DebugpyManager] Copying vendored debugpy from ${this.vendoredRoot} to ${this.debugpyDir}...`);
    await fs.rm(this.debugpyDir, { recursive: true, force: true });
    await fs.mkdir(this.debugpyDir, { recursive: true });
    await fs.cp(this.vendoredRoot, this.debugpyDir, { recursive: true });

    const info: StoredProvisioningInfo = {
      path: this.debugpyDir,
      source: 'vendored',
      version: version ?? await this.readDebugpyVersion(this.debugpyDir),
      preparedAt: new Date().toISOString(),
    };
    await this.markInstalled(info);
    log(`[DebugpyManager] Vendored debugpy ready at ${this.debugpyDir}`);
    return info;
  }

  private async installWithPip(pythonPath: string): Promise<DebugpyProvisioningInfo> {
    log(`[DebugpyManager] Installing debugpy into ${this.debugpyDir} using ${pythonPath}...`);
    await fs.rm(this.debugpyDir, { recursive: true, force: true });
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
      log('[DebugpyManager] SIGKILL detected — attempting macOS code signature repair...');
      const repaired = await this.repairCodeSignature(pythonPath);
      if (repaired) {
        log('[DebugpyManager] Code signature repaired, retrying pip install...');
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

    const info: StoredProvisioningInfo = {
      path: this.debugpyDir,
      source: 'pip',
      version: await this.readDebugpyVersion(this.debugpyDir),
      preparedAt: new Date().toISOString(),
    };
    await this.markInstalled(info);
    log('[DebugpyManager] debugpy installed successfully');
    return info;
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
          signal,
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
    const args1 = ['-m', 'pip', ...pipArgs];
    log(`[DebugpyManager] Running: ${pythonPath} ${args1.join(' ')}`);
    let result = await this.runProcess(pythonPath, args1);

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
      const realPath = await fs.realpath(pythonPath);
      const realBinDir = path.dirname(realPath);

      const binaries = new Set<string>();
      for (const dir of new Set([binDir, realBinDir])) {
        try {
          const files = await fs.readdir(dir);
          for (const fileName of files) {
            if (/^(python|pip)\d?(\.\d+)*$/.test(fileName)) {
              try {
                const real = await fs.realpath(path.join(dir, fileName));
                binaries.add(real);
              } catch {
                // broken symlink
              }
            }
          }
        } catch {
          // dir not found
        }
      }

      for (const bin of binaries) {
        try {
          await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', bin], { timeout: 5_000 }).catch(() => {});
          await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', bin], { timeout: 10_000 });
          log(`[DebugpyManager] Re-signed: ${bin}`);
          repaired = true;
        } catch (err) {
          logError(`[DebugpyManager] Failed to re-sign ${bin}`, err);
        }
      }

      await execFileAsync('xattr', ['-cr', realBinDir], { timeout: 5_000 }).catch(() => {});

      if (repaired) {
        const check = await this.runProcess(realPath, ['-S', '-c', 'print("ok")']);
        if (check.code === 0) {
          log('[DebugpyManager] Python binary verified working after repair');
        } else {
          log(`[DebugpyManager] Python still broken after repair (code=${check.code}, signal=${check.signal})`);
          repaired = false;
        }
      }
    } catch (err) {
      logError('[DebugpyManager] Code signature repair failed', err);
    }

    return repaired;
  }

  /**
   * Remove existing debugpy installation and reinstall.
   */
  async reinstall(pythonPath?: string): Promise<DebugpyProvisioningInfo> {
    log(`[DebugpyManager] Removing existing debugpy at ${this.debugpyDir}...`);
    try {
      await fs.rm(this.debugpyDir, { recursive: true, force: true });
    } catch {
      // directory may not exist
    }
    log('[DebugpyManager] Reinstalling debugpy...');
    return this.ensureInstalled(pythonPath);
  }
}
