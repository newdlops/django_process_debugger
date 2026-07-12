import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DEFAULT_MCP_LAUNCHER_PATH,
  DEFAULT_MCP_RUNTIME_PATH,
  mcpLauncherSource,
} from './setup';
import {
  MCP_REGISTRY_DIR_ENV,
  MCP_WINDOW_ID_ENV,
} from './stdioBridge';
import { MCP_PROTOCOL_VERSION } from './transport';

const DEFAULT_VERIFY_TIMEOUT_MS = 12_000;
const MAX_CAPTURE_BYTES = 256 * 1024;

export type McpVerificationErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNSAFE_LAUNCHER'
  | 'UNSAFE_RUNTIME'
  | 'LAUNCH_FAILED'
  | 'VERIFY_TIMEOUT'
  | 'BRIDGE_FAILED'
  | 'INVALID_PROTOCOL'
  | 'STATUS_TOOL_MISSING'
  | 'STATUS_TOOL_FAILED';

export class McpVerificationError extends Error {
  constructor(
    readonly code: McpVerificationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpVerificationError';
  }
}

export interface VerifyMcpWorkspaceOptions {
  workspaceRoot: string;
  launcherPath?: string;
  nodeCommand?: string;
  windowId?: string;
  registryDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface McpWorkspaceVerification {
  ok: true;
  elapsedMs: number;
  protocolVersion: string;
  serverInfo: Record<string, unknown>;
  toolNames: string[];
  status: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

async function verifiedLauncherPath(
  workspaceRoot: string,
  launcher: string,
): Promise<{ workspaceRoot: string; launcherPath: string; launcherSource: string }> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(path.resolve(workspaceRoot));
  } catch {
    throw new McpVerificationError(
      'INVALID_ARGUMENT',
      `Workspace root does not exist: ${workspaceRoot}`,
    );
  }
  const resolvedLauncher = path.resolve(canonicalRoot, launcher);
  let info;
  let canonicalLauncher: string;
  try {
    info = await fs.lstat(resolvedLauncher);
    canonicalLauncher = await fs.realpath(resolvedLauncher);
  } catch {
    throw new McpVerificationError(
      'UNSAFE_LAUNCHER',
      `MCP launcher does not exist: ${resolvedLauncher}`,
    );
  }
  if (info.isSymbolicLink() || !info.isFile() || !isInside(canonicalRoot, canonicalLauncher)) {
    throw new McpVerificationError(
      'UNSAFE_LAUNCHER',
      'MCP launcher must be a regular file inside the workspace.',
      { launcherPath: resolvedLauncher },
    );
  }
  const installedLauncherSource = mcpLauncherSource(
    canonicalLauncher,
    canonicalRoot,
    path.join(canonicalRoot, DEFAULT_MCP_RUNTIME_PATH, 'stdioBridge.js'),
  );
  let installedSource: string;
  try {
    installedSource = await fs.readFile(canonicalLauncher, 'utf8');
  } catch {
    throw new McpVerificationError(
      'UNSAFE_LAUNCHER',
      'MCP launcher could not be read safely.',
      { launcherPath: canonicalLauncher },
    );
  }
  if (installedSource !== installedLauncherSource) {
    throw new McpVerificationError(
      'UNSAFE_LAUNCHER',
      'MCP launcher content does not match the extension-generated launcher.',
      { launcherPath: canonicalLauncher },
    );
  }
  const trustedBridge = path.resolve(__dirname, 'stdioBridge.js');
  const trustedRegistry = path.resolve(__dirname, 'windowRegistry.js');
  const copiedBridge = path.join(canonicalRoot, DEFAULT_MCP_RUNTIME_PATH, 'stdioBridge.js');
  const copiedRegistry = path.join(canonicalRoot, DEFAULT_MCP_RUNTIME_PATH, 'windowRegistry.js');
  for (const [label, copy, trusted] of [
    ['bridge', copiedBridge, trustedBridge],
    ['registry', copiedRegistry, trustedRegistry],
  ] as const) {
    try {
      const [copyInfo, trustedInfo, copyBytes, trustedBytes] = await Promise.all([
        fs.lstat(copy),
        fs.lstat(trusted),
        fs.readFile(copy),
        fs.readFile(trusted),
      ]);
      if (copyInfo.isSymbolicLink()
        || trustedInfo.isSymbolicLink()
        || !copyInfo.isFile()
        || !trustedInfo.isFile()
        || !copyBytes.equals(trustedBytes)) {
        throw new Error('runtime mismatch');
      }
    } catch {
      throw new McpVerificationError(
        'UNSAFE_RUNTIME',
        `Copied MCP ${label} runtime does not match the installed extension.`,
        { runtimePath: copy },
      );
    }
  }
  // Verification executes trusted extension runtime bytes, after proving the
  // project copies match, so a workspace swap cannot turn Verify into code execution.
  const launcherSource = mcpLauncherSource(
    canonicalLauncher,
    canonicalRoot,
    trustedBridge,
  );
  return {
    workspaceRoot: canonicalRoot,
    launcherPath: canonicalLauncher,
    launcherSource,
  };
}

function parseResponses(stdout: string): Map<string | number, Record<string, unknown>> {
  const responses = new Map<string | number, Record<string, unknown>>();
  for (const line of stdout.split(/\r?\n/).filter((entry) => entry.trim().length > 0)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new McpVerificationError(
        'INVALID_PROTOCOL',
        'MCP bridge wrote non-JSON data to stdout.',
      );
    }
    if (!isRecord(parsed)
      || parsed.jsonrpc !== '2.0'
      || (typeof parsed.id !== 'string' && typeof parsed.id !== 'number')) {
      throw new McpVerificationError(
        'INVALID_PROTOCOL',
        'MCP bridge returned an invalid JSON-RPC response.',
      );
    }
    responses.set(parsed.id, parsed);
  }
  return responses;
}

function successfulResult(
  responses: Map<string | number, Record<string, unknown>>,
  id: string,
): Record<string, unknown> {
  const response = responses.get(id);
  if (!response || !isRecord(response.result) || isRecord(response.error)) {
    throw new McpVerificationError(
      'INVALID_PROTOCOL',
      `MCP verification request ${id} did not return a successful result.`,
      { response: response ?? null },
    );
  }
  return response.result;
}

/**
 * Execute the installed project launcher and verify the full stdio -> window
 * transport -> debugger status path without mutating debugger state.
 */
export async function verifyMcpWorkspace(
  options: VerifyMcpWorkspaceOptions,
): Promise<McpWorkspaceVerification> {
  if (!options || typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim() === '') {
    throw new McpVerificationError('INVALID_ARGUMENT', 'workspaceRoot must be a non-empty path.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new McpVerificationError(
      'INVALID_ARGUMENT',
      'timeoutMs must be an integer between 1 and 60000.',
    );
  }
  const paths = await verifiedLauncherPath(
    options.workspaceRoot,
    options.launcherPath ?? DEFAULT_MCP_LAUNCHER_PATH,
  );
  const startedAt = Date.now();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (options.windowId?.trim()) {
    environment[MCP_WINDOW_ID_ENV] = options.windowId.trim();
  }
  if (options.registryDir?.trim()) {
    environment[MCP_REGISTRY_DIR_ENV] = path.resolve(options.registryDir);
  }

  const payload = [
    {
      jsonrpc: '2.0',
      id: 'verify-initialize',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'django-process-debugger-verifier', version: '1' },
      },
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    },
    {
      jsonrpc: '2.0',
      id: 'verify-tools',
      method: 'tools/list',
      params: {},
    },
    {
      jsonrpc: '2.0',
      id: 'verify-status',
      method: 'tools/call',
      params: { name: 'django_debugger_status', arguments: {} },
    },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';

  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    // Execute the already-verified bytes through a Module carrying the real
    // launcher filename. This preserves __dirname behavior without reopening
    // a workspace file that could be swapped between verification and spawn.
    const encodedLauncher = Buffer.from(paths.launcherSource, 'utf8').toString('base64');
    const moduleRunner = [
      "const Module=require('module'),path=require('path')",
      `const file=${JSON.stringify(paths.launcherPath)}`,
      `const source=Buffer.from(${JSON.stringify(encodedLauncher)},'base64').toString('utf8')`,
      'const loaded=new Module(file)',
      'loaded.filename=file',
      'loaded.paths=Module._nodeModulePaths(path.dirname(file))',
      'loaded._compile(source,file)',
    ].join(';');
    const child = spawn(options.nodeCommand ?? 'node', [
      '-e',
      moduleRunner,
      'stdio',
      '--workspace',
      paths.workspaceRoot,
      ...(options.windowId?.trim() ? ['--window-id', options.windowId.trim()] : []),
      ...(options.registryDir?.trim() ? ['--registry-dir', path.resolve(options.registryDir)] : []),
      '--connect-timeout-ms',
      String(Math.min(timeoutMs, 10_000)),
    ], {
      cwd: paths.workspaceRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (
      error: McpVerificationError | undefined,
      value?: { stdout: string; stderr: string },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(value!);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new McpVerificationError(
        'VERIFY_TIMEOUT',
        `MCP verification timed out after ${timeoutMs}ms.`,
      ));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => finish(new McpVerificationError(
      'LAUNCH_FAILED',
      `Could not start the MCP launcher: ${error.message}`,
    )));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES) {
        child.kill();
        finish(new McpVerificationError('INVALID_PROTOCOL', 'MCP stdout exceeded the verification limit.'));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_CAPTURE_BYTES) {
        child.kill();
        finish(new McpVerificationError('BRIDGE_FAILED', 'MCP stderr exceeded the verification limit.'));
      }
    });
    child.once('close', (code, signal) => {
      if (code !== 0) {
        finish(new McpVerificationError(
          'BRIDGE_FAILED',
          `MCP bridge exited with ${code ?? signal ?? 'unknown status'}.`,
          { stderr: stderr.slice(0, 4_000) },
        ));
        return;
      }
      finish(undefined, { stdout, stderr });
    });
    child.stdin.once('error', (error) => finish(new McpVerificationError(
      'BRIDGE_FAILED',
      `Could not write MCP verification requests: ${error.message}`,
    )));
    child.stdin.end(payload);
  });

  const responses = parseResponses(result.stdout);
  const initialize = successfulResult(responses, 'verify-initialize');
  const toolsResult = successfulResult(responses, 'verify-tools');
  const statusResult = successfulResult(responses, 'verify-status');
  const toolNames = Array.isArray(toolsResult.tools)
    ? toolsResult.tools.flatMap((tool) =>
      isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [])
    : [];
  if (!toolNames.includes('django_debugger_status')) {
    throw new McpVerificationError(
      'STATUS_TOOL_MISSING',
      'The connected MCP server does not expose django_debugger_status.',
    );
  }
  if (statusResult.isError === true || !isRecord(statusResult.structuredContent)) {
    throw new McpVerificationError(
      'STATUS_TOOL_FAILED',
      'django_debugger_status did not return structured content.',
      { result: statusResult },
    );
  }
  if (typeof initialize.protocolVersion !== 'string' || !isRecord(initialize.serverInfo)) {
    throw new McpVerificationError(
      'INVALID_PROTOCOL',
      'MCP initialize response is missing protocolVersion or serverInfo.',
    );
  }
  return {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    protocolVersion: initialize.protocolVersion,
    serverInfo: initialize.serverInfo,
    toolNames,
    status: statusResult.structuredContent,
  };
}
