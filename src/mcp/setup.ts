import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export const MCP_SERVER_NAME = 'djangoDebugger';
export const DEFAULT_MCP_LAUNCHER_PATH = '.django-process-debugger/mcp-stdio.js';
export const DEFAULT_MCP_RUNTIME_PATH = '.django-process-debugger/runtime';
const RUNTIME_BRIDGE_NAME = 'stdioBridge.js';
const RUNTIME_REGISTRY_NAME = 'windowRegistry.js';

export interface McpWorkspaceSetupOptions {
  workspaceRoot: string;
  /** Absolute path to the compiled stdioBridge.js shipped by the extension. */
  bridgeModulePath: string;
  /** Workspace-relative launcher location. */
  launcherPath?: string;
  claudeConfigPath?: string;
  codexConfigPath?: string;
  nodeCommand?: string;
}

export interface McpWorkspaceSetupResult {
  launcherPath: string;
  runtimeBridgePath: string;
  runtimeRegistryPath: string;
  claudeConfigPath: string;
  codexConfigPath: string;
}

export interface StdioEntryOptions {
  launcherArgument: string;
  nodeCommand: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRelativeLauncher(value: string): string {
  return value.split(path.sep).join('/');
}

function resolveWorkspaceLocalPath(
  workspaceRoot: string,
  candidate: string,
  label = 'MCP setup target',
): string {
  const resolved = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a file inside the workspace: ${candidate}`);
  }
  return resolved;
}

export function mcpLauncherSource(
  launcherPath: string,
  workspaceRoot: string,
  runtimeBridgePath: string,
): string {
  const launcherDirectory = path.dirname(launcherPath);
  const workspaceFromLauncher = normalizeRelativeLauncher(
    path.relative(launcherDirectory, workspaceRoot) || '.',
  );
  const runtimeFromLauncher = normalizeRelativeLauncher(
    path.relative(launcherDirectory, runtimeBridgePath),
  );
  return `#!/usr/bin/env node
'use strict';

const path = require('path');
const bridge = require(path.resolve(__dirname, ${JSON.stringify(runtimeFromLauncher)}));
const workspaceRoot = path.resolve(__dirname, ${JSON.stringify(workspaceFromLauncher)});

function normalizeWorkspace(args) {
  const result = args.slice();
  let found = false;
  for (let index = 0; index < result.length; index += 1) {
    const argument = result[index];
    if (argument === '--workspace') {
      found = true;
      if (result[index + 1] === '.') result[index + 1] = workspaceRoot;
      index += 1;
    } else if (argument.startsWith('--workspace=')) {
      found = true;
      if (argument.slice('--workspace='.length) === '.') {
        result[index] = '--workspace=' + workspaceRoot;
      }
    }
  }
  if (!found) result.push('--workspace', workspaceRoot);
  return result;
}

const cliArgs = process.argv.slice(require.main === module ? 2 : 1);
Promise.resolve(bridge.main(normalizeWorkspace(cliArgs))).catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  process.stderr.write('[django-debugger-mcp] ' + message + '\\n');
  process.exitCode = 1;
});
`;
}

/** Portable node -e bootstrap shared by Claude and Codex project config. */
export function launcherBootstrap(launcherArgument: string): string {
  const normalized = normalizeRelativeLauncher(launcherArgument);
  return [
    "const fs=require('fs'),path=require('path')",
    `const rel=${JSON.stringify(normalized)}`,
    'let found',
    "const project=process.env.CLAUDE_PROJECT_DIR",
    "if(project){const file=path.join(path.resolve(project),rel);try{if(fs.statSync(file).isFile())found=file}catch{}}else{let dir=path.resolve(process.cwd());for(;;){const file=path.join(dir,rel);try{if(fs.statSync(file).isFile()){found=file;break}}catch{}const boundary=fs.existsSync(path.join(dir,'.codex','config.toml'))||fs.existsSync(path.join(dir,'.mcp.json'))||fs.existsSync(path.join(dir,'.git'));if(boundary)break;const parent=path.dirname(dir);if(parent===dir)break;dir=parent}}",
    "if(!found)throw new Error('Cannot find project Django debugger MCP launcher')",
    'require(found)',
  ].join(';');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function canonicalWorkspaceRoot(input: string): Promise<string> {
  const resolved = path.resolve(input);
  let info;
  try {
    info = await fs.stat(resolved);
  } catch (error) {
    throw new Error(`Workspace root does not exist: ${resolved} (${errorMessage(error)})`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${resolved}`);
  }
  return fs.realpath(resolved);
}

async function assertSafeWorkspaceTarget(
  workspaceRoot: string,
  filePath: string,
): Promise<void> {
  const relative = path.relative(workspaceRoot, filePath);
  if (relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`MCP setup target escapes the workspace: ${filePath}`);
  }
  const parts = relative.split(path.sep);
  let current = workspaceRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`MCP setup refuses symbolic-link target components: ${current}`);
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`MCP setup target parent is not a directory: ${current}`);
    }
    if (index === parts.length - 1 && !info.isFile()) {
      throw new Error(`MCP setup target is not a regular file: ${current}`);
    }
  }
}

async function ensureSafeParentDirectory(
  workspaceRoot: string,
  filePath: string,
): Promise<void> {
  const parentPath = path.dirname(filePath);
  const relative = path.relative(workspaceRoot, parentPath);
  const parts = relative === '' ? [] : relative.split(path.sep);
  let current = workspaceRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      await fs.mkdir(current, { mode: 0o700 });
      info = await fs.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`MCP setup target parent must be a real directory: ${current}`);
    }
  }
  const realParent = await fs.realpath(parentPath);
  const realRelative = path.relative(workspaceRoot, realParent);
  if (realRelative === '..'
    || realRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(realRelative)) {
    throw new Error(`MCP setup target parent escapes the workspace: ${parentPath}`);
  }
  await assertSafeWorkspaceTarget(workspaceRoot, filePath);
}

async function atomicWrite(
  workspaceRoot: string,
  filePath: string,
  contents: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await ensureSafeParentDirectory(workspaceRoot, filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { mode, flag: 'wx' });
    // Re-check after creating the temporary file to narrow symlink-swap races.
    await ensureSafeParentDirectory(workspaceRoot, filePath);
    await fs.rename(temporary, filePath);
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // Best effort on filesystems without POSIX permission support.
    }
  } finally {
    try {
      await fs.unlink(temporary);
    } catch {
      // Already renamed or creation failed.
    }
  }
}

async function readRegularSource(filePath: string, label: string): Promise<Buffer> {
  let info;
  try {
    info = await fs.lstat(filePath);
  } catch (error) {
    throw new Error(`${label} does not exist: ${filePath} (${errorMessage(error)})`);
  }
  if (!info.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return fs.readFile(filePath);
}

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export function mergeClaudeMcpConfig(
  original: string | undefined,
  options: StdioEntryOptions,
): string {
  let parsed: unknown = {};
  if (original !== undefined && original.trim() !== '') {
    try {
      parsed = JSON.parse(original);
    } catch (error) {
      throw new Error(`Cannot update .mcp.json because it is not valid JSON: ${errorMessage(error)}`);
    }
  }
  if (!isRecord(parsed)) {
    throw new Error('Cannot update .mcp.json because its root value is not an object');
  }
  const existingServers = parsed.mcpServers;
  if (existingServers !== undefined && !isRecord(existingServers)) {
    throw new Error('Cannot update .mcp.json because mcpServers is not an object');
  }
  parsed.mcpServers = {
    ...(existingServers ?? {}),
    [MCP_SERVER_NAME]: {
      type: 'stdio',
      command: options.nodeCommand,
      args: [
        '-e',
        launcherBootstrap(options.launcherArgument),
        'stdio',
        '--workspace',
        '.',
      ],
    },
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexManagedLines(options: StdioEntryOptions): Readonly<Record<string, string>> {
  return {
    command: `command = ${tomlString(options.nodeCommand)}`,
    args: `args = [${[
      '-e',
      launcherBootstrap(options.launcherArgument),
      'stdio',
      '--workspace',
      '.',
    ].map(tomlString).join(', ')}]`,
    cwd: 'cwd = "."',
    env_vars: 'env_vars = ["DJANGO_PROCESS_DEBUGGER_WINDOW_ID", "DJANGO_PROCESS_DEBUGGER_MCP_REGISTRY_DIR"]',
    default_tools_approval_mode: 'default_tools_approval_mode = "writes"',
    startup_timeout_sec: 'startup_timeout_sec = 15',
    tool_timeout_sec: 'tool_timeout_sec = 60',
    enabled: 'enabled = true',
    required: 'required = false',
  };
}

const MCP_SERVERS_SEGMENT = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
const DJANGO_DEBUGGER_SEGMENT = String.raw`(?:djangoDebugger|"djangoDebugger"|'djangoDebugger')`;
const TARGET_TABLE = new RegExp(
  String.raw`^\s*\[\s*${MCP_SERVERS_SEGMENT}\s*\.\s*${DJANGO_DEBUGGER_SEGMENT}\s*\]\s*(?:#.*)?$`,
);
const TARGET_ARRAY_TABLE = new RegExp(
  String.raw`^\s*\[\[\s*${MCP_SERVERS_SEGMENT}\s*\.\s*${DJANGO_DEBUGGER_SEGMENT}\s*\]\]`,
);
const MCP_SERVERS_TABLE = new RegExp(
  String.raw`^\s*\[\s*${MCP_SERVERS_SEGMENT}\s*\]\s*(?:#.*)?$`,
);
const MCP_SERVERS_ASSIGNMENT = new RegExp(
  String.raw`^\s*${MCP_SERVERS_SEGMENT}\s*=`,
);
const DOTTED_TARGET_ASSIGNMENT = new RegExp(
  String.raw`^\s*${MCP_SERVERS_SEGMENT}\s*\.\s*${DJANGO_DEBUGGER_SEGMENT}\s*(?:=|\.)`,
);
const DJANGO_DEBUGGER_ASSIGNMENT = new RegExp(
  String.raw`^\s*${DJANGO_DEBUGGER_SEGMENT}\s*(?:=|\.)`,
);
const ANY_TABLE = /^\s*\[/;

function arrayBracketDelta(value: string): number {
  let delta = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (quote === '"' && character === '\\') {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      break;
    } else if (character === '[') {
      delta += 1;
    } else if (character === ']') {
      delta -= 1;
    }
  }
  return delta;
}

/** Update only managed keys in the djangoDebugger table and retain all others. */
export function mergeCodexMcpConfig(
  original: string | undefined,
  options: StdioEntryOptions,
): string {
  const managed = codexManagedLines(options);
  const newline = original?.includes('\r\n') ? '\r\n' : '\n';
  const source = (original ?? '').replace(/\r\n/g, '\n');
  const hadFinalNewline = source.endsWith('\n');
  const lines = source.split('\n');
  if (hadFinalNewline) {
    lines.pop();
  }

  const starts = lines
    .map((line, index) => TARGET_TABLE.test(line) ? index : -1)
    .filter((index) => index >= 0);
  let insideMcpServersTable = false;
  let atTopLevel = true;
  for (const line of lines) {
    if (TARGET_ARRAY_TABLE.test(line)) {
      throw new Error(
        'Cannot update .codex/config.toml because djangoDebugger is defined as an array table',
      );
    }
    if (ANY_TABLE.test(line)) {
      atTopLevel = false;
      insideMcpServersTable = MCP_SERVERS_TABLE.test(line);
      continue;
    }
    if ((atTopLevel && MCP_SERVERS_ASSIGNMENT.test(line))
      || (atTopLevel && DOTTED_TARGET_ASSIGNMENT.test(line))
      || (insideMcpServersTable && DJANGO_DEBUGGER_ASSIGNMENT.test(line))) {
      throw new Error(
        'Cannot update .codex/config.toml because djangoDebugger has a conflicting inline or dotted definition',
      );
    }
  }
  if (starts.length > 1) {
    throw new Error('Cannot update .codex/config.toml because djangoDebugger is declared more than once');
  }

  if (starts.length === 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(`[mcp_servers.${MCP_SERVER_NAME}]`, ...Object.values(managed));
    return `${lines.join(newline)}${newline}`;
  }

  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (ANY_TABLE.test(lines[index])) {
      end = index;
      break;
    }
  }

  const seen = new Set<string>();
  const updatedSection = [lines[start]];
  const originalSection = lines.slice(start + 1, end);
  for (let index = 0; index < originalSection.length; index += 1) {
    const line = originalSection[index];
    const keyMatch = line.match(/^\s*(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')\s*=/);
    const key = keyMatch?.[1] ?? keyMatch?.[2] ?? keyMatch?.[3];
    if (key !== undefined && Object.prototype.hasOwnProperty.call(managed, key)) {
      if (!seen.has(key)) {
        updatedSection.push(managed[key]);
        seen.add(key);
      }
      // Drop complete multiline arrays for all managed array keys.
      let depth = arrayBracketDelta(line.slice(line.indexOf('=') + 1));
      if (depth > 0) {
        while (depth > 0 && index + 1 < originalSection.length) {
          index += 1;
          depth += arrayBracketDelta(originalSection[index]);
        }
        if (depth > 0) {
          throw new Error(
            `Cannot update .codex/config.toml because ${key} has an unterminated array`,
          );
        }
      }
    } else {
      updatedSection.push(line);
    }
  }
  for (const [key, line] of Object.entries(managed)) {
    if (!seen.has(key)) {
      updatedSection.push(line);
    }
  }
  const result = [...lines.slice(0, start), ...updatedSection, ...lines.slice(end)];
  return `${result.join(newline)}${newline}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Install the project-local launcher and merge both supported client configs. */
export async function setupMcpWorkspace(
  options: McpWorkspaceSetupOptions,
): Promise<McpWorkspaceSetupResult> {
  if (typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim() === '') {
    throw new TypeError('workspaceRoot must be a non-empty path');
  }
  if (typeof options.bridgeModulePath !== 'string' || options.bridgeModulePath.trim() === '') {
    throw new TypeError('bridgeModulePath must be a non-empty path');
  }
  if (options.nodeCommand !== undefined
    && (typeof options.nodeCommand !== 'string' || options.nodeCommand.trim() === '')) {
    throw new TypeError('nodeCommand must be non-empty when provided');
  }
  const workspaceRoot = await canonicalWorkspaceRoot(options.workspaceRoot);
  const bridgeModulePath = path.resolve(options.bridgeModulePath);
  const registryModulePath = path.join(path.dirname(bridgeModulePath), RUNTIME_REGISTRY_NAME);
  const launcherRelative = options.launcherPath ?? DEFAULT_MCP_LAUNCHER_PATH;
  const launcherPath = resolveWorkspaceLocalPath(
    workspaceRoot,
    launcherRelative,
    'MCP launcher',
  );
  const runtimeBridgePath = resolveWorkspaceLocalPath(
    workspaceRoot,
    path.join(DEFAULT_MCP_RUNTIME_PATH, RUNTIME_BRIDGE_NAME),
    'MCP runtime bridge',
  );
  const runtimeRegistryPath = resolveWorkspaceLocalPath(
    workspaceRoot,
    path.join(DEFAULT_MCP_RUNTIME_PATH, RUNTIME_REGISTRY_NAME),
    'MCP runtime registry module',
  );
  const launcherArgument = normalizeRelativeLauncher(path.relative(workspaceRoot, launcherPath));
  const claudeConfigPath = resolveWorkspaceLocalPath(
    workspaceRoot,
    options.claudeConfigPath ?? '.mcp.json',
    'Claude MCP config',
  );
  const codexConfigPath = resolveWorkspaceLocalPath(
    workspaceRoot,
    options.codexConfigPath ?? path.join('.codex', 'config.toml'),
    'Codex MCP config',
  );
  const entryOptions = {
    launcherArgument,
    nodeCommand: options.nodeCommand ?? 'node',
  };

  await Promise.all([
    launcherPath,
    runtimeBridgePath,
    runtimeRegistryPath,
    claudeConfigPath,
    codexConfigPath,
  ].map((target) => assertSafeWorkspaceTarget(workspaceRoot, target)));

  const [bridgeSource, registrySource, claudeOriginal, codexOriginal] = await Promise.all([
    readRegularSource(bridgeModulePath, 'MCP stdio bridge module'),
    readRegularSource(registryModulePath, 'MCP window registry module'),
    readTextIfPresent(claudeConfigPath),
    readTextIfPresent(codexConfigPath),
  ]);
  // Parse/merge everything before the first write so malformed user config
  // cannot leave a half-installed setup.
  const claudeUpdated = mergeClaudeMcpConfig(claudeOriginal, entryOptions);
  const codexUpdated = mergeCodexMcpConfig(codexOriginal, entryOptions);

  await atomicWrite(workspaceRoot, runtimeBridgePath, bridgeSource);
  await atomicWrite(workspaceRoot, runtimeRegistryPath, registrySource);
  await atomicWrite(
    workspaceRoot,
    launcherPath,
    mcpLauncherSource(launcherPath, workspaceRoot, runtimeBridgePath),
    0o755,
  );
  await atomicWrite(workspaceRoot, claudeConfigPath, claudeUpdated);
  await atomicWrite(workspaceRoot, codexConfigPath, codexUpdated);
  return {
    launcherPath,
    runtimeBridgePath,
    runtimeRegistryPath,
    claudeConfigPath,
    codexConfigPath,
  };
}
