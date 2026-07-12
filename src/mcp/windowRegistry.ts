import { createHash, randomBytes } from 'crypto';
import { constants as fsConstants, realpathSync } from 'fs';
import type { Stats } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const MCP_MANIFEST_SCHEMA_VERSION = 'django-process-debugger.mcp/1' as const;
export const MCP_REGISTRY_HEARTBEAT_MS = 10_000;
export const MCP_REGISTRY_LEASE_MS = 30_000;
export const MCP_REGISTRY_DIRECTORY_MODE = 0o700;
export const MCP_REGISTRY_FILE_MODE = 0o600;

const MCP_REGISTRY_LOCK_SCHEMA_VERSION = 'django-process-debugger.mcp-lock/1' as const;
const WINDOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REGISTRY_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:json|lock)$/;

export interface McpWorkspaceFolderManifest {
  name: string;
  uri: string;
  fsPath: string;
  canonicalPath: string;
}

export interface McpWindowManifest {
  schemaVersion: typeof MCP_MANIFEST_SCHEMA_VERSION;
  windowId: string;
  extensionPid: number;
  url: string;
  token: string;
  workspaceFolders: McpWorkspaceFolderManifest[];
  extensionVersion: string;
  startedAt: string;
  updatedAt: string;
  leaseExpiresAt: string;
}

export interface McpWindowRegistryPublisher {
  readonly windowId: string;
  readonly manifestPath: string;
  dispose(): Promise<void>;
}

interface RegistryLifetimeLockRecord {
  schemaVersion: typeof MCP_REGISTRY_LOCK_SCHEMA_VERSION;
  windowId: string;
  extensionPid: number;
  ownerNonce: string;
  createdAt: string;
}

interface RegistryLifetimeLock {
  readonly lockPath: string;
  assertOwned(): Promise<void>;
  dispose(): Promise<void>;
}

type FileStat = Stats;

/** Raised when an untrusted or overly-permissive registry path is encountered. */
export class McpRegistrySecurityError extends Error {
  readonly code = 'UNSAFE_MCP_REGISTRY' as const;

  constructor(
    readonly registryPath: string,
    readonly reason: string,
    readonly cause?: unknown,
  ) {
    super(`Unsafe MCP registry path ${registryPath}: ${reason}`);
    this.name = 'McpRegistrySecurityError';
  }
}

/** Raised when two live publishers attempt to claim the same discovery id. */
export class McpWindowIdCollisionError extends Error {
  readonly code = 'WINDOW_ID_COLLISION' as const;

  constructor(
    readonly windowId: string,
    readonly manifestPath: string,
  ) {
    super(`MCP window id ${windowId} is already claimed at ${manifestPath}`);
    this.name = 'McpWindowIdCollisionError';
  }
}

function userNamespace(): string {
  if (typeof process.getuid === 'function') {
    return `uid-${process.getuid()}`;
  }
  let identity: string;
  try {
    const user = os.userInfo();
    identity = `${user.username}\0${user.homedir}`;
  } catch {
    identity = `${process.env.USERNAME ?? ''}\0${os.homedir()}`;
  }
  return `user-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function canonicalTemporaryRootSync(): string {
  const temporaryRoot = path.resolve(os.tmpdir());
  try {
    return path.resolve(realpathSync(temporaryRoot));
  } catch {
    return temporaryRoot;
  }
}

/** A stable per-user namespace prevents users from sharing one predictable /tmp directory. */
export function defaultMcpRegistryDir(): string {
  return path.join(
    canonicalTemporaryRootSync(),
    `django-process-debugger-${userNamespace()}`,
    'mcp',
  );
}

export function isValidMcpWindowId(value: string): boolean {
  return WINDOW_ID_PATTERN.test(value);
}

export function createMcpWindowId(): string {
  return `${process.pid}-${randomBytes(16).toString('hex')}`;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * macOS commonly spells its private temporary root through the root-owned
 * `/var` symlink. Resolve only that OS-provided prefix; symlinks below the
 * temporary root remain visible to the component validator and are rejected.
 */
async function canonicalRegistryPath(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (!isPathInside(temporaryRoot, resolved)) {
    return resolved;
  }
  let canonicalTemporaryRoot: string;
  try {
    canonicalTemporaryRoot = path.resolve(await fs.realpath(temporaryRoot));
  } catch {
    canonicalTemporaryRoot = temporaryRoot;
  }
  return path.resolve(canonicalTemporaryRoot, path.relative(temporaryRoot, resolved));
}

function absolutePathComponents(absolutePath: string): string[] {
  const parsed = path.parse(absolutePath);
  const result = [parsed.root];
  let current = parsed.root;
  for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    result.push(current);
  }
  return result;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function securityError(
  registryPath: string,
  reason: string,
  cause?: unknown,
): McpRegistrySecurityError {
  return new McpRegistrySecurityError(registryPath, reason, cause);
}

function validateDirectoryComponent(
  registryPath: string,
  component: string,
  stat: FileStat,
  isRegistryDirectory: boolean,
): void {
  if (stat.isSymbolicLink()) {
    throw securityError(registryPath, `symbolic-link component is not allowed: ${component}`);
  }
  if (!stat.isDirectory()) {
    throw securityError(registryPath, `path component is not a directory: ${component}`);
  }

  const uid = currentUid();
  if (uid === undefined || process.platform === 'win32') {
    return;
  }
  if (stat.uid !== uid && stat.uid !== 0) {
    throw securityError(
      registryPath,
      `path component is owned by uid ${stat.uid}, expected uid ${uid} or root: ${component}`,
    );
  }

  const mode = stat.mode & 0o7777;
  if (isRegistryDirectory) {
    if (stat.uid !== uid) {
      throw securityError(registryPath, `registry directory is not owned by uid ${uid}`);
    }
    if ((mode & 0o777) !== MCP_REGISTRY_DIRECTORY_MODE) {
      throw securityError(
        registryPath,
        `registry directory mode must be 0700, found 0${(mode & 0o777).toString(8)}`,
      );
    }
    return;
  }

  const writableByOthers = (mode & 0o022) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  if (stat.uid === uid && writableByOthers) {
    throw securityError(registryPath, `user-owned parent is group/world writable: ${component}`);
  }
  if (stat.uid === 0 && writableByOthers && !sticky) {
    throw securityError(registryPath, `root-owned writable parent lacks the sticky bit: ${component}`);
  }
}

async function secureRegistryDirectory(
  rawDirectory: string,
  create: boolean,
): Promise<string> {
  if (typeof rawDirectory !== 'string' || rawDirectory.trim() === '') {
    throw new TypeError('MCP registry directory must be a non-empty path');
  }
  const directory = await canonicalRegistryPath(rawDirectory);
  const components = absolutePathComponents(directory);

  for (const [index, component] of components.entries()) {
    const isRegistryDirectory = index === components.length - 1;
    let stat: FileStat;
    try {
      stat = await fs.lstat(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw securityError(directory, `could not inspect path component ${component}`, error);
      }
      if (!create) {
        throw error;
      }
      let created = false;
      try {
        await fs.mkdir(component, { mode: MCP_REGISTRY_DIRECTORY_MODE });
        created = true;
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw securityError(directory, `could not create ${component}`, mkdirError);
        }
      }
      stat = await fs.lstat(component);
      if (created && process.platform !== 'win32') {
        validateDirectoryComponent(directory, component, stat, false);
        try {
          await fs.chmod(component, MCP_REGISTRY_DIRECTORY_MODE);
        } catch (chmodError) {
          throw securityError(directory, `could not secure permissions on ${component}`, chmodError);
        }
        stat = await fs.lstat(component);
      }
    }
    validateDirectoryComponent(directory, component, stat, isRegistryDirectory);
  }

  let canonical: string;
  try {
    canonical = path.resolve(await fs.realpath(directory));
  } catch (error) {
    throw securityError(directory, 'could not resolve the validated directory', error);
  }
  if (pathKey(canonical) !== pathKey(directory)) {
    throw securityError(directory, `directory resolves through a symbolic link to ${canonical}`);
  }
  return directory;
}

/** Create missing components privately, but never repair an unsafe pre-existing path. */
export async function ensureSecureMcpRegistryDirectory(directory: string): Promise<string> {
  return secureRegistryDirectory(directory, true);
}

/** Validate an existing registry before reading any attacker-controlled entries. */
export async function validateSecureMcpRegistryDirectory(directory: string): Promise<string> {
  return secureRegistryDirectory(directory, false);
}

function validateRegistryFileStat(
  registryPath: string,
  filePath: string,
  stat: FileStat,
): void {
  if (stat.isSymbolicLink()) {
    throw securityError(registryPath, `registry file is a symbolic link: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw securityError(registryPath, `registry entry is not a regular file: ${filePath}`);
  }
  if (process.platform === 'win32') {
    return;
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw securityError(registryPath, `registry file is owned by uid ${stat.uid}, expected ${uid}`);
  }
  if ((stat.mode & 0o777) !== MCP_REGISTRY_FILE_MODE) {
    throw securityError(
      registryPath,
      `registry file mode must be 0600, found 0${(stat.mode & 0o777).toString(8)}: ${filePath}`,
    );
  }
  if (stat.nlink !== 1) {
    throw securityError(registryPath, `registry file must have exactly one link: ${filePath}`);
  }
}

function sameFile(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Read a manifest/lock through a no-follow descriptor and verify owner/mode/type. */
export async function readSecureMcpRegistryFile(
  registryDirectory: string,
  fileName: string,
): Promise<string> {
  if (!REGISTRY_FILE_PATTERN.test(fileName) || path.basename(fileName) !== fileName) {
    throw securityError(registryDirectory, `invalid registry entry name: ${fileName}`);
  }
  const filePath = path.join(registryDirectory, fileName);
  const before = await fs.lstat(filePath);
  validateRegistryFileStat(registryDirectory, filePath, before);
  const noFollow = process.platform !== 'win32' && typeof fsConstants.O_NOFOLLOW === 'number'
    ? fsConstants.O_NOFOLLOW
    : 0;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    throw securityError(registryDirectory, `could not safely open ${fileName}`, error);
  }
  try {
    const opened = await handle.stat();
    validateRegistryFileStat(registryDirectory, filePath, opened);
    const content = await handle.readFile({ encoding: 'utf8' });
    // Atomic heartbeat replacement may legitimately change the inode while
    // this descriptor still references a complete old manifest. Re-check the
    // pathname's type/permissions without requiring inode equality.
    validateRegistryFileStat(registryDirectory, filePath, await fs.lstat(filePath));
    return content;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function secureCreatedFile(
  registryDirectory: string,
  filePath: string,
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<FileStat> {
  if (process.platform !== 'win32') {
    await handle.chmod(MCP_REGISTRY_FILE_MODE);
  }
  const stat = await handle.stat();
  validateRegistryFileStat(registryDirectory, filePath, stat);
  return stat;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const registryDirectory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', MCP_REGISTRY_FILE_MODE);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8');
    await secureCreatedFile(registryDirectory, temporaryPath, handle);
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    const finalStat = await fs.lstat(filePath);
    validateRegistryFileStat(registryDirectory, filePath, finalStat);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function createJsonExclusive(
  registryDirectory: string,
  filePath: string,
  windowId: string,
  value: unknown,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, 'wx', MCP_REGISTRY_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new McpWindowIdCollisionError(windowId, filePath);
    }
    throw error;
  }

  let completed = false;
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8');
    await secureCreatedFile(registryDirectory, filePath, handle);
    completed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!completed) {
      await fs.unlink(filePath).catch(() => undefined);
    }
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLifetimeLock(value: unknown): RegistryLifetimeLockRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<RegistryLifetimeLockRecord>;
  return record.schemaVersion === MCP_REGISTRY_LOCK_SCHEMA_VERSION
    && typeof record.windowId === 'string'
    && isValidMcpWindowId(record.windowId)
    && typeof record.extensionPid === 'number'
    && Number.isInteger(record.extensionPid)
    && record.extensionPid > 0
    && typeof record.ownerNonce === 'string'
    && /^[a-f0-9]{32}$/.test(record.ownerNonce)
    && typeof record.createdAt === 'string'
    && Number.isFinite(Date.parse(record.createdAt))
    ? record as RegistryLifetimeLockRecord
    : undefined;
}

async function removeStaleLifetimeLock(
  registryDirectory: string,
  lockFileName: string,
): Promise<boolean> {
  const lockPath = path.join(registryDirectory, lockFileName);
  let before: FileStat;
  let record: RegistryLifetimeLockRecord | undefined;
  try {
    before = await fs.lstat(lockPath);
    const raw = await readSecureMcpRegistryFile(registryDirectory, lockFileName);
    record = parseLifetimeLock(JSON.parse(raw) as unknown);
  } catch {
    return false;
  }
  if (!record || defaultIsProcessAlive(record.extensionPid)) {
    return false;
  }
  try {
    const after = await fs.lstat(lockPath);
    if (!sameFile(before, after)) {
      return false;
    }
    await fs.unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireLifetimeLock(
  registryDirectory: string,
  manifestPath: string,
  windowId: string,
  extensionPid: number,
): Promise<RegistryLifetimeLock> {
  const lockFileName = `${windowId}.lock`;
  const lockPath = path.join(registryDirectory, lockFileName);

  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(lockPath, 'wx', MCP_REGISTRY_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if (attempt === 0 && await removeStaleLifetimeLock(registryDirectory, lockFileName)) {
          continue;
        }
        throw new McpWindowIdCollisionError(windowId, manifestPath);
      }
      throw error;
    }

    const ownerNonce = randomBytes(16).toString('hex');
    const record: RegistryLifetimeLockRecord = {
      schemaVersion: MCP_REGISTRY_LOCK_SCHEMA_VERSION,
      windowId,
      extensionPid,
      ownerNonce,
      createdAt: new Date().toISOString(),
    };
    let identity: FileStat;
    try {
      await handle.writeFile(JSON.stringify(record), 'utf-8');
      identity = await secureCreatedFile(registryDirectory, lockPath, handle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(lockPath).catch(() => undefined);
      throw error;
    }

    let disposed = false;
    const assertOwned = async (): Promise<void> => {
      if (disposed) {
        throw new McpWindowIdCollisionError(windowId, manifestPath);
      }
      let current: FileStat;
      try {
        current = await fs.lstat(lockPath);
        validateRegistryFileStat(registryDirectory, lockPath, current);
      } catch (error) {
        throw new McpWindowIdCollisionError(windowId, manifestPath);
      }
      const held = await handle.stat();
      if (!sameFile(identity, current) || !sameFile(identity, held)) {
        throw new McpWindowIdCollisionError(windowId, manifestPath);
      }
      let parsed: RegistryLifetimeLockRecord | undefined;
      try {
        parsed = parseLifetimeLock(JSON.parse(
          await readSecureMcpRegistryFile(registryDirectory, lockFileName),
        ) as unknown);
      } catch {
        parsed = undefined;
      }
      if (parsed?.ownerNonce !== ownerNonce
        || parsed.windowId !== windowId
        || parsed.extensionPid !== extensionPid) {
        throw new McpWindowIdCollisionError(windowId, manifestPath);
      }
    };

    return {
      lockPath,
      assertOwned,
      async dispose(): Promise<void> {
        if (disposed) {
          return;
        }
        let removeOwnedPath = false;
        try {
          await assertOwned();
          removeOwnedPath = true;
        } catch {
          // A replaced lock is not ours to remove.
        } finally {
          disposed = true;
          await handle.close().catch(() => undefined);
        }
        if (removeOwnedPath) {
          try {
            const current = await fs.lstat(lockPath);
            if (sameFile(identity, current)) {
              await fs.unlink(lockPath);
            }
          } catch {
            // Missing or replaced locks are not removable by this owner.
          }
        }
      },
    };
  }

  throw new McpWindowIdCollisionError(windowId, manifestPath);
}

async function refreshOwnedJson(
  registryDirectory: string,
  filePath: string,
  owner: Pick<McpWindowManifest, 'windowId' | 'extensionPid' | 'token' | 'startedAt'>,
  value: McpWindowManifest,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  let current: Partial<McpWindowManifest>;
  try {
    current = JSON.parse(await readSecureMcpRegistryFile(
      registryDirectory,
      path.basename(filePath),
    )) as Partial<McpWindowManifest>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await createJsonExclusive(registryDirectory, filePath, owner.windowId, value);
      return;
    }
    throw error;
  }
  if (current.windowId !== owner.windowId
    || current.extensionPid !== owner.extensionPid
    || current.token !== owner.token
    || current.startedAt !== owner.startedAt) {
    throw new McpWindowIdCollisionError(owner.windowId, filePath);
  }
  await beforeCommit?.();
  await atomicWriteJson(filePath, value);
}

/**
 * Publish one live, window-owned MCP endpoint. A private per-user directory
 * blocks cross-user manifest injection, while the lifetime lock closes the
 * read/check/rename gap between an old heartbeat and a new publisher.
 */
export async function publishMcpWindowManifest(
  input: Omit<McpWindowManifest, 'schemaVersion' | 'startedAt' | 'updatedAt' | 'leaseExpiresAt'>,
  options: {
    registryDir?: string;
    heartbeatMs?: number;
    leaseMs?: number;
    /** Deterministic interleaving hook used only by registry race tests. */
    beforeRefreshCommit?: () => void | Promise<void>;
  } = {},
): Promise<McpWindowRegistryPublisher> {
  if (!isValidMcpWindowId(input.windowId)) {
    throw new TypeError('windowId must contain only 1-128 letters, digits, underscores, or hyphens');
  }
  if (!Number.isInteger(input.extensionPid) || input.extensionPid <= 0) {
    throw new TypeError('extensionPid must be a positive integer');
  }
  const registryDirectory = await ensureSecureMcpRegistryDirectory(
    options.registryDir ?? defaultMcpRegistryDir(),
  );
  const heartbeatMs = options.heartbeatMs ?? MCP_REGISTRY_HEARTBEAT_MS;
  const leaseMs = options.leaseMs ?? MCP_REGISTRY_LEASE_MS;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new TypeError('heartbeatMs must be a positive finite number');
  }
  if (!Number.isFinite(leaseMs) || leaseMs <= heartbeatMs) {
    throw new TypeError('leaseMs must be finite and greater than heartbeatMs');
  }

  const manifestPath = path.join(registryDirectory, `${input.windowId}.json`);
  const lifetimeLock = await acquireLifetimeLock(
    registryDirectory,
    manifestPath,
    input.windowId,
    input.extensionPid,
  );
  const startedAt = new Date().toISOString();
  let disposed = false;
  let ownsManifest = false;
  let writeChain = Promise.resolve();

  const publish = (): Promise<void> => {
    const now = Date.now();
    const manifest: McpWindowManifest = {
      schemaVersion: MCP_MANIFEST_SCHEMA_VERSION,
      ...input,
      startedAt,
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
    };
    writeChain = writeChain.catch(() => undefined).then(async () => {
      await validateSecureMcpRegistryDirectory(registryDirectory);
      await lifetimeLock.assertOwned();
      if (!ownsManifest) {
        await createJsonExclusive(
          registryDirectory,
          manifestPath,
          input.windowId,
          manifest,
        );
        ownsManifest = true;
      } else {
        await refreshOwnedJson(registryDirectory, manifestPath, {
          windowId: input.windowId,
          extensionPid: input.extensionPid,
          token: input.token,
          startedAt,
        }, manifest, options.beforeRefreshCommit);
      }
      await lifetimeLock.assertOwned();
    });
    return writeChain;
  };

  try {
    await publish();
  } catch (error) {
    await lifetimeLock.dispose();
    throw error;
  }
  const heartbeat = setInterval(() => {
    if (!disposed) {
      void publish().catch(() => {
        // A later heartbeat can repair transient I/O failures while the owner
        // still holds its lifetime lock.
      });
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    windowId: input.windowId,
    manifestPath,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(heartbeat);
      await writeChain.catch(() => undefined);
      try {
        await lifetimeLock.assertOwned();
        const current = JSON.parse(await readSecureMcpRegistryFile(
          registryDirectory,
          path.basename(manifestPath),
        )) as Partial<McpWindowManifest>;
        if (current.windowId === input.windowId
          && current.extensionPid === input.extensionPid
          && current.token === input.token
          && current.startedAt === startedAt) {
          await fs.unlink(manifestPath);
        }
      } catch {
        // Missing, corrupt, or replaced records do not belong to this publisher.
      } finally {
        await lifetimeLock.dispose();
      }
    },
  };
}
