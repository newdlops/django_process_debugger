import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

export function fixturesDir(): string {
  return path.resolve(__dirname, '../../../src/test/fixtures');
}

export function projectRoot(): string {
  return path.resolve(__dirname, '../../../');
}

export async function findSystemPython(): Promise<string | null> {
  for (const bin of ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    try {
      const { stdout } = await execFileAsync(bin, ['-V'], { timeout: 5_000 });
      if (stdout.trim().length > 0) {
        return bin;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export interface SpawnedProcess {
  child: ChildProcess;
  pid: number;
  stop: () => Promise<void>;
}

/**
 * Spawns the fake manage.py fixture so it appears in `ps aux` output.
 * Waits until the fake process prints "READY" on stdout.
 */
export async function spawnFakeRunserver(
  pythonPath: string,
  port: number,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; extraArgs?: string[] } = {},
): Promise<SpawnedProcess> {
  const managePy = path.join(fixturesDir(), 'manage.py');
  const args = [managePy, 'runserver', String(port), ...(opts.extraArgs ?? [])];
  const child = spawn(pythonPath, args, {
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd ?? fixturesDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!child.pid) {
    throw new Error(`Failed to spawn ${pythonPath}`);
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for READY')), 10_000);
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`process exited early (code=${code} signal=${signal})`));
    });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode) { return; }
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 3_000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
  };

  return { child, pid: child.pid, stop };
}

/**
 * Creates a temporary Python venv and returns paths needed for attach tests.
 * Returns null if venv creation fails (e.g., python3 without venv module).
 */
export async function createTempVenv(basePython: string): Promise<{
  dir: string;
  python: string;
  sitePackages: string;
  cleanup: () => Promise<void>;
} | null> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-e2e-'));
  const venvDir = path.join(tmpRoot, 'venv');
  try {
    await execFileAsync(basePython, ['-m', 'venv', '--without-pip', venvDir], { timeout: 30_000 });
  } catch (err) {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    console.error('[test] venv creation failed:', err);
    return null;
  }

  const python = path.join(venvDir, 'bin', 'python');
  try {
    await fs.access(python);
  } catch {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    return null;
  }

  const { stdout } = await execFileAsync(python, [
    '-c',
    'import sysconfig; print(sysconfig.get_path("purelib"))',
  ], { timeout: 10_000 });
  const sitePackages = stdout.trim();

  return {
    dir: tmpRoot,
    python,
    sitePackages,
    cleanup: async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
