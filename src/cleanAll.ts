import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Clean All deliberately operates on an allow-list. It must never discover
 * Python installations, processes, language-server caches, or home-directory
 * content on its own.
 */
export const DEFAULT_CLEAN_ALL_ARTIFACT_DIRECTORY = '/tmp/django-process-debugger';

export const CLEAN_ALL_BOOTSTRAP_ASSET_NAMES = [
  'django_process_debugger.pth',
  '_django_debug_bootstrap.py',
  '_django_debug_tracer.py',
] as const;

export interface ManagedRuntimeCleanupTarget {
  /** Exact site-packages recorded by Setup for a managed runtime. */
  sitePackages: string;
  /** Optional UI-only label, such as the saved interpreter path. */
  label?: string;
}

export interface ExtensionOwnedDebugpyStorage {
  /** VS Code ExtensionContext.globalStorageUri.fsPath. */
  storageRoot: string;
  /** DebugpyManager.getDebugpyDir(); must be storageRoot/debugpy. */
  debugpyDirectory: string;
}

export interface CleanAllScope {
  /** Runtime records explicitly selected by the caller (normally SetupProfile). */
  runtimes?: readonly ManagedRuntimeCleanupTarget[];
  /** Target process IDs explicitly selected by the caller. No process is killed. */
  targetPids?: readonly number[];
  /** Injectable for tests; production callers should omit this. */
  artifactDirectory?: string;
  /** Omit to preserve the extension's private debugpy installation. */
  debugpyStorage?: ExtensionOwnedDebugpyStorage;
}

export type CleanAllItemCategory =
  | 'runtime-bootstrap'
  | 'pid-artifact'
  | 'debugpy-storage';

export type CleanAllEntryType =
  | 'missing'
  | 'file'
  | 'directory'
  | 'symbolic-link'
  | 'socket'
  | 'other';

export interface CleanAllPreflightItem {
  category: CleanAllItemCategory;
  path: string;
  target: string;
  entryType: CleanAllEntryType;
  exists: boolean;
}

export type CleanAllIssueCode =
  | 'invalid-site-packages'
  | 'invalid-pid'
  | 'invalid-artifact-directory'
  | 'invalid-debugpy-storage'
  | 'unsafe-entry-type'
  | 'inspection-failed';

export interface CleanAllIssue {
  code: CleanAllIssueCode;
  target: string;
  message: string;
}

export interface CleanAllPreflightCounts {
  checked: number;
  existing: number;
  missing: number;
  issues: number;
}

export interface CleanAllPreflight {
  /** False means execution will fail closed without deleting anything. */
  safe: boolean;
  items: readonly CleanAllPreflightItem[];
  issues: readonly CleanAllIssue[];
  counts: CleanAllPreflightCounts;
  summary: string;
}

export type CleanAllResultStatus =
  | 'would-remove'
  | 'removed'
  | 'missing'
  | 'blocked'
  | 'failed';

export interface CleanAllResultItem extends CleanAllPreflightItem {
  status: CleanAllResultStatus;
  error?: string;
}

export interface CleanAllResultCounts extends CleanAllPreflightCounts {
  wouldRemove: number;
  removed: number;
  blocked: number;
  failed: number;
}

export interface CleanAllResult {
  ok: boolean;
  dryRun: boolean;
  items: readonly CleanAllResultItem[];
  issues: readonly CleanAllIssue[];
  counts: CleanAllResultCounts;
  summary: string;
}

export interface RunCleanAllOptions {
  /** Produce the same validated plan and summary without changing the filesystem. */
  dryRun?: boolean;
}

interface CleanupCandidate {
  category: CleanAllItemCategory;
  path: string;
  target: string;
  operation: 'unlink' | 'remove-directory';
}

interface CandidateCollection {
  candidates: CleanupCandidate[];
  issues: CleanAllIssue[];
}

const SITE_PACKAGES_BASENAMES = new Set(['site-packages', 'dist-packages']);
const BOOTSTRAP_CACHE_PATTERN = /^_(?:django_debug_bootstrap|django_debug_tracer)(?:\.[^.]+)*\.pyc$/;

function fsErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeEntryType(stat: Awaited<ReturnType<typeof fs.lstat>>): CleanAllEntryType {
  if (stat.isSymbolicLink()) { return 'symbolic-link'; }
  if (stat.isFile()) { return 'file'; }
  if (stat.isDirectory()) { return 'directory'; }
  if (stat.isSocket()) { return 'socket'; }
  return 'other';
}

function normalizeAbsoluteNonRoot(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    return undefined;
  }
  if (!path.isAbsolute(input)) {
    return undefined;
  }
  const normalized = path.resolve(input);
  if (normalized === path.parse(normalized).root) {
    return undefined;
  }
  return normalized;
}

function issue(
  code: CleanAllIssueCode,
  target: string,
  message: string,
): CleanAllIssue {
  return { code, target, message };
}

function addCandidate(
  bucket: Map<string, CleanupCandidate>,
  candidate: CleanupCandidate,
): void {
  // Paths are the authority boundary. Deduplicating by normalized path also
  // prevents the same saved runtime from being reported or unlinked twice.
  if (!bucket.has(candidate.path)) {
    bucket.set(candidate.path, candidate);
  }
}

function validateRuntimeTargets(
  runtimes: readonly ManagedRuntimeCleanupTarget[],
  candidates: Map<string, CleanupCandidate>,
  issues: CleanAllIssue[],
): string[] {
  const validSitePackages: string[] = [];
  for (const runtime of runtimes) {
    const normalized = normalizeAbsoluteNonRoot(runtime?.sitePackages);
    const target = runtime?.label || String(runtime?.sitePackages ?? '(missing site-packages)');
    if (!normalized || !SITE_PACKAGES_BASENAMES.has(path.basename(normalized).toLowerCase())) {
      issues.push(issue(
        'invalid-site-packages',
        target,
        'Managed runtime cleanup requires an absolute site-packages or dist-packages path.',
      ));
      continue;
    }

    if (!validSitePackages.includes(normalized)) {
      validSitePackages.push(normalized);
    }
    for (const assetName of CLEAN_ALL_BOOTSTRAP_ASSET_NAMES) {
      addCandidate(candidates, {
        category: 'runtime-bootstrap',
        path: path.join(normalized, assetName),
        target,
        operation: 'unlink',
      });
    }
  }
  return validSitePackages;
}

function validatePids(targetPids: readonly number[], issues: CleanAllIssue[]): number[] {
  const pids = new Set<number>();
  for (const pid of targetPids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      issues.push(issue(
        'invalid-pid',
        String(pid),
        'Cleanup target PID must be a positive safe integer.',
      ));
      continue;
    }
    pids.add(pid);
  }
  return [...pids].sort((left, right) => left - right);
}

function fixedPidArtifactNames(pid: number): string[] {
  return [
    `${pid}.control.sock`,
    `${pid}.bootstrap.json`,
    `${pid}.bootstrap.json.tmp`,
    `${pid}.active`,
    `${pid}.active.tmp`,
    `${pid}.experimental.active`,
    `${pid}.experimental.active.tmp`,
    `${pid}.port`,
    `${pid}.port.tmp`,
    `${pid}.reload`,
    `${pid}.reload.processing`,
    `${pid}.reload.result`,
    `debug-session.${pid}.lock`,
    `debug-session.${pid}.claim`,
  ];
}

function dynamicPidArtifactPattern(pid: number): RegExp {
  return new RegExp([
    `^(?:${pid}\\.reload\\.${pid}-\\d+-[a-z0-9]+-[a-z0-9]+\\.tmp`,
    `${pid}\\.reload\\.result\\.\\d+\\.tmp`,
    `${pid}\\.hot-reload\\.[0-9a-f]{64}\\.lease(?:\\.\\d+\\.[0-9a-f]{16}\\.tmp)?`,
    `debug-session\\.${pid}\\.lock\\.\\d+\\.\\d+\\.[a-z0-9]+\\.tmp)$`,
  ].join('|'));
}

async function inspectArtifactDirectory(
  artifactDirectory: string,
  pids: readonly number[],
  candidates: Map<string, CleanupCandidate>,
  issues: CleanAllIssue[],
): Promise<void> {
  for (const pid of pids) {
    for (const name of fixedPidArtifactNames(pid)) {
      addCandidate(candidates, {
        category: 'pid-artifact',
        path: path.join(artifactDirectory, name),
        target: `PID ${pid}`,
        operation: 'unlink',
      });
    }
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(artifactDirectory);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') {
      return;
    }
    issues.push(issue(
      'inspection-failed',
      artifactDirectory,
      `Could not inspect the extension artifact directory: ${errorMessage(error)}`,
    ));
    return;
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    issues.push(issue(
      'invalid-artifact-directory',
      artifactDirectory,
      'The extension artifact path must be a real directory, not a file or symbolic link.',
    ));
    return;
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    issues.push(issue(
      'invalid-artifact-directory',
      artifactDirectory,
      'The extension artifact directory is not owned by the current user.',
    ));
    return;
  }

  let names: string[];
  try {
    names = await fs.readdir(artifactDirectory);
  } catch (error) {
    issues.push(issue(
      'inspection-failed',
      artifactDirectory,
      `Could not list the extension artifact directory: ${errorMessage(error)}`,
    ));
    return;
  }

  for (const pid of pids) {
    const pattern = dynamicPidArtifactPattern(pid);
    for (const name of names) {
      if (!pattern.test(name)) { continue; }
      addCandidate(candidates, {
        category: 'pid-artifact',
        path: path.join(artifactDirectory, name),
        target: `PID ${pid}`,
        operation: 'unlink',
      });
    }
  }

  // A pre-PID lock is only in scope when its own payload names an explicit PID.
  const legacyLockPath = path.join(artifactDirectory, 'debug-session.lock');
  try {
    const parsed = JSON.parse(await fs.readFile(legacyLockPath, 'utf-8')) as { pid?: unknown };
    if (typeof parsed.pid === 'number' && pids.includes(parsed.pid)) {
      addCandidate(candidates, {
        category: 'pid-artifact',
        path: legacyLockPath,
        target: `PID ${parsed.pid}`,
        operation: 'unlink',
      });
    }
  } catch {
    // Missing, unreadable, or invalid legacy locks cannot be safely attributed
    // to an explicit PID and are intentionally preserved.
  }
}

async function inspectBootstrapCaches(
  sitePackages: readonly string[],
  candidates: Map<string, CleanupCandidate>,
  issues: CleanAllIssue[],
): Promise<void> {
  for (const sitePackagesDirectory of sitePackages) {
    const cacheDirectory = path.join(sitePackagesDirectory, '__pycache__');
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(cacheDirectory);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') { continue; }
      issues.push(issue(
        'inspection-failed',
        cacheDirectory,
        `Could not inspect bootstrap bytecode cache: ${errorMessage(error)}`,
      ));
      continue;
    }
    // Never follow a cache-directory symlink. Source assets are still planned.
    if (stat.isSymbolicLink() || !stat.isDirectory()) { continue; }

    try {
      for (const name of await fs.readdir(cacheDirectory)) {
        if (!BOOTSTRAP_CACHE_PATTERN.test(name)) { continue; }
        addCandidate(candidates, {
          category: 'runtime-bootstrap',
          path: path.join(cacheDirectory, name),
          target: sitePackagesDirectory,
          operation: 'unlink',
        });
      }
    } catch (error) {
      issues.push(issue(
        'inspection-failed',
        cacheDirectory,
        `Could not list bootstrap bytecode cache: ${errorMessage(error)}`,
      ));
    }
  }
}

function validateDebugpyStorage(
  storage: ExtensionOwnedDebugpyStorage | undefined,
  candidates: Map<string, CleanupCandidate>,
  issues: CleanAllIssue[],
): void {
  if (!storage) { return; }
  const storageRoot = normalizeAbsoluteNonRoot(storage.storageRoot);
  const debugpyDirectory = normalizeAbsoluteNonRoot(storage.debugpyDirectory);
  if (
    !storageRoot
    || !debugpyDirectory
    || debugpyDirectory !== path.join(storageRoot, 'debugpy')
  ) {
    issues.push(issue(
      'invalid-debugpy-storage',
      String(storage.debugpyDirectory ?? '(missing debugpy directory)'),
      'Debugpy cleanup is restricted to the debugpy child of extension global storage.',
    ));
    return;
  }
  addCandidate(candidates, {
    category: 'debugpy-storage',
    path: debugpyDirectory,
    target: storageRoot,
    operation: 'remove-directory',
  });
}

async function collectCandidates(scope: CleanAllScope): Promise<CandidateCollection> {
  const candidates = new Map<string, CleanupCandidate>();
  const issues: CleanAllIssue[] = [];
  const runtimes = scope.runtimes ?? [];
  const targetPids = scope.targetPids ?? [];

  const sitePackages = validateRuntimeTargets(runtimes, candidates, issues);
  const pids = validatePids(targetPids, issues);
  await inspectBootstrapCaches(sitePackages, candidates, issues);

  if (targetPids.length > 0) {
    const artifactDirectory = normalizeAbsoluteNonRoot(
      scope.artifactDirectory ?? DEFAULT_CLEAN_ALL_ARTIFACT_DIRECTORY,
    );
    if (!artifactDirectory || path.basename(artifactDirectory) !== 'django-process-debugger') {
      issues.push(issue(
        'invalid-artifact-directory',
        String(scope.artifactDirectory ?? DEFAULT_CLEAN_ALL_ARTIFACT_DIRECTORY),
        'PID artifacts must be inside an absolute django-process-debugger directory.',
      ));
    } else {
      await inspectArtifactDirectory(artifactDirectory, pids, candidates, issues);
    }
  }

  validateDebugpyStorage(scope.debugpyStorage, candidates, issues);
  return { candidates: [...candidates.values()], issues };
}

async function inspectCandidate(
  candidate: CleanupCandidate,
  issues: CleanAllIssue[],
): Promise<CleanAllPreflightItem> {
  try {
    const stat = await fs.lstat(candidate.path);
    const entryType = describeEntryType(stat);
    const unlinkSafe = candidate.operation === 'unlink' && entryType !== 'directory';
    const directorySafe = candidate.operation === 'remove-directory' && entryType === 'directory';
    const directoryOwned = candidate.operation !== 'remove-directory'
      || typeof process.getuid !== 'function'
      || stat.uid === process.getuid();
    if (!unlinkSafe && !directorySafe) {
      issues.push(issue(
        'unsafe-entry-type',
        candidate.path,
        candidate.operation === 'remove-directory'
          ? 'Extension-owned debugpy storage must be a real directory.'
          : 'A managed file or socket unexpectedly resolves to a directory.',
      ));
    } else if (!directoryOwned) {
      issues.push(issue(
        'invalid-debugpy-storage',
        candidate.path,
        'Extension-owned debugpy storage is not owned by the current user.',
      ));
    }
    return {
      category: candidate.category,
      path: candidate.path,
      target: candidate.target,
      entryType,
      exists: true,
    };
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') {
      return {
        category: candidate.category,
        path: candidate.path,
        target: candidate.target,
        entryType: 'missing',
        exists: false,
      };
    }
    issues.push(issue(
      'inspection-failed',
      candidate.path,
      `Could not inspect managed cleanup target: ${errorMessage(error)}`,
    ));
    return {
      category: candidate.category,
      path: candidate.path,
      target: candidate.target,
      entryType: 'other',
      exists: true,
    };
  }
}

function preflightCounts(
  items: readonly CleanAllPreflightItem[],
  issues: readonly CleanAllIssue[],
): CleanAllPreflightCounts {
  const existing = items.filter((item) => item.exists).length;
  return {
    checked: items.length,
    existing,
    missing: items.length - existing,
    issues: issues.length,
  };
}

function preflightSummary(counts: CleanAllPreflightCounts): string {
  if (counts.issues > 0) {
    return `Cleanup blocked by ${counts.issues} safety issue(s); ${counts.existing} managed item(s) found.`;
  }
  return `${counts.existing} managed item(s) ready to remove; ${counts.missing} already absent.`;
}

/** Inspect and summarize the exact allow-listed cleanup scope without writing. */
export async function preflightCleanAll(scope: CleanAllScope): Promise<CleanAllPreflight> {
  const collected = await collectCandidates(scope);
  const issues = [...collected.issues];
  const items: CleanAllPreflightItem[] = [];
  for (const candidate of collected.candidates) {
    items.push(await inspectCandidate(candidate, issues));
  }
  items.sort((left, right) => left.path.localeCompare(right.path));
  const counts = preflightCounts(items, issues);
  return {
    safe: issues.length === 0,
    items,
    issues,
    counts,
    summary: preflightSummary(counts),
  };
}

function resultCounts(
  preflight: CleanAllPreflight,
  items: readonly CleanAllResultItem[],
): CleanAllResultCounts {
  const withStatus = (status: CleanAllResultStatus) =>
    items.filter((item) => item.status === status).length;
  return {
    ...preflight.counts,
    missing: withStatus('missing'),
    wouldRemove: withStatus('would-remove'),
    removed: withStatus('removed'),
    blocked: withStatus('blocked'),
    failed: withStatus('failed'),
  };
}

function resultSummary(dryRun: boolean, counts: CleanAllResultCounts): string {
  if (counts.issues > 0) {
    return `Cleanup blocked by ${counts.issues} safety issue(s); no files were removed.`;
  }
  if (dryRun) {
    return `Dry run: ${counts.wouldRemove} managed item(s) would be removed; ${counts.missing} already absent.`;
  }
  const failed = counts.failed > 0 ? `; ${counts.failed} failed` : '';
  return `Removed ${counts.removed} managed item(s); ${counts.missing} already absent${failed}.`;
}

async function removePreflightItem(item: CleanAllPreflightItem): Promise<CleanAllResultItem> {
  try {
    const current = await fs.lstat(item.path);
    if (item.category === 'debugpy-storage') {
      if (current.isSymbolicLink() || !current.isDirectory()) {
        return {
          ...item,
          entryType: describeEntryType(current),
          status: 'failed',
          error: 'Refused to recursively remove debugpy storage after its type changed.',
        };
      }
      await fs.rm(item.path, { recursive: true, force: false });
    } else {
      if (current.isDirectory()) {
        return {
          ...item,
          entryType: 'directory',
          status: 'failed',
          error: 'Refused to recursively remove a managed file target.',
        };
      }
      await fs.unlink(item.path);
    }
    return { ...item, status: 'removed' };
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') {
      return { ...item, entryType: 'missing', exists: false, status: 'missing' };
    }
    return { ...item, status: 'failed', error: errorMessage(error) };
  }
}

/**
 * Execute an allow-listed cleanup, or return a dry-run result. Validation is
 * repeated immediately before execution and any issue blocks the whole batch.
 */
export async function runCleanAll(
  scope: CleanAllScope,
  options: RunCleanAllOptions = {},
): Promise<CleanAllResult> {
  const dryRun = options.dryRun ?? false;
  const preflight = await preflightCleanAll(scope);
  let items: CleanAllResultItem[];

  if (!preflight.safe) {
    items = preflight.items.map((item) => ({
      ...item,
      status: item.exists ? 'blocked' : 'missing',
    }));
  } else if (dryRun) {
    items = preflight.items.map((item) => ({
      ...item,
      status: item.exists ? 'would-remove' : 'missing',
    }));
  } else {
    items = [];
    for (const item of preflight.items) {
      items.push(item.exists
        ? await removePreflightItem(item)
        : { ...item, status: 'missing' });
    }
  }

  const counts = resultCounts(preflight, items);
  return {
    ok: preflight.safe && counts.failed === 0,
    dryRun,
    items,
    issues: preflight.issues,
    counts,
    summary: resultSummary(dryRun, counts),
  };
}
