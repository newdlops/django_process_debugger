import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DEFAULT_MCP_LAUNCHER_PATH,
  DEFAULT_MCP_RUNTIME_PATH,
  MCP_SERVER_NAME,
  StdioEntryOptions,
  mcpLauncherSource,
  mergeClaudeMcpConfig,
  mergeCodexMcpConfig,
} from './setup';
import {
  MCP_REGISTRY_DIR_ENV,
  MCP_WINDOW_ID_ENV,
  ManifestDiscoveryOptions,
  McpBridgeError,
  checkMcpWindowHealth,
  discoverMcpWindow,
} from './stdioBridge';
import type { McpWindowManifest } from './windowRegistry';

const RUNTIME_BRIDGE_NAME = 'stdioBridge.js';
const RUNTIME_REGISTRY_NAME = 'windowRegistry.js';
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 32 * 1024 * 1024;

export const MCP_DIAGNOSTIC_CODES = Object.freeze({
  WORKSPACE_MISSING: 'MCP_WORKSPACE_MISSING',
  WORKSPACE_NOT_DIRECTORY: 'MCP_WORKSPACE_NOT_DIRECTORY',
  WORKSPACE_UNREADABLE: 'MCP_WORKSPACE_UNREADABLE',

  CLAUDE_CONFIG_MISSING: 'CLAUDE_CONFIG_MISSING',
  CLAUDE_CONFIG_SYMLINK: 'CLAUDE_CONFIG_SYMLINK',
  CLAUDE_CONFIG_NOT_FILE: 'CLAUDE_CONFIG_NOT_FILE',
  CLAUDE_CONFIG_TOO_LARGE: 'CLAUDE_CONFIG_TOO_LARGE',
  CLAUDE_CONFIG_UNREADABLE: 'CLAUDE_CONFIG_UNREADABLE',
  CLAUDE_CONFIG_INVALID: 'CLAUDE_CONFIG_INVALID',
  CLAUDE_SERVER_MISSING: 'CLAUDE_MCP_SERVER_MISSING',
  CLAUDE_SERVER_STALE: 'CLAUDE_MCP_SERVER_STALE',

  CODEX_CONFIG_MISSING: 'CODEX_CONFIG_MISSING',
  CODEX_CONFIG_SYMLINK: 'CODEX_CONFIG_SYMLINK',
  CODEX_CONFIG_NOT_FILE: 'CODEX_CONFIG_NOT_FILE',
  CODEX_CONFIG_TOO_LARGE: 'CODEX_CONFIG_TOO_LARGE',
  CODEX_CONFIG_UNREADABLE: 'CODEX_CONFIG_UNREADABLE',
  CODEX_CONFIG_INVALID: 'CODEX_CONFIG_INVALID',
  CODEX_SERVER_MISSING: 'CODEX_MCP_SERVER_MISSING',
  CODEX_SERVER_STALE: 'CODEX_MCP_SERVER_STALE',

  LAUNCHER_MISSING: 'MCP_LAUNCHER_MISSING',
  LAUNCHER_SYMLINK: 'MCP_LAUNCHER_SYMLINK',
  LAUNCHER_NOT_FILE: 'MCP_LAUNCHER_NOT_FILE',
  LAUNCHER_TOO_LARGE: 'MCP_LAUNCHER_TOO_LARGE',
  LAUNCHER_UNREADABLE: 'MCP_LAUNCHER_UNREADABLE',
  LAUNCHER_STALE: 'MCP_LAUNCHER_STALE',

  RUNTIME_BRIDGE_MISSING: 'MCP_RUNTIME_BRIDGE_MISSING',
  RUNTIME_BRIDGE_SYMLINK: 'MCP_RUNTIME_BRIDGE_SYMLINK',
  RUNTIME_BRIDGE_NOT_FILE: 'MCP_RUNTIME_BRIDGE_NOT_FILE',
  RUNTIME_BRIDGE_TOO_LARGE: 'MCP_RUNTIME_BRIDGE_TOO_LARGE',
  RUNTIME_BRIDGE_UNREADABLE: 'MCP_RUNTIME_BRIDGE_UNREADABLE',
  RUNTIME_BRIDGE_STALE: 'MCP_RUNTIME_BRIDGE_STALE',

  RUNTIME_REGISTRY_MISSING: 'MCP_RUNTIME_REGISTRY_MISSING',
  RUNTIME_REGISTRY_SYMLINK: 'MCP_RUNTIME_REGISTRY_SYMLINK',
  RUNTIME_REGISTRY_NOT_FILE: 'MCP_RUNTIME_REGISTRY_NOT_FILE',
  RUNTIME_REGISTRY_TOO_LARGE: 'MCP_RUNTIME_REGISTRY_TOO_LARGE',
  RUNTIME_REGISTRY_UNREADABLE: 'MCP_RUNTIME_REGISTRY_UNREADABLE',
  RUNTIME_REGISTRY_STALE: 'MCP_RUNTIME_REGISTRY_STALE',

  SOURCE_BRIDGE_MISSING: 'MCP_EXTENSION_SOURCE_BRIDGE_MISSING',
  SOURCE_BRIDGE_SYMLINK: 'MCP_EXTENSION_SOURCE_BRIDGE_SYMLINK',
  SOURCE_BRIDGE_NOT_FILE: 'MCP_EXTENSION_SOURCE_BRIDGE_NOT_FILE',
  SOURCE_BRIDGE_TOO_LARGE: 'MCP_EXTENSION_SOURCE_BRIDGE_TOO_LARGE',
  SOURCE_BRIDGE_UNREADABLE: 'MCP_EXTENSION_SOURCE_BRIDGE_UNREADABLE',

  SOURCE_REGISTRY_MISSING: 'MCP_EXTENSION_SOURCE_REGISTRY_MISSING',
  SOURCE_REGISTRY_SYMLINK: 'MCP_EXTENSION_SOURCE_REGISTRY_SYMLINK',
  SOURCE_REGISTRY_NOT_FILE: 'MCP_EXTENSION_SOURCE_REGISTRY_NOT_FILE',
  SOURCE_REGISTRY_TOO_LARGE: 'MCP_EXTENSION_SOURCE_REGISTRY_TOO_LARGE',
  SOURCE_REGISTRY_UNREADABLE: 'MCP_EXTENSION_SOURCE_REGISTRY_UNREADABLE',

  LIVE_WINDOW_NOT_FOUND: 'MCP_LIVE_WINDOW_NOT_FOUND',
  LIVE_WINDOW_UNHEALTHY: 'MCP_LIVE_WINDOW_UNHEALTHY',
  LIVE_WINDOW_AMBIGUOUS: 'MCP_LIVE_WINDOW_AMBIGUOUS',
  LIVE_WINDOW_REGISTRY_UNSAFE: 'MCP_LIVE_WINDOW_REGISTRY_UNSAFE',
  LIVE_WINDOW_DISCOVERY_FAILED: 'MCP_LIVE_WINDOW_DISCOVERY_FAILED',
} as const);

export type McpDiagnosticIssueCode = typeof MCP_DIAGNOSTIC_CODES[
  keyof typeof MCP_DIAGNOSTIC_CODES
];

export type McpDiagnosticSeverity = 'error' | 'warning';

export type McpDiagnosticComponent =
  | 'workspace'
  | 'claudeConfig'
  | 'codexConfig'
  | 'launcher'
  | 'runtimeBridge'
  | 'runtimeRegistry'
  | 'extensionBridgeSource'
  | 'extensionRegistrySource'
  | 'liveWindow';

export interface McpDiagnosticIssue {
  code: McpDiagnosticIssueCode;
  severity: McpDiagnosticSeverity;
  component: McpDiagnosticComponent;
  message: string;
  /** Whether rerunning the normal workspace setup can repair this issue. */
  repairable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export type McpFileDiagnosticState =
  | 'regular'
  | 'missing'
  | 'symlink'
  | 'notFile'
  | 'tooLarge'
  | 'unreadable'
  | 'skipped';

export interface McpFileDiagnostic {
  path: string;
  state: McpFileDiagnosticState;
  exists: boolean;
  isRegularFile: boolean;
  isSymbolicLink: boolean;
  size?: number;
  sha256?: string;
}

export type McpConfigDiagnosticState =
  | 'current'
  | 'missing'
  | 'invalid'
  | 'stale'
  | 'unsafe'
  | 'unreadable'
  | 'skipped';

export interface McpConfigDiagnostic {
  path: string;
  state: McpConfigDiagnosticState;
  exists: boolean;
  entryPresent: boolean;
  current: boolean;
}

export interface McpRuntimeCopyDiagnostic {
  source: McpFileDiagnostic;
  copy: McpFileDiagnostic;
  current: boolean | null;
  byteEqual: boolean | null;
}

export type McpLiveWindowState =
  | 'healthy'
  | 'missing'
  | 'unhealthy'
  | 'ambiguous'
  | 'error'
  | 'skipped';

export interface McpSafeWindowManifest {
  windowId: string;
  extensionPid: number;
  url: string;
  extensionVersion: string;
  startedAt: string;
  updatedAt: string;
  leaseExpiresAt: string;
  workspaceFolders: Array<{
    name: string;
    uri: string;
    canonicalPath: string;
  }>;
}

export interface McpLiveWindowDiagnostic {
  state: McpLiveWindowState;
  healthy: boolean;
  healthChecks: number;
  healthyCandidates: number;
  manifest?: McpSafeWindowManifest;
}

export interface McpWorkspaceDiagnosticPaths {
  workspaceRoot: string;
  claudeConfig: string;
  codexConfig: string;
  launcher: string;
  runtimeBridge: string;
  runtimeRegistry: string;
  extensionBridgeSource: string;
  extensionRegistrySource: string;
}

export interface McpWorkspaceDiagnostics {
  /** True only when installation, runtime freshness, and the live endpoint all verify. */
  ok: boolean;
  /** Both client entries and all three workspace artifacts are present as regular files. */
  installed: boolean;
  /** Stronger than installed: configs/current runtime/live endpoint all verify. */
  verified: boolean;
  /** Workspace installation requires repair; live-window-only failures do not set this. */
  repairNeeded: boolean;
  paths: McpWorkspaceDiagnosticPaths;
  configs: {
    claude: McpConfigDiagnostic;
    codex: McpConfigDiagnostic;
  };
  launcher: McpFileDiagnostic;
  runtime: {
    bridge: McpRuntimeCopyDiagnostic;
    registry: McpRuntimeCopyDiagnostic;
    current: boolean;
  };
  liveWindow: McpLiveWindowDiagnostic;
  issues: McpDiagnosticIssue[];
}

export interface McpWorkspaceDiagnosticsOptions {
  workspaceRoot: string;
  /** Compiled extension source at out/mcp/stdioBridge.js. */
  bridgeModulePath: string;
  launcherPath?: string;
  claudeConfigPath?: string;
  codexConfigPath?: string;
  nodeCommand?: string;
  registryDir?: string;
  windowId?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  parentPid?: number;
  isProcessAlive?: (pid: number) => boolean;
  healthCheck?: (manifest: McpWindowManifest) => Promise<boolean>;
  discoverWindow?: (options: ManifestDiscoveryOptions) => Promise<McpWindowManifest>;
}

interface SafeFileRead {
  diagnostic: McpFileDiagnostic;
  data?: Buffer;
}

interface ArtifactIssueCodes {
  missing: McpDiagnosticIssueCode;
  symlink: McpDiagnosticIssueCode;
  notFile: McpDiagnosticIssueCode;
  tooLarge: McpDiagnosticIssueCode;
  unreadable: McpDiagnosticIssueCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function skippedFile(filePath: string): McpFileDiagnostic {
  return {
    path: filePath,
    state: 'skipped',
    exists: false,
    isRegularFile: false,
    isSymbolicLink: false,
  };
}

function skippedConfig(filePath: string): McpConfigDiagnostic {
  return {
    path: filePath,
    state: 'skipped',
    exists: false,
    entryPresent: false,
    current: false,
  };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function readBounded(handle: fs.FileHandle, maximumBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    const remaining = maximumBytes - position;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, remaining + 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, position);
    }
    position += bytesRead;
    if (position > maximumBytes) {
      return undefined;
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
}

/** Inspect and read a path without following a stable symbolic link. */
async function inspectRegularFile(
  filePath: string,
  maximumBytes: number,
): Promise<SafeFileRead> {
  let linkInfo;
  try {
    linkInfo = await fs.lstat(filePath);
  } catch (error) {
    if (isMissing(error)) {
      return {
        diagnostic: {
          path: filePath,
          state: 'missing',
          exists: false,
          isRegularFile: false,
          isSymbolicLink: false,
        },
      };
    }
    return {
      diagnostic: {
        path: filePath,
        state: 'unreadable',
        exists: true,
        isRegularFile: false,
        isSymbolicLink: false,
      },
    };
  }

  if (linkInfo.isSymbolicLink()) {
    return {
      diagnostic: {
        path: filePath,
        state: 'symlink',
        exists: true,
        isRegularFile: false,
        isSymbolicLink: true,
        size: linkInfo.size,
      },
    };
  }
  if (!linkInfo.isFile()) {
    return {
      diagnostic: {
        path: filePath,
        state: 'notFile',
        exists: true,
        isRegularFile: false,
        isSymbolicLink: false,
        size: linkInfo.size,
      },
    };
  }
  if (linkInfo.size > maximumBytes) {
    return {
      diagnostic: {
        path: filePath,
        state: 'tooLarge',
        exists: true,
        isRegularFile: true,
        isSymbolicLink: false,
        size: linkInfo.size,
      },
    };
  }

  let handle: fs.FileHandle | undefined;
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) {
      return {
        diagnostic: {
          path: filePath,
          state: 'notFile',
          exists: true,
          isRegularFile: false,
          isSymbolicLink: false,
          size: openedInfo.size,
        },
      };
    }
    if (openedInfo.size > maximumBytes) {
      return {
        diagnostic: {
          path: filePath,
          state: 'tooLarge',
          exists: true,
          isRegularFile: true,
          isSymbolicLink: false,
          size: openedInfo.size,
        },
      };
    }
    const data = await readBounded(handle, maximumBytes);
    if (data === undefined) {
      return {
        diagnostic: {
          path: filePath,
          state: 'tooLarge',
          exists: true,
          isRegularFile: true,
          isSymbolicLink: false,
          size: maximumBytes + 1,
        },
      };
    }
    return {
      diagnostic: {
        path: filePath,
        state: 'regular',
        exists: true,
        isRegularFile: true,
        isSymbolicLink: false,
        size: data.length,
        sha256: sha256(data),
      },
      data,
    };
  } catch {
    return {
      diagnostic: {
        path: filePath,
        state: 'unreadable',
        exists: true,
        isRegularFile: false,
        isSymbolicLink: false,
      },
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Reject symbolic links in every workspace-relative parent component too. */
async function inspectWorkspaceRegularFile(
  workspaceRoot: string,
  filePath: string,
  maximumBytes: number,
): Promise<SafeFileRead> {
  const relative = path.relative(workspaceRoot, filePath);
  if (relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    return {
      diagnostic: {
        path: filePath,
        state: 'unreadable',
        exists: false,
        isRegularFile: false,
        isSymbolicLink: false,
      },
    };
  }

  const parentParts = relative.split(path.sep).slice(0, -1);
  let current = workspaceRoot;
  for (const part of parentParts) {
    current = path.join(current, part);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        return {
          diagnostic: {
            path: filePath,
            state: 'missing',
            exists: false,
            isRegularFile: false,
            isSymbolicLink: false,
          },
        };
      }
      return {
        diagnostic: {
          path: filePath,
          state: 'unreadable',
          exists: false,
          isRegularFile: false,
          isSymbolicLink: false,
        },
      };
    }
    if (info.isSymbolicLink()) {
      return {
        diagnostic: {
          path: filePath,
          state: 'symlink',
          exists: true,
          isRegularFile: false,
          isSymbolicLink: true,
        },
      };
    }
    if (!info.isDirectory()) {
      return {
        diagnostic: {
          path: filePath,
          state: 'notFile',
          exists: true,
          isRegularFile: false,
          isSymbolicLink: false,
        },
      };
    }
  }

  try {
    const realParent = await fs.realpath(path.dirname(filePath));
    const realRelative = path.relative(workspaceRoot, realParent);
    if (realRelative === '..'
      || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative)) {
      return {
        diagnostic: {
          path: filePath,
          state: 'symlink',
          exists: true,
          isRegularFile: false,
          isSymbolicLink: true,
        },
      };
    }
  } catch (error) {
    return {
      diagnostic: {
        path: filePath,
        state: isMissing(error) ? 'missing' : 'unreadable',
        exists: false,
        isRegularFile: false,
        isSymbolicLink: false,
      },
    };
  }
  return inspectRegularFile(filePath, maximumBytes);
}

function addFileIssue(
  issues: McpDiagnosticIssue[],
  component: McpDiagnosticComponent,
  label: string,
  diagnostic: McpFileDiagnostic,
  codes: ArtifactIssueCodes,
  workspaceRepair: boolean,
): void {
  if (diagnostic.state === 'regular' || diagnostic.state === 'skipped') {
    return;
  }
  const code = codes[diagnostic.state as keyof ArtifactIssueCodes];
  if (!code) {
    return;
  }
  const stateMessage: Record<Exclude<McpFileDiagnosticState, 'regular' | 'skipped'>, string> = {
    missing: 'is missing',
    symlink: 'is a symbolic link',
    notFile: 'is not a regular file',
    tooLarge: 'is too large to inspect safely',
    unreadable: 'could not be read',
  };
  issues.push({
    code,
    severity: 'error',
    component,
    message: `${label} ${stateMessage[diagnostic.state as keyof typeof stateMessage]}.`,
    repairable: workspaceRepair && diagnostic.state === 'missing',
    details: {
      path: diagnostic.path,
      ...(diagnostic.size === undefined ? {} : { size: diagnostic.size }),
    },
  });
}

function resolveWorkspacePath(workspaceRoot: string, candidate: string): string {
  const resolved = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new TypeError(`MCP diagnostics path must be inside the workspace: ${candidate}`);
  }
  return resolved;
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<{
  root: string;
  issue?: McpDiagnosticIssue;
}> {
  const resolved = path.resolve(workspaceRoot);
  let info;
  try {
    info = await fs.stat(resolved);
  } catch (error) {
    if (isMissing(error)) {
      return {
        root: resolved,
        issue: {
          code: MCP_DIAGNOSTIC_CODES.WORKSPACE_MISSING,
          severity: 'error',
          component: 'workspace',
          message: 'The MCP workspace root is missing.',
          repairable: false,
          details: { path: resolved },
        },
      };
    }
    return {
      root: resolved,
      issue: {
        code: MCP_DIAGNOSTIC_CODES.WORKSPACE_UNREADABLE,
        severity: 'error',
        component: 'workspace',
        message: 'The MCP workspace root could not be inspected.',
        repairable: false,
        details: { path: resolved, error: errorMessage(error) },
      },
    };
  }
  if (!info.isDirectory()) {
    return {
      root: resolved,
      issue: {
        code: MCP_DIAGNOSTIC_CODES.WORKSPACE_NOT_DIRECTORY,
        severity: 'error',
        component: 'workspace',
        message: 'The MCP workspace root is not a directory.',
        repairable: false,
        details: { path: resolved },
      },
    };
  }
  try {
    return { root: await fs.realpath(resolved) };
  } catch (error) {
    return {
      root: resolved,
      issue: {
        code: MCP_DIAGNOSTIC_CODES.WORKSPACE_UNREADABLE,
        severity: 'error',
        component: 'workspace',
        message: 'The canonical MCP workspace root could not be resolved.',
        repairable: false,
        details: { path: resolved, error: errorMessage(error) },
      },
    };
  }
}

function configStateForFile(file: McpFileDiagnostic): McpConfigDiagnosticState {
  switch (file.state) {
    case 'missing':
      return 'missing';
    case 'symlink':
    case 'notFile':
      return 'unsafe';
    case 'tooLarge':
    case 'unreadable':
      return 'unreadable';
    case 'skipped':
      return 'skipped';
    case 'regular':
      return 'current';
  }
}

function addConfigFileIssue(
  issues: McpDiagnosticIssue[],
  kind: 'claude' | 'codex',
  file: McpFileDiagnostic,
): void {
  if (file.state === 'regular' || file.state === 'skipped') {
    return;
  }
  const isClaude = kind === 'claude';
  const component: McpDiagnosticComponent = isClaude ? 'claudeConfig' : 'codexConfig';
  const label = isClaude ? 'Claude MCP config' : 'Codex MCP config';
  const codes: ArtifactIssueCodes = isClaude
    ? {
      missing: MCP_DIAGNOSTIC_CODES.CLAUDE_CONFIG_MISSING,
      symlink: MCP_DIAGNOSTIC_CODES.CLAUDE_CONFIG_SYMLINK,
      notFile: MCP_DIAGNOSTIC_CODES.CLAUDE_CONFIG_NOT_FILE,
      tooLarge: MCP_DIAGNOSTIC_CODES.CLAUDE_CONFIG_TOO_LARGE,
      unreadable: MCP_DIAGNOSTIC_CODES.CLAUDE_CONFIG_UNREADABLE,
    }
    : {
      missing: MCP_DIAGNOSTIC_CODES.CODEX_CONFIG_MISSING,
      symlink: MCP_DIAGNOSTIC_CODES.CODEX_CONFIG_SYMLINK,
      notFile: MCP_DIAGNOSTIC_CODES.CODEX_CONFIG_NOT_FILE,
      tooLarge: MCP_DIAGNOSTIC_CODES.CODEX_CONFIG_TOO_LARGE,
      unreadable: MCP_DIAGNOSTIC_CODES.CODEX_CONFIG_UNREADABLE,
    };
  addFileIssue(issues, component, label, file, codes, true);
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diagnoseClaudeConfig(
  file: SafeFileRead,
  entryOptions: StdioEntryOptions,
  issues: McpDiagnosticIssue[],
): McpConfigDiagnostic {
  const base = {
    path: file.diagnostic.path,
    exists: file.diagnostic.exists,
    entryPresent: false,
    current: false,
  };
  if (file.diagnostic.state !== 'regular' || file.data === undefined) {
    addConfigFileIssue(issues, 'claude', file.diagnostic);
    return { ...base, state: configStateForFile(file.diagnostic) };
  }

  let parsed: unknown = {};
  const text = file.data.toString('utf8');
  try {
    if (text.trim() !== '') {
      parsed = JSON.parse(text) as unknown;
    }
  } catch (error) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.CLAUDE_CONFIG_INVALID,
      severity: 'error',
      component: 'claudeConfig',
      message: 'Claude MCP config is not valid JSON.',
      repairable: false,
      details: { path: file.diagnostic.path, error: errorMessage(error) },
    });
    return { ...base, state: 'invalid' };
  }
  if (!isRecord(parsed)
    || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.CLAUDE_CONFIG_INVALID,
      severity: 'error',
      component: 'claudeConfig',
      message: 'Claude MCP config root and mcpServers values must be objects.',
      repairable: false,
      details: { path: file.diagnostic.path },
    });
    return { ...base, state: 'invalid' };
  }
  if (!isRecord(parsed.mcpServers)) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.CLAUDE_SERVER_MISSING,
      severity: 'error',
      component: 'claudeConfig',
      message: 'Claude MCP config does not contain the djangoDebugger server.',
      repairable: true,
      details: { path: file.diagnostic.path },
    });
    return { ...base, state: 'missing' };
  }
  const entry = parsed.mcpServers[MCP_SERVER_NAME];
  if (!isRecord(entry)) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.CLAUDE_SERVER_MISSING,
      severity: 'error',
      component: 'claudeConfig',
      message: 'Claude MCP config does not contain the djangoDebugger server.',
      repairable: true,
      details: { path: file.diagnostic.path },
    });
    return { ...base, state: 'missing' };
  }
  const expectedRoot = JSON.parse(mergeClaudeMcpConfig(undefined, entryOptions)) as unknown;
  const expected = isRecord(expectedRoot)
    && isRecord(expectedRoot.mcpServers)
    ? expectedRoot.mcpServers[MCP_SERVER_NAME]
    : undefined;
  const current = isRecord(expected)
    && entry.type === expected.type
    && entry.command === expected.command
    && deepEqualJson(entry.args, expected.args);
  if (!current) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.CLAUDE_SERVER_STALE,
      severity: 'error',
      component: 'claudeConfig',
      message: 'Claude djangoDebugger server configuration is stale.',
      repairable: true,
      details: { path: file.diagnostic.path },
    });
  }
  return {
    ...base,
    state: current ? 'current' : 'stale',
    entryPresent: true,
    current,
  };
}

const CODEX_SERVER_TABLE = new RegExp(
  String.raw`^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:djangoDebugger|"djangoDebugger"|'djangoDebugger')\s*\]`,
  'm',
);

function diagnoseCodexConfig(
  file: SafeFileRead,
  entryOptions: StdioEntryOptions,
  issues: McpDiagnosticIssue[],
): McpConfigDiagnostic {
  const base = {
    path: file.diagnostic.path,
    exists: file.diagnostic.exists,
    entryPresent: false,
    current: false,
  };
  if (file.diagnostic.state !== 'regular' || file.data === undefined) {
    addConfigFileIssue(issues, 'codex', file.diagnostic);
    return { ...base, state: configStateForFile(file.diagnostic) };
  }

  const text = file.data.toString('utf8');
  const entryPresent = CODEX_SERVER_TABLE.test(text);
  let expected: string;
  try {
    expected = mergeCodexMcpConfig(text, entryOptions);
  } catch (error) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.CODEX_CONFIG_INVALID,
      severity: 'error',
      component: 'codexConfig',
      message: 'Codex MCP config has an unsupported or conflicting djangoDebugger definition.',
      repairable: false,
      details: { path: file.diagnostic.path, error: errorMessage(error) },
    });
    return { ...base, state: 'invalid', entryPresent };
  }
  if (!entryPresent) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.CODEX_SERVER_MISSING,
      severity: 'error',
      component: 'codexConfig',
      message: 'Codex MCP config does not contain the djangoDebugger server.',
      repairable: true,
      details: { path: file.diagnostic.path },
    });
    return { ...base, state: 'missing' };
  }
  const current = expected === text;
  if (!current) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.CODEX_SERVER_STALE,
      severity: 'error',
      component: 'codexConfig',
      message: 'Codex djangoDebugger server configuration is stale.',
      repairable: true,
      details: { path: file.diagnostic.path },
    });
  }
  return {
    ...base,
    state: current ? 'current' : 'stale',
    entryPresent: true,
    current,
  };
}

function safeManifest(manifest: McpWindowManifest): McpSafeWindowManifest {
  return {
    windowId: manifest.windowId,
    extensionPid: manifest.extensionPid,
    url: manifest.url,
    extensionVersion: manifest.extensionVersion,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    leaseExpiresAt: manifest.leaseExpiresAt,
    workspaceFolders: manifest.workspaceFolders.map((folder) => ({
      name: folder.name,
      uri: folder.uri,
      canonicalPath: folder.canonicalPath,
    })),
  };
}

async function diagnoseLiveWindow(
  options: McpWorkspaceDiagnosticsOptions,
  workspaceRoot: string,
  issues: McpDiagnosticIssue[],
): Promise<McpLiveWindowDiagnostic> {
  let healthChecks = 0;
  let healthyCandidates = 0;
  const healthCheck = options.healthCheck ?? checkMcpWindowHealth;
  const instrumentedHealthCheck = async (manifest: McpWindowManifest): Promise<boolean> => {
    healthChecks++;
    try {
      const healthy = await healthCheck(manifest);
      if (healthy) {
        healthyCandidates++;
      }
      return healthy;
    } catch {
      return false;
    }
  };
  const discover = options.discoverWindow ?? discoverMcpWindow;
  try {
    const manifest = await discover({
      workspacePath: workspaceRoot,
      windowId: options.windowId,
      registryDir: options.registryDir,
      env: options.env,
      now: options.now,
      parentPid: options.parentPid,
      isProcessAlive: options.isProcessAlive,
      healthCheck: instrumentedHealthCheck,
    });
    return {
      state: 'healthy',
      healthy: true,
      healthChecks,
      healthyCandidates: Math.max(1, healthyCandidates),
      manifest: safeManifest(manifest),
    };
  } catch (error) {
    if (error instanceof McpBridgeError && error.code === 'UNSAFE_REGISTRY') {
      issues.push({
        code: MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_REGISTRY_UNSAFE,
        severity: 'warning',
        component: 'liveWindow',
        message: 'The MCP window registry has unsafe ownership, permissions, or path components.',
        repairable: false,
        details: { error: error.message, healthChecks },
      });
      return {
        state: 'error',
        healthy: false,
        healthChecks,
        healthyCandidates,
      };
    }
    if (error instanceof McpBridgeError && error.code === 'AMBIGUOUS_WINDOW') {
      issues.push({
        code: MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_AMBIGUOUS,
        severity: 'warning',
        component: 'liveWindow',
        message: 'More than one healthy VS Code window exposes this workspace.',
        repairable: false,
        details: { error: error.message, healthyCandidates },
      });
      return {
        state: 'ambiguous',
        healthy: false,
        healthChecks,
        healthyCandidates,
      };
    }
    if (error instanceof McpBridgeError
      && (error.code === 'NO_LIVE_WINDOW' || error.code === 'WINDOW_NOT_FOUND')) {
      const unhealthy = healthChecks > 0 && healthyCandidates === 0;
      issues.push({
        code: unhealthy
          ? MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_UNHEALTHY
          : MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_NOT_FOUND,
        severity: 'warning',
        component: 'liveWindow',
        message: unhealthy
          ? 'A live-window manifest was found, but its authenticated health check failed.'
          : 'No live VS Code window endpoint was found for this workspace.',
        repairable: false,
        details: { error: error.message, healthChecks },
      });
      return {
        state: unhealthy ? 'unhealthy' : 'missing',
        healthy: false,
        healthChecks,
        healthyCandidates,
      };
    }
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_DISCOVERY_FAILED,
      severity: 'warning',
      component: 'liveWindow',
      message: 'The live VS Code MCP endpoint could not be diagnosed.',
      repairable: false,
      details: { error: errorMessage(error), healthChecks },
    });
    return {
      state: 'error',
      healthy: false,
      healthChecks,
      healthyCandidates,
    };
  }
}

function compareRuntime(source: SafeFileRead, copy: SafeFileRead): McpRuntimeCopyDiagnostic {
  const comparable = source.data !== undefined
    && copy.data !== undefined
    && source.diagnostic.state === 'regular'
    && copy.diagnostic.state === 'regular';
  const byteEqual = comparable ? source.data!.equals(copy.data!) : null;
  const current = comparable
    ? byteEqual === true
      && source.diagnostic.size === copy.diagnostic.size
      && source.diagnostic.sha256 === copy.diagnostic.sha256
    : null;
  return {
    source: source.diagnostic,
    copy: copy.diagnostic,
    current,
    byteEqual,
  };
}

function hasWorkspaceRepairIssue(issue: McpDiagnosticIssue): boolean {
  return issue.component === 'claudeConfig'
    || issue.component === 'codexConfig'
    || issue.component === 'launcher'
    || issue.component === 'runtimeBridge'
    || issue.component === 'runtimeRegistry';
}

/**
 * Read-only verification of the project-local MCP setup and its live window.
 * The returned manifest is deliberately stripped of its bearer token.
 */
export async function diagnoseMcpWorkspace(
  options: McpWorkspaceDiagnosticsOptions,
): Promise<McpWorkspaceDiagnostics> {
  if (!options || typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim() === '') {
    throw new TypeError('workspaceRoot must be a non-empty path');
  }
  if (typeof options.bridgeModulePath !== 'string' || options.bridgeModulePath.trim() === '') {
    throw new TypeError('bridgeModulePath must be a non-empty path');
  }
  if (options.nodeCommand !== undefined
    && (typeof options.nodeCommand !== 'string' || options.nodeCommand.trim() === '')) {
    throw new TypeError('nodeCommand must be non-empty when provided');
  }

  const issues: McpDiagnosticIssue[] = [];
  const workspace = await canonicalWorkspaceRoot(options.workspaceRoot);
  if (workspace.issue) {
    issues.push(workspace.issue);
  }
  const workspaceRoot = workspace.root;
  const extensionBridgeSource = path.resolve(options.bridgeModulePath);
  const extensionRegistrySource = path.join(
    path.dirname(extensionBridgeSource),
    RUNTIME_REGISTRY_NAME,
  );
  const paths: McpWorkspaceDiagnosticPaths = {
    workspaceRoot,
    claudeConfig: resolveWorkspacePath(workspaceRoot, options.claudeConfigPath ?? '.mcp.json'),
    codexConfig: resolveWorkspacePath(
      workspaceRoot,
      options.codexConfigPath ?? path.join('.codex', 'config.toml'),
    ),
    launcher: resolveWorkspacePath(
      workspaceRoot,
      options.launcherPath ?? DEFAULT_MCP_LAUNCHER_PATH,
    ),
    runtimeBridge: resolveWorkspacePath(
      workspaceRoot,
      path.join(DEFAULT_MCP_RUNTIME_PATH, RUNTIME_BRIDGE_NAME),
    ),
    runtimeRegistry: resolveWorkspacePath(
      workspaceRoot,
      path.join(DEFAULT_MCP_RUNTIME_PATH, RUNTIME_REGISTRY_NAME),
    ),
    extensionBridgeSource,
    extensionRegistrySource,
  };

  if (workspace.issue) {
    const skippedBridge = skippedFile(paths.runtimeBridge);
    const skippedRegistry = skippedFile(paths.runtimeRegistry);
    const result: McpWorkspaceDiagnostics = {
      ok: false,
      installed: false,
      verified: false,
      repairNeeded: false,
      paths,
      configs: {
        claude: skippedConfig(paths.claudeConfig),
        codex: skippedConfig(paths.codexConfig),
      },
      launcher: skippedFile(paths.launcher),
      runtime: {
        bridge: {
          source: skippedFile(paths.extensionBridgeSource),
          copy: skippedBridge,
          current: null,
          byteEqual: null,
        },
        registry: {
          source: skippedFile(paths.extensionRegistrySource),
          copy: skippedRegistry,
          current: null,
          byteEqual: null,
        },
        current: false,
      },
      liveWindow: {
        state: 'skipped',
        healthy: false,
        healthChecks: 0,
        healthyCandidates: 0,
      },
      issues,
    };
    return result;
  }

  const entryOptions: StdioEntryOptions = {
    launcherArgument: path.relative(workspaceRoot, paths.launcher).split(path.sep).join('/'),
    nodeCommand: options.nodeCommand ?? 'node',
  };
  const [
    claudeFile,
    codexFile,
    launcherFile,
    runtimeBridgeFile,
    runtimeRegistryFile,
    extensionBridgeFile,
    extensionRegistryFile,
  ] = await Promise.all([
    inspectWorkspaceRegularFile(workspaceRoot, paths.claudeConfig, MAX_CONFIG_BYTES),
    inspectWorkspaceRegularFile(workspaceRoot, paths.codexConfig, MAX_CONFIG_BYTES),
    inspectWorkspaceRegularFile(workspaceRoot, paths.launcher, MAX_RUNTIME_BYTES),
    inspectWorkspaceRegularFile(workspaceRoot, paths.runtimeBridge, MAX_RUNTIME_BYTES),
    inspectWorkspaceRegularFile(workspaceRoot, paths.runtimeRegistry, MAX_RUNTIME_BYTES),
    inspectRegularFile(paths.extensionBridgeSource, MAX_RUNTIME_BYTES),
    inspectRegularFile(paths.extensionRegistrySource, MAX_RUNTIME_BYTES),
  ]);

  const claude = diagnoseClaudeConfig(claudeFile, entryOptions, issues);
  const codex = diagnoseCodexConfig(codexFile, entryOptions, issues);
  addFileIssue(issues, 'launcher', 'MCP launcher', launcherFile.diagnostic, {
    missing: MCP_DIAGNOSTIC_CODES.LAUNCHER_MISSING,
    symlink: MCP_DIAGNOSTIC_CODES.LAUNCHER_SYMLINK,
    notFile: MCP_DIAGNOSTIC_CODES.LAUNCHER_NOT_FILE,
    tooLarge: MCP_DIAGNOSTIC_CODES.LAUNCHER_TOO_LARGE,
    unreadable: MCP_DIAGNOSTIC_CODES.LAUNCHER_UNREADABLE,
  }, true);
  const expectedLauncher = Buffer.from(
    mcpLauncherSource(paths.launcher, workspaceRoot, paths.runtimeBridge),
    'utf8',
  );
  const launcherCurrent = launcherFile.data !== undefined
    ? launcherFile.data.equals(expectedLauncher)
      && launcherFile.diagnostic.sha256 === sha256(expectedLauncher)
    : null;
  if (launcherCurrent === false) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.LAUNCHER_STALE,
      severity: 'error',
      component: 'launcher',
      message: 'Project MCP launcher differs from the extension-generated launcher.',
      repairable: true,
      details: {
        expectedSha256: sha256(expectedLauncher),
        actualSha256: launcherFile.diagnostic.sha256 ?? '',
      },
    });
  }
  addFileIssue(issues, 'runtimeBridge', 'Copied MCP bridge runtime', runtimeBridgeFile.diagnostic, {
    missing: MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_MISSING,
    symlink: MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_SYMLINK,
    notFile: MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_NOT_FILE,
    tooLarge: MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_TOO_LARGE,
    unreadable: MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_UNREADABLE,
  }, true);
  addFileIssue(issues, 'runtimeRegistry', 'Copied MCP registry runtime', runtimeRegistryFile.diagnostic, {
    missing: MCP_DIAGNOSTIC_CODES.RUNTIME_REGISTRY_MISSING,
    symlink: MCP_DIAGNOSTIC_CODES.RUNTIME_REGISTRY_SYMLINK,
    notFile: MCP_DIAGNOSTIC_CODES.RUNTIME_REGISTRY_NOT_FILE,
    tooLarge: MCP_DIAGNOSTIC_CODES.RUNTIME_REGISTRY_TOO_LARGE,
    unreadable: MCP_DIAGNOSTIC_CODES.RUNTIME_REGISTRY_UNREADABLE,
  }, true);
  addFileIssue(
    issues,
    'extensionBridgeSource',
    'Extension MCP bridge source',
    extensionBridgeFile.diagnostic,
    {
      missing: MCP_DIAGNOSTIC_CODES.SOURCE_BRIDGE_MISSING,
      symlink: MCP_DIAGNOSTIC_CODES.SOURCE_BRIDGE_SYMLINK,
      notFile: MCP_DIAGNOSTIC_CODES.SOURCE_BRIDGE_NOT_FILE,
      tooLarge: MCP_DIAGNOSTIC_CODES.SOURCE_BRIDGE_TOO_LARGE,
      unreadable: MCP_DIAGNOSTIC_CODES.SOURCE_BRIDGE_UNREADABLE,
    },
    false,
  );
  addFileIssue(
    issues,
    'extensionRegistrySource',
    'Extension MCP registry source',
    extensionRegistryFile.diagnostic,
    {
      missing: MCP_DIAGNOSTIC_CODES.SOURCE_REGISTRY_MISSING,
      symlink: MCP_DIAGNOSTIC_CODES.SOURCE_REGISTRY_SYMLINK,
      notFile: MCP_DIAGNOSTIC_CODES.SOURCE_REGISTRY_NOT_FILE,
      tooLarge: MCP_DIAGNOSTIC_CODES.SOURCE_REGISTRY_TOO_LARGE,
      unreadable: MCP_DIAGNOSTIC_CODES.SOURCE_REGISTRY_UNREADABLE,
    },
    false,
  );

  const runtimeBridge = compareRuntime(extensionBridgeFile, runtimeBridgeFile);
  const runtimeRegistry = compareRuntime(extensionRegistryFile, runtimeRegistryFile);
  if (runtimeBridge.current === false) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_STALE,
      severity: 'error',
      component: 'runtimeBridge',
      message: 'Copied MCP bridge runtime differs from the installed extension source.',
      repairable: true,
      details: {
        sourceSha256: runtimeBridge.source.sha256 ?? '',
        copiedSha256: runtimeBridge.copy.sha256 ?? '',
      },
    });
  }
  if (runtimeRegistry.current === false) {
    issues.push({
      code: MCP_DIAGNOSTIC_CODES.RUNTIME_REGISTRY_STALE,
      severity: 'error',
      component: 'runtimeRegistry',
      message: 'Copied MCP registry runtime differs from the installed extension source.',
      repairable: true,
      details: {
        sourceSha256: runtimeRegistry.source.sha256 ?? '',
        copiedSha256: runtimeRegistry.copy.sha256 ?? '',
      },
    });
  }

  const liveWindow = await diagnoseLiveWindow(options, workspaceRoot, issues);
  const installed = claude.entryPresent
    && codex.entryPresent
    && launcherFile.diagnostic.state === 'regular'
    && runtimeBridgeFile.diagnostic.state === 'regular'
    && runtimeRegistryFile.diagnostic.state === 'regular';
  const runtimeCurrent = runtimeBridge.current === true && runtimeRegistry.current === true;
  const verified = installed
    && claude.current
    && codex.current
    && launcherCurrent === true
    && runtimeCurrent
    && liveWindow.healthy
    && !issues.some((issue) => issue.component === 'workspace'
      || issue.component === 'extensionBridgeSource'
      || issue.component === 'extensionRegistrySource');
  const repairNeeded = issues.some(hasWorkspaceRepairIssue);

  return {
    ok: verified,
    installed,
    verified,
    repairNeeded,
    paths,
    configs: { claude, codex },
    launcher: launcherFile.diagnostic,
    runtime: {
      bridge: runtimeBridge,
      registry: runtimeRegistry,
      current: runtimeCurrent,
    },
    liveWindow,
    issues,
  };
}

/** Environment keys a diagnostics UI may display without exposing their values. */
export const MCP_DIAGNOSTIC_ENVIRONMENT_KEYS = Object.freeze([
  MCP_WINDOW_ID_ENV,
  MCP_REGISTRY_DIR_ENV,
]);
