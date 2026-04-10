import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { DebugpyInjector, BOOTSTRAP_VERSION } from './debugpyInjector';
import { DebugpyManager, DebugpyProvisioningInfo } from './debugpyManager';
import { DjangoProcess, DjangoProcessFinder } from './processFinder';
import { log, logError } from './logger';

const execFileAsync = promisify(execFile);

export const SETUP_PROFILE_KEY = 'setupProfile';

export type RuntimeSourceKind =
  | 'saved-profile'
  | 'running-process'
  | 'vscode'
  | 'workspace-venv'
  | 'sibling-venv'
  | 'asdf'
  | 'pyenv'
  | 'mise'
  | 'conda'
  | 'poetry'
  | 'pipenv'
  | 'homebrew'
  | 'browse';

export interface SetupProfile {
  pythonPath: string;
  resolvedPythonPath: string;
  sitePackages: string;
  sourceKind: RuntimeSourceKind;
  sourceLabel: string;
  pythonVersion: string;
  bootstrapVersion: string;
  debugpySource: DebugpyProvisioningInfo['source'];
  debugpyVersion?: string;
  lastSetupAt: string;
  lastReason?: string;
  processCommand?: string;
}

export interface RuntimeCandidate {
  pythonPath: string;
  resolvedPythonPath: string;
  sourceKind: RuntimeSourceKind;
  sourceLabel: string;
  displayLabel: string;
  displayDescription: string;
  displayDetail: string;
  sortOrder: number;
  isRecommended: boolean;
  process?: DjangoProcess;
}

export interface RuntimePreflight {
  pythonPath: string;
  resolvedPythonPath: string;
  pythonVersion: string;
  sitePackages: string;
  isVirtualEnv: boolean;
  isWorkspaceLocal: boolean;
  isWritable: boolean;
  canImportPip: boolean;
  debugpySource: DebugpyProvisioningInfo['source'];
  debugpyVersion?: string;
  warnings: string[];
  errors: string[];
}

interface PythonInspectionPayload {
  canImportPip: boolean;
  isVirtualEnv: boolean;
  pythonVersion: string;
  sitePackages: string[];
}

function isSubPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolvePathIfPossible(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return filePath;
  }
}

function describeProcess(processInfo: DjangoProcess): string {
  const kind = processInfo.type === 'celery' ? 'Running Celery worker' : 'Running server';
  const port = processInfo.port ? `:${processInfo.port}` : '';
  return `${kind}${port} (PID ${processInfo.pid})`;
}

function candidateSortLabel(candidate: RuntimeCandidate): string {
  return `${candidate.sortOrder}:${candidate.displayLabel}:${candidate.resolvedPythonPath}`;
}

async function addCandidate(
  bucket: Map<string, RuntimeCandidate>,
  input: Omit<RuntimeCandidate, 'resolvedPythonPath'>,
): Promise<void> {
  try {
    await fs.access(input.pythonPath, fsConstants.F_OK);
  } catch {
    return;
  }

  const resolvedPythonPath = await resolvePathIfPossible(input.pythonPath);
  const existing = bucket.get(resolvedPythonPath);
  const candidate: RuntimeCandidate = { ...input, resolvedPythonPath };

  if (!existing || candidate.sortOrder < existing.sortOrder) {
    bucket.set(resolvedPythonPath, candidate);
  }
}

async function getSelectedPythonInterpreterPath(): Promise<string | undefined> {
  try {
    const pyExt = vscode.extensions.getExtension('ms-python.python');
    if (!pyExt?.isActive) {
      return undefined;
    }

    const execDetails = await vscode.commands.executeCommand<string | { path?: string[] }>(
      'python.interpreterPath',
      { workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.toString() },
    );
    if (typeof execDetails === 'string') {
      return execDetails;
    }
    return execDetails?.path?.[0];
  } catch (err) {
    logError('[RuntimeSetup] Failed to read VS Code selected interpreter', err);
    return undefined;
  }
}

export async function discoverRuntimeCandidates(
  processFinder: DjangoProcessFinder,
  injector: DebugpyInjector,
): Promise<RuntimeCandidate[]> {
  const candidates = new Map<string, RuntimeCandidate>();
  const home = os.homedir();
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const venvNames = ['.venv', 'venv', '.virtualenv', 'env', '.env'];

  const register = async (
    pythonPath: string,
    sourceKind: RuntimeSourceKind,
    sourceLabel: string,
    displayLabel: string,
    displayDescription: string,
    displayDetail: string,
    sortOrder: number,
    isRecommended: boolean,
    process?: DjangoProcess,
  ) => {
    await addCandidate(candidates, {
      pythonPath,
      sourceKind,
      sourceLabel,
      displayLabel,
      displayDescription,
      displayDetail,
      sortOrder,
      isRecommended,
      process,
    });
  };

  const processes = await processFinder.findDjangoProcesses();
  for (const processInfo of processes) {
    let resolvedProcess = processInfo;
    try {
      const resolved = await processFinder.resolveDebuggablePid(processInfo.pid);
      const resolvedPythonPath = await injector.resolvePythonForPid(resolved.pid);
      resolvedProcess = {
        ...processInfo,
        pid: resolved.pid,
        pythonPath: resolvedPythonPath,
      };
    } catch (err) {
      logError(`[RuntimeSetup] Failed to resolve runtime for PID ${processInfo.pid}`, err);
    }

    await register(
      resolvedProcess.pythonPath,
      'running-process',
      describeProcess(resolvedProcess),
      `$(play) ${path.basename(resolvedProcess.pythonPath)}`,
      describeProcess(resolvedProcess),
      `${resolvedProcess.pythonPath}\n${resolvedProcess.command}`,
      10,
      true,
      resolvedProcess,
    );
  }

  const selectedInterpreter = await getSelectedPythonInterpreterPath();
  if (selectedInterpreter) {
    await register(
      selectedInterpreter,
      'vscode',
      'VS Code selected interpreter',
      `$(symbol-misc) ${path.basename(selectedInterpreter)}`,
      'VS Code selected interpreter',
      selectedInterpreter,
      20,
      true,
    );
  }

  for (const folder of workspaceFolders) {
    for (const venvName of venvNames) {
      const pythonPath = path.join(folder.uri.fsPath, venvName, 'bin', 'python');
      await register(
        pythonPath,
        'workspace-venv',
        `${folder.name}/${venvName}`,
        `$(folder) ${folder.name}/${venvName}`,
        'Workspace virtualenv',
        pythonPath,
        30,
        true,
      );
    }
  }

  for (const folder of workspaceFolders) {
    const parentDir = path.dirname(folder.uri.fsPath);
    try {
      const siblings = await fs.readdir(parentDir);
      for (const sibling of siblings) {
        if (sibling === path.basename(folder.uri.fsPath)) {
          continue;
        }
        for (const venvName of ['.venv', 'venv']) {
          const pythonPath = path.join(parentDir, sibling, venvName, 'bin', 'python');
          await register(
            pythonPath,
            'sibling-venv',
            `../${sibling}/${venvName}`,
            `$(folder-library) ../${sibling}/${venvName}`,
            'Sibling project virtualenv',
            pythonPath,
            40,
            false,
          );
        }
      }
    } catch {
      // Ignore unreadable parent directories.
    }
  }

  const versionManagers: Array<{
    sourceKind: RuntimeSourceKind;
    rootDir: string;
    usePythonAlias?: boolean;
    labelPrefix: string;
  }> = [
    {
      sourceKind: 'asdf',
      rootDir: path.join(home, '.asdf', 'installs', 'python'),
      labelPrefix: 'asdf',
    },
    {
      sourceKind: 'pyenv',
      rootDir: process.env.PYENV_ROOT
        ? path.join(process.env.PYENV_ROOT, 'versions')
        : path.join(home, '.pyenv', 'versions'),
      labelPrefix: 'pyenv',
      usePythonAlias: true,
    },
    {
      sourceKind: 'mise',
      rootDir: path.join(home, '.local', 'share', 'mise', 'installs', 'python'),
      labelPrefix: 'mise',
    },
  ];

  for (const manager of versionManagers) {
    try {
      const versions = await fs.readdir(manager.rootDir);
      for (const version of versions) {
        const candidatesToTry = manager.usePythonAlias
          ? ['python3', 'python']
          : ['python3'];
        for (const binaryName of candidatesToTry) {
          await register(
            path.join(manager.rootDir, version, 'bin', binaryName),
            manager.sourceKind,
            `${manager.labelPrefix}: ${version}`,
            `$(package) ${manager.labelPrefix}: ${version}`,
            `${manager.labelPrefix} interpreter`,
            path.join(manager.rootDir, version, 'bin', binaryName),
            50,
            false,
          );
        }
      }
    } catch {
      // Not installed on this machine.
    }
  }

  const condaRoots = [
    path.join(home, 'miniconda3', 'envs'),
    path.join(home, 'anaconda3', 'envs'),
    path.join(home, 'miniforge3', 'envs'),
    path.join(home, '.conda', 'envs'),
  ];
  for (const condaRoot of condaRoots) {
    try {
      const envs = await fs.readdir(condaRoot);
      for (const envName of envs) {
        const pythonPath = path.join(condaRoot, envName, 'bin', 'python');
        await register(
          pythonPath,
          'conda',
          `conda: ${envName}`,
          `$(package) conda: ${envName}`,
          'Conda environment',
          pythonPath,
          60,
          false,
        );
      }
    } catch {
      // Conda not present.
    }
  }

  const poetryRoots = [
    path.join(home, 'Library', 'Caches', 'pypoetry', 'virtualenvs'),
    path.join(home, '.cache', 'pypoetry', 'virtualenvs'),
  ];
  for (const poetryRoot of poetryRoots) {
    try {
      const envs = await fs.readdir(poetryRoot);
      for (const envName of envs) {
        const pythonPath = path.join(poetryRoot, envName, 'bin', 'python');
        await register(
          pythonPath,
          'poetry',
          `poetry: ${envName}`,
          `$(package) poetry: ${envName}`,
          'Poetry virtualenv',
          pythonPath,
          70,
          false,
        );
      }
    } catch {
      // Poetry cache not present.
    }
  }

  const pipenvRoot = path.join(home, '.local', 'share', 'virtualenvs');
  try {
    const envs = await fs.readdir(pipenvRoot);
    for (const envName of envs) {
      const pythonPath = path.join(pipenvRoot, envName, 'bin', 'python');
      await register(
        pythonPath,
        'pipenv',
        `pipenv: ${envName}`,
        `$(package) pipenv: ${envName}`,
        'Pipenv virtualenv',
        pythonPath,
        80,
        false,
      );
    }
  } catch {
    // Pipenv not present.
  }

  for (const brewPrefix of ['/opt/homebrew', '/usr/local']) {
    const pythonPath = path.join(brewPrefix, 'bin', 'python3');
    await register(
      pythonPath,
      'homebrew',
      'homebrew',
      `$(warning) homebrew`,
      'Shared Homebrew Python',
      pythonPath,
      90,
      false,
    );
  }

  return [...candidates.values()].sort((left, right) =>
    candidateSortLabel(left).localeCompare(candidateSortLabel(right))
  );
}

async function inspectPythonInterpreter(pythonPath: string): Promise<PythonInspectionPayload> {
  const inspectionScript = [
    'import importlib.util',
    'import json',
    'import site',
    'import sys',
    'import sysconfig',
    'paths = []',
    'purelib = sysconfig.get_path("purelib")',
    'if purelib:',
    '    paths.append(purelib)',
    'for candidate in getattr(site, "getsitepackages", lambda: [])():',
    '    if candidate not in paths:',
    '        paths.append(candidate)',
    'payload = {',
    '    "canImportPip": importlib.util.find_spec("pip") is not None,',
    '    "isVirtualEnv": bool(getattr(sys, "real_prefix", None) or sys.prefix != getattr(sys, "base_prefix", sys.prefix)),',
    '    "pythonVersion": ".".join(map(str, sys.version_info[:3])),',
    '    "sitePackages": paths,',
    '}',
    'print(json.dumps(payload))',
  ].join('\n');

  const { stdout } = await execFileAsync(pythonPath, ['-c', inspectionScript], { timeout: 10_000 });
  return JSON.parse(stdout.trim()) as PythonInspectionPayload;
}

export async function inspectRuntimePreflight(
  pythonPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
  injector: DebugpyInjector,
  debugpyManager: DebugpyManager,
): Promise<RuntimePreflight> {
  const resolvedPythonPath = await resolvePathIfPossible(pythonPath);
  const warnings: string[] = [];
  const errors: string[] = [];
  const debugpyInfo = await debugpyManager.getProvisioningInfo();

  // Use the original pythonPath (not resolved symlink) for inspection and
  // site-packages resolution, so that venv paths are preserved correctly.
  // When resolvedPythonPath follows symlinks (e.g. .venv/bin/python3 →
  // ~/.asdf/.../python3.11), running the resolved path would return the
  // global site-packages instead of the venv's site-packages.
  let inspection: PythonInspectionPayload | undefined;
  try {
    inspection = await inspectPythonInterpreter(pythonPath);
  } catch (err) {
    logError(`[RuntimeSetup] Failed to inspect Python runtime ${pythonPath}`, err);
    errors.push(`Could not execute ${pythonPath} to inspect the runtime.`);
  }

  let sitePackages = '';
  if (inspection?.sitePackages?.length) {
    sitePackages = inspection.sitePackages[0];
  } else {
    try {
      sitePackages = await injector.resolveSitePackages(pythonPath);
    } catch (err) {
      logError(`[RuntimeSetup] Failed to resolve site-packages for ${pythonPath}`, err);
      errors.push('Could not resolve site-packages for this interpreter.');
    }
  }

  if (sitePackages) {
    try {
      await fs.access(sitePackages, fsConstants.F_OK);
    } catch {
      errors.push(`site-packages does not exist: ${sitePackages}`);
    }
  }

  let isWritable = false;
  if (sitePackages) {
    try {
      await fs.access(sitePackages, fsConstants.W_OK);
      isWritable = true;
    } catch {
      errors.push(`site-packages is not writable: ${sitePackages}`);
    }
  }

  const isWorkspaceLocal = Boolean(
    sitePackages && workspaceFolders?.some((folder) => isSubPath(sitePackages, folder.uri.fsPath))
  );

  const isVirtualEnv = inspection?.isVirtualEnv ?? false;
  if (!isVirtualEnv) {
    warnings.push('This is not a virtualenv. Setup will modify a shared Python runtime.');
  }

  if (!isWorkspaceLocal && /(^\/opt\/homebrew|^\/usr\/local)/.test(resolvedPythonPath)) {
    warnings.push('This looks like a Homebrew/global Python. Other projects may pick up the bootstrap too.');
  }

  if (resolvedPythonPath !== pythonPath) {
    warnings.push(`The selected interpreter resolves to ${resolvedPythonPath}.`);
  }

  if (debugpyInfo.source === 'pip' && !inspection?.canImportPip) {
    errors.push('pip is not available in this interpreter, and vendored debugpy is unavailable.');
  }

  return {
    pythonPath,
    resolvedPythonPath,
    pythonVersion: inspection?.pythonVersion ?? 'unknown',
    sitePackages,
    isVirtualEnv,
    isWorkspaceLocal,
    isWritable,
    canImportPip: inspection?.canImportPip ?? false,
    debugpySource: debugpyInfo.source,
    debugpyVersion: debugpyInfo.version,
    warnings,
    errors,
  };
}

export function createSetupProfile(
  candidate: Pick<RuntimeCandidate, 'process' | 'sourceKind' | 'sourceLabel'>,
  preflight: RuntimePreflight,
  debugpyInfo: DebugpyProvisioningInfo,
  reason: string,
): SetupProfile {
  return {
    pythonPath: preflight.pythonPath,
    resolvedPythonPath: preflight.resolvedPythonPath,
    sitePackages: preflight.sitePackages,
    sourceKind: candidate.sourceKind,
    sourceLabel: candidate.sourceLabel,
    pythonVersion: preflight.pythonVersion,
    bootstrapVersion: BOOTSTRAP_VERSION,
    debugpySource: debugpyInfo.source,
    debugpyVersion: debugpyInfo.version,
    lastSetupAt: new Date().toISOString(),
    lastReason: reason,
    processCommand: candidate.process?.command,
  };
}

export async function getSetupProfile(
  context: vscode.ExtensionContext,
): Promise<SetupProfile | undefined> {
  return context.workspaceState.get<SetupProfile>(SETUP_PROFILE_KEY);
}

export async function saveSetupProfile(
  context: vscode.ExtensionContext,
  profile: SetupProfile,
): Promise<void> {
  await context.workspaceState.update(SETUP_PROFILE_KEY, profile);
}

export async function clearSetupProfile(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(SETUP_PROFILE_KEY, undefined);
}

export function buildSavedProfileCandidate(profile: SetupProfile): RuntimeCandidate {
  return {
    pythonPath: profile.pythonPath,
    resolvedPythonPath: profile.resolvedPythonPath,
    sourceKind: profile.sourceKind,
    sourceLabel: profile.sourceLabel,
    displayLabel: '$(history) Reuse last setup',
    displayDescription: `Last time: ${profile.sourceLabel}`,
    displayDetail: `${profile.pythonPath}\nLast setup: ${profile.lastSetupAt}`,
    sortOrder: 0,
    isRecommended: true,
  };
}

export function formatPreflightForConfirmation(preflight: RuntimePreflight): string {
  const lines = [
    `Python ${preflight.pythonVersion}`,
    `Interpreter: ${preflight.resolvedPythonPath}`,
    `site-packages: ${preflight.sitePackages}`,
    `debugpy source: ${preflight.debugpySource}${preflight.debugpyVersion ? ` ${preflight.debugpyVersion}` : ''}`,
  ];

  if (preflight.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of preflight.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (preflight.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const error of preflight.errors) {
      lines.push(`- ${error}`);
    }
  }

  return lines.join('\n');
}

export async function isProfileStillInstalled(
  profile: SetupProfile,
  injector: DebugpyInjector,
): Promise<boolean> {
  try {
    return await injector.isBootstrapInstalled(profile.sitePackages);
  } catch (err) {
    logError(`[RuntimeSetup] Failed to verify saved profile ${profile.pythonPath}`, err);
    return false;
  }
}
