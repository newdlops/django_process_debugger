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
  const configured = process.env.DPD_TEST_PYTHON?.trim();
  const candidates = [
    ...(configured ? [configured] : []),
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ];
  for (const bin of candidates) {
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

const PROCESS_OUTPUT_LIMIT = 16 * 1024;

function appendProcessOutput(current: string, chunk: Buffer | string): string {
  const combined = current + chunk.toString();
  return combined.length <= PROCESS_OUTPUT_LIMIT
    ? combined
    : combined.slice(combined.length - PROCESS_OUTPUT_LIMIT);
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasChildExited(child) || child.pid === undefined) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exited: boolean): void => {
      if (settled) { return; }
      settled = true;
      if (timer) { clearTimeout(timer); }
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);

    child.once('exit', onExit);
    timer = setTimeout(() => finish(hasChildExited(child)), timeoutMs);

    // Avoid missing an exit that raced with listener registration.
    if (hasChildExited(child)) {
      finish(true);
    }
  });
}

async function terminateChild(child: ChildProcess): Promise<boolean> {
  if (hasChildExited(child) || child.pid === undefined) {
    return true;
  }

  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  if (await waitForChildExit(child, 1_000)) {
    return true;
  }

  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  return waitForChildExit(child, 1_000);
}

function formatCapturedOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '(empty)';
}

/**
 * Spawns the fake manage.py fixture so it appears in `ps aux` output.
 * Waits until the fake process prints "READY" on stdout.
 */
export async function spawnFakeRunserver(
  pythonPath: string,
  port: number,
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    extraArgs?: string[];
    readyTimeoutMs?: number;
  } = {},
): Promise<SpawnedProcess> {
  const managePy = path.join(fixturesDir(), 'manage.py');
  const args = [managePy, 'runserver', String(port), ...(opts.extraArgs ?? [])];
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT_MANAGER_HOOK: '0',
    PORT_MANAGER_HOOK_DISABLED: '1',
    ...opts.env,
  };
  // A test process must bind the requested real loopback port. Inherited
  // preload hooks can redirect or stall Python before manage.py reaches READY.
  if (opts.env?.DYLD_INSERT_LIBRARIES === undefined) {
    delete childEnv.DYLD_INSERT_LIBRARIES;
  }
  if (opts.env?.LD_PRELOAD === undefined) {
    delete childEnv.LD_PRELOAD;
  }
  const child = spawn(pythonPath, args, {
    env: childEnv,
    cwd: opts.cwd ?? fixturesDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let readySettled = false;

  const onStdout = (chunk: Buffer): void => {
    stdout = appendProcessOutput(stdout, chunk);
  };
  const onStderr = (chunk: Buffer): void => {
    stderr = appendProcessOutput(stderr, chunk);
  };
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);

  let resolveReady: (() => void) | undefined;
  let rejectReady: ((reason: Error) => void) | undefined;
  const finishReady = (error?: Error): void => {
    if (readySettled) { return; }
    readySettled = true;
    if (readyTimer) { clearTimeout(readyTimer); }
    if (error) { rejectReady?.(error); }
    else { resolveReady?.(); }
  };
  const detectReady = (): void => {
    if (stdout.includes('READY')) {
      finishReady();
    }
  };
  const onError = (error: Error): void => finishReady(error);
  const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    finishReady(new Error(`process exited early (code=${code} signal=${signal})`));
  };
  child.stdout?.on('data', detectReady);
  child.once('error', onError);
  child.once('exit', onEarlyExit);

  const cleanupReadyListeners = (): void => {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    child.stdout?.removeListener('data', onStdout);
    child.stdout?.removeListener('data', detectReady);
    child.stderr?.removeListener('data', onStderr);
    child.removeListener('error', onError);
    child.removeListener('exit', onEarlyExit);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
      readyTimer = setTimeout(
        () => finishReady(new Error(`Timed out waiting for READY after ${opts.readyTimeoutMs ?? 10_000}ms`)),
        opts.readyTimeoutMs ?? 10_000,
      );
      detectReady();
    });
  } catch (error) {
    const reaped = await terminateChild(child);
    cleanupReadyListeners();
    child.stdout?.resume();
    child.stderr?.resume();
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(
      `Failed to start fake runserver with ${pythonPath} on port ${port}: ${reason}\n` +
      `pid: ${child.pid ?? '(not spawned)'}\n` +
      `stdout:\n${formatCapturedOutput(stdout)}\n` +
      `stderr:\n${formatCapturedOutput(stderr)}\n` +
      `cleanup: ${reaped ? 'child exited' : 'child did not exit after SIGKILL'}`,
    );
  }

  cleanupReadyListeners();
  child.stdout?.resume();
  child.stderr?.resume();

  const pid = child.pid;
  if (pid === undefined) {
    await terminateChild(child);
    throw new Error(`Fake runserver reported READY without a process id (${pythonPath}, port ${port})`);
  }

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      const reaped = await terminateChild(child);
      if (!reaped) {
        throw new Error(`Failed to stop fake runserver pid=${pid} after SIGKILL`);
      }
    })();
    return stopPromise;
  };

  return { child, pid, stop };
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
