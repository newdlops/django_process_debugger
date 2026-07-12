import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import {
  defaultMcpRegistryDir,
  McpWindowManifest,
} from '../../mcp/windowRegistry';
import { projectRoot, sleep } from './testHelpers';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value)
    && value.jsonrpc === '2.0'
    && (typeof value.id === 'string' || typeof value.id === 'number');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A deliberately small JSON-RPC client that talks to the same stdio bridge
 * process Claude and Codex launch. It keeps the E2E independent from either
 * model while exercising their actual MCP transport boundary.
 */
export class McpStdioTestClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private stderr = '';
  private closing = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
      terminal: false,
    });
    lines.on('line', (line) => this.receive(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-32 * 1024);
    });
    child.once('error', (error) => this.rejectAll(error));
    child.once('exit', (code, signal) => {
      if (!this.closing || this.pending.size > 0) {
        this.rejectAll(new Error(
          `MCP stdio bridge exited (code=${code} signal=${signal}). stderr=${this.stderrText()}`,
        ));
      }
    });
  }

  static start(options: {
    workspacePath: string;
    windowId: string;
    registryDir?: string;
  }): McpStdioTestClient {
    const bridgeModule = path.join(projectRoot(), 'out', 'mcp', 'stdioBridge.js');
    const args = [
      bridgeModule,
      'stdio',
      '--workspace', options.workspacePath,
      '--window-id', options.windowId,
      '--registry-dir', options.registryDir ?? defaultMcpRegistryDir(),
      '--connect-timeout-ms', '10000',
    ];
    const child = spawn(process.execPath, args, {
      cwd: options.workspacePath,
      env: {
        ...process.env,
        // process.execPath is Electron inside an extension host on some VS Code builds.
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new McpStdioTestClient(child);
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: {
        name: 'django-process-debugger-live-e2e',
        version: '1.0.0',
      },
    });
    this.notify('notifications/initialized');
    if (!isRecord(result)) {
      throw new Error('MCP initialize returned a non-object result');
    }
    return result;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 40_000,
  ): Promise<Record<string, unknown>> {
    const result = await this.request('tools/call', {
      name,
      arguments: args,
    }, timeoutMs);
    if (!isRecord(result)) {
      throw new Error(`${name} returned a non-object MCP result`);
    }
    const structured = result.structuredContent;
    if (!isRecord(structured)) {
      throw new Error(`${name} omitted structuredContent: ${JSON.stringify(result)}`);
    }
    if (result.isError === true || structured.ok === false) {
      throw new Error(`${name} failed: ${JSON.stringify(structured)}`);
    }
    return structured;
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `Timed out waiting for MCP ${method} response after ${timeoutMs}ms. stderr=${this.stderrText()}`,
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${message}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })}\n`);
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.rejectAll(new Error('MCP stdio test client is closing'));
    this.child.stdin.end();
    if (await this.waitForExit(2_000)) {
      return;
    }
    this.child.kill('SIGTERM');
    if (await this.waitForExit(1_000)) {
      return;
    }
    this.child.kill('SIGKILL');
    if (!await this.waitForExit(1_000)) {
      throw new Error(`MCP stdio bridge did not exit after SIGKILL. stderr=${this.stderrText()}`);
    }
  }

  private receive(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.rejectAll(new Error(`Invalid JSON from MCP stdio bridge: ${line}: ${errorText(error)}`));
      return;
    }
    if (!isJsonRpcResponse(parsed)) {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.error) {
      pending.reject(new Error(
        `MCP JSON-RPC ${parsed.error.code}: ${parsed.error.message}`
          + (parsed.error.data === undefined ? '' : ` ${JSON.stringify(parsed.error.data)}`),
      ));
    } else {
      pending.resolve(parsed.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stderrText(): string {
    const text = this.stderr.trim();
    return text.length > 0 ? text : '(empty)';
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.child.removeListener('exit', onExit);
        resolve(exited);
      };
      const onExit = (): void => finish(true);
      const timer = setTimeout(() => finish(
        this.child.exitCode !== null || this.child.signalCode !== null,
      ), timeoutMs);
      this.child.once('exit', onExit);
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        finish(true);
      }
    });
  }
}

export async function waitForWindowManifest(options: {
  workspacePath: string;
  extensionPid: number;
  timeoutMs?: number;
  registryDir?: string;
}): Promise<McpWindowManifest> {
  const registryDir = options.registryDir ?? defaultMcpRegistryDir();
  const workspace = path.resolve(await fs.realpath(options.workspacePath));
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const names = await fs.readdir(registryDir);
      const candidates = await Promise.all(names
        .filter((name) => name.endsWith('.json'))
        .map(async (name): Promise<McpWindowManifest | undefined> => {
          try {
            const parsed = JSON.parse(
              await fs.readFile(path.join(registryDir, name), 'utf8'),
            ) as McpWindowManifest;
            const ownsWorkspace = parsed.workspaceFolders.some((folder) =>
              path.resolve(folder.canonicalPath) === workspace);
            return parsed.extensionPid === options.extensionPid
              && Date.parse(parsed.leaseExpiresAt) > Date.now()
              && ownsWorkspace
              ? parsed
              : undefined;
          } catch {
            return undefined;
          }
        }));
      const manifest = candidates
        .filter((candidate): candidate is McpWindowManifest => candidate !== undefined)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      if (manifest) {
        return manifest;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }

  throw new Error(
    `Timed out waiting for the extension-host MCP manifest in ${registryDir}`
      + (lastError === undefined ? '' : `: ${errorText(lastError)}`),
  );
}
