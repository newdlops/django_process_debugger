import * as fs from 'fs/promises';
import { randomBytes } from 'crypto';
import * as http from 'http';
import { isIP } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { Readable, Writable } from 'stream';
import {
  MCP_MANIFEST_SCHEMA_VERSION,
  McpRegistrySecurityError,
  McpWindowManifest,
  defaultMcpRegistryDir,
  isValidMcpWindowId,
  readSecureMcpRegistryFile,
  validateSecureMcpRegistryDirectory,
} from './windowRegistry';

export const MCP_REGISTRY_DIR_ENV = 'DJANGO_PROCESS_DEBUGGER_MCP_REGISTRY_DIR';
export const MCP_WINDOW_ID_ENV = 'DJANGO_PROCESS_DEBUGGER_WINDOW_ID';
export const MCP_BRIDGE_CLIENT_ID_HEADER = 'x-django-debugger-mcp-client-id';

const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const CONNECT_POLL_INTERVAL_MS = 100;

export type McpBridgeErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NO_LIVE_WINDOW'
  | 'WINDOW_NOT_FOUND'
  | 'AMBIGUOUS_WINDOW'
  | 'UNSAFE_REGISTRY'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE';

export class McpBridgeError extends Error {
  constructor(
    readonly code: McpBridgeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'McpBridgeError';
  }
}

export interface ManifestDiscoveryOptions {
  workspacePath: string;
  windowId?: string;
  registryDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Parent process used only as a safe tie-breaker for duplicate workspace windows. */
  parentPid?: number;
  isProcessAlive?: (pid: number) => boolean;
  healthCheck?: (manifest: McpWindowManifest) => Promise<boolean>;
}

export interface StdioBridgeOptions extends ManifestDiscoveryOptions {
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  connectTimeoutMs?: number;
  /** Test/embedding override. Normal CLI processes receive a fresh random id. */
  clientId?: string;
  discover?: (options: ManifestDiscoveryOptions) => Promise<McpWindowManifest>;
  post?: (
    manifest: McpWindowManifest,
    body: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
    maxResponseBytes: number,
  ) => Promise<HttpResponse>;
}

export interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface ParsedJsonRpcLine {
  raw: string;
  value: unknown;
  id?: unknown;
  method?: string;
}

interface CliOptions {
  workspacePath: string;
  windowId?: string;
  registryDir?: string;
  connectTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isWorkspaceFolder(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.uri)
    && isNonEmptyString(value.fsPath)
    && path.isAbsolute(value.fsPath)
    && isNonEmptyString(value.canonicalPath)
    && path.isAbsolute(value.canonicalPath);
}

/** Parse an untrusted registry record without accepting partial manifests. */
export function parseMcpWindowManifest(value: unknown): McpWindowManifest | null {
  if (!isRecord(value)
    || value.schemaVersion !== MCP_MANIFEST_SCHEMA_VERSION
    || !isNonEmptyString(value.windowId)
    || !isValidMcpWindowId(value.windowId)
    || !Number.isInteger(value.extensionPid)
    || (value.extensionPid as number) <= 0
    || !isNonEmptyString(value.url)
    || !isNonEmptyString(value.token)
    || /\s/.test(value.token)
    || !Array.isArray(value.workspaceFolders)
    || !value.workspaceFolders.every(isWorkspaceFolder)
    || !isNonEmptyString(value.extensionVersion)
    || !isIsoTimestamp(value.startedAt)
    || !isIsoTimestamp(value.updatedAt)
    || !isIsoTimestamp(value.leaseExpiresAt)) {
    return null;
  }
  if (Date.parse(value.startedAt as string) > Date.parse(value.updatedAt as string)
    || Date.parse(value.updatedAt as string) > Date.parse(value.leaseExpiresAt as string)) {
    return null;
  }

  try {
    assertLoopbackHttpUrl(value.url);
  } catch {
    return null;
  }
  return value as unknown as McpWindowManifest;
}

function assertLoopbackHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new McpBridgeError('INVALID_ARGUMENT', `Invalid MCP endpoint URL: ${rawUrl}`, error);
  }
  const hostname = url.hostname.toLowerCase();
  const unwrappedHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const isLoopback = hostname === 'localhost'
    || unwrappedHostname === '::1'
    || (isIP(unwrappedHostname) === 4 && unwrappedHostname.startsWith('127.'));
  if (url.protocol !== 'http:'
    || !isLoopback
    || url.username
    || url.password
    || url.pathname !== '/mcp'
    || url.search
    || url.hash) {
    throw new McpBridgeError(
      'INVALID_ARGUMENT',
      `MCP endpoint must be an unauthenticated loopback HTTP /mcp URL: ${rawUrl}`,
    );
  }
  return url;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  const withoutTrailingSeparator = resolved.length > path.parse(resolved).root.length
    ? resolved.replace(/[\\/]+$/, '')
    : resolved;
  return process.platform === 'win32' ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

/** Resolve symlinks when possible so clients and VS Code can spell a root differently. */
export async function canonicalWorkspacePath(workspacePath: string): Promise<string> {
  const resolved = path.resolve(workspacePath);
  try {
    return normalizedPath(await fs.realpath(resolved));
  } catch {
    return normalizedPath(resolved);
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

export function registryDirectory(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.resolve(explicit ?? env[MCP_REGISTRY_DIR_ENV] ?? defaultMcpRegistryDir());
}

function nonEmptySelection(value: string | undefined): string | undefined {
  const selected = value?.trim();
  return selected || undefined;
}

/**
 * Find the live VS Code window that owns an exact canonical workspace root.
 * Every candidate is authenticated through its health endpoint before it can
 * be selected; registry files are discovery hints, not a trust boundary.
 */
export async function discoverMcpWindow(
  options: ManifestDiscoveryOptions,
): Promise<McpWindowManifest> {
  if (!isNonEmptyString(options.workspacePath)) {
    throw new McpBridgeError('INVALID_ARGUMENT', '--workspace must be a non-empty path');
  }
  const env = options.env ?? process.env;
  const explicitWindowId = nonEmptySelection(options.windowId);
  const environmentWindowId = nonEmptySelection(env[MCP_WINDOW_ID_ENV]);
  const requestedWindowId = explicitWindowId ?? environmentWindowId;
  const workspace = await canonicalWorkspacePath(options.workspacePath);
  const configuredDirectory = registryDirectory(options.registryDir, env);
  const now = (options.now ?? Date.now)();
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const healthCheck = options.healthCheck ?? checkMcpWindowHealth;

  let directory: string;
  let names: string[];
  try {
    directory = await validateSecureMcpRegistryDirectory(configuredDirectory);
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw noWindowError(requestedWindowId, workspace);
    }
    if (error instanceof McpRegistrySecurityError) {
      throw new McpBridgeError(
        'UNSAFE_REGISTRY',
        `UNSAFE_REGISTRY: refusing Django debugger MCP registry ${configuredDirectory}: ${error.reason}`,
        error,
      );
    }
    throw new McpBridgeError(
      'NO_LIVE_WINDOW',
      `Cannot read Django debugger MCP registry ${configuredDirectory}: ${errorMessage(error)}`,
      error,
    );
  }

  const unsafeJsonName = names.find((name) =>
    name.toLowerCase().endsWith('.json')
    && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name));
  if (unsafeJsonName !== undefined) {
    throw new McpBridgeError(
      'UNSAFE_REGISTRY',
      `UNSAFE_REGISTRY: refusing invalid registry entry name ${unsafeJsonName}`,
    );
  }
  const manifests = await Promise.all(names
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name))
    .map(async (name): Promise<McpWindowManifest | null> => {
      try {
        const parsed = parseMcpWindowManifest(JSON.parse(
          await readSecureMcpRegistryFile(directory, name),
        ));
        if (!parsed
          || `${parsed.windowId}.json` !== name
          || Date.parse(parsed.leaseExpiresAt) <= now
          || !isProcessAlive(parsed.extensionPid)
          || !parsed.workspaceFolders.some((folder) =>
            normalizedPath(folder.canonicalPath) === workspace)) {
          return null;
        }
        return parsed;
      } catch (error) {
        if (error instanceof McpRegistrySecurityError) {
          throw new McpBridgeError(
            'UNSAFE_REGISTRY',
            `UNSAFE_REGISTRY: refusing unsafe registry entry ${name}: ${error.reason}`,
            error,
          );
        }
        return null;
      }
    }));

  const candidates = manifests.filter((manifest): manifest is McpWindowManifest => manifest !== null);
  const healthResults = await Promise.all(candidates.map(async (manifest) => {
    try {
      return await healthCheck(manifest) ? manifest : null;
    } catch {
      return null;
    }
  }));
  const live = healthResults.filter((manifest): manifest is McpWindowManifest => manifest !== null);

  // A still-live explicit/environment selection is authoritative. If an
  // extension reload left a stale id in a terminal, fall back only when the
  // canonical workspace (and, if needed, the parent extension host) makes the
  // owner unambiguous.
  if (requestedWindowId !== undefined) {
    const requested = live.filter((manifest) => manifest.windowId === requestedWindowId);
    if (requested.length === 1) {
      return requested[0];
    }
    // --window-id is an explicit routing instruction and must never silently
    // connect to another window. The inherited environment id is different:
    // terminals can retain it across an extension-host reload, so it may fall
    // back through exact workspace/parent ownership below.
    if (explicitWindowId !== undefined) {
      throw noWindowError(explicitWindowId, workspace);
    }
  }

  if (live.length === 0) {
    throw noWindowError(requestedWindowId, workspace);
  }
  if (live.length === 1) {
    return live[0];
  }

  const parentPid = options.parentPid ?? process.ppid;
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const ownedByParent = live.filter((manifest) => manifest.extensionPid === parentPid);
    if (ownedByParent.length === 1) {
      return ownedByParent[0];
    }
  }
  if (live.length > 1) {
    const ids = live.map((manifest) => manifest.windowId).sort().join(', ');
    throw new McpBridgeError(
      'AMBIGUOUS_WINDOW',
      `AMBIGUOUS_WINDOW: ${live.length} live VS Code windows expose workspace ${workspace} (${ids}). Pass --window-id or set ${MCP_WINDOW_ID_ENV}.`,
    );
  }
  return live[0];
}

function noWindowError(windowId: string | undefined, workspace: string): McpBridgeError {
  if (windowId !== undefined) {
    return new McpBridgeError(
      'WINDOW_NOT_FOUND',
      `WINDOW_NOT_FOUND: no live VS Code window ${windowId} exposes workspace ${workspace}.`,
    );
  }
  return new McpBridgeError(
    'NO_LIVE_WINDOW',
    `NO_LIVE_WINDOW: no live VS Code window exposes workspace ${workspace}. Open the project in VS Code and enable the Django debugger MCP server.`,
  );
}

function healthUrl(manifest: McpWindowManifest): URL {
  const endpoint = assertLoopbackHttpUrl(manifest.url);
  endpoint.pathname = '/health';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

export async function checkMcpWindowHealth(
  manifest: McpWindowManifest,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const response = await requestHttp(healthUrl(manifest), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${manifest.token}`,
      accept: 'application/json',
    },
  }, timeoutMs, 64 * 1024);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return false;
  }
  try {
    const body = JSON.parse(response.body) as unknown;
    return isRecord(body) && body.windowId === manifest.windowId;
  } catch {
    return false;
  }
}

function requestHttp(
  url: URL,
  options: http.RequestOptions,
  timeoutMs: number,
  maxResponseBytes: number,
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(url, options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxResponseBytes) {
          response.destroy(new McpBridgeError(
            'INVALID_RESPONSE',
            `MCP response exceeds ${maxResponseBytes} bytes`,
          ));
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', rejectOnce);
      response.on('aborted', () => rejectOnce(new McpBridgeError(
        'HTTP_ERROR',
        'MCP HTTP response was aborted',
      )));
      response.on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    const rejectOnce = (error: unknown): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    request.once('error', rejectOnce);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new McpBridgeError(
        'HTTP_ERROR',
        `MCP HTTP request timed out after ${timeoutMs}ms`,
      ));
    });
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export async function postMcpHttp(
  manifest: McpWindowManifest,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<HttpResponse> {
  const endpoint = assertLoopbackHttpUrl(manifest.url);
  return requestHttp(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${manifest.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...headers,
    },
  }, timeoutMs, maxResponseBytes, body);
}

function parseJsonRpcLine(line: string): ParsedJsonRpcLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new McpBridgeError('INVALID_ARGUMENT', `Invalid JSON-RPC input: ${errorMessage(error)}`, error);
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    throw new McpBridgeError('INVALID_ARGUMENT', 'JSON-RPC input must be an object or batch array');
  }
  return {
    raw: JSON.stringify(value),
    value,
    ...(isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'id') ? { id: value.id } : {}),
    ...(isRecord(value) && typeof value.method === 'string' ? { method: value.method } : {}),
  };
}

function isJsonRpcErrorBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) && parsed.jsonrpc === '2.0' && isRecord(parsed.error);
  } catch {
    return false;
  }
}

function assertForwardableHttpResponse(response: HttpResponse): void {
  if ((response.statusCode < 200 || response.statusCode >= 300)
    && !isJsonRpcErrorBody(response.body)) {
    throw new McpBridgeError(
      'HTTP_ERROR',
      `MCP endpoint returned HTTP ${response.statusCode}${response.body.trim() ? `: ${response.body.trim().slice(0, 500)}` : ''}`,
    );
  }
}

function responseLines(response: HttpResponse): string[] {
  if (response.statusCode === 202 || response.statusCode === 204 || response.body.trim() === '') {
    return [];
  }
  assertForwardableHttpResponse(response);

  const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    const lines: string[] = [];
    let data: string[] = [];
    const flush = (): void => {
      if (data.length === 0) {
        return;
      }
      const payload = data.join('\n');
      data = [];
      if (payload !== '[DONE]') {
        lines.push(compactJson(payload));
      }
    };
    for (const line of response.body.split(/\r?\n/)) {
      if (line === '') {
        flush();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    flush();
    return lines;
  }
  return [compactJson(response.body)];
}

function compactJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch (error) {
    throw new McpBridgeError('INVALID_RESPONSE', `MCP endpoint returned invalid JSON: ${errorMessage(error)}`, error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof McpBridgeError)) {
    return true;
  }
  return error.code === 'HTTP_ERROR';
}

const RETRY_SAFE_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
]);

const RETRY_SAFE_TOOLS = new Set([
  'django_debugger_status',
  'django_targets_list',
  'django_execution_wait',
  'django_session_wait_ready',
  'django_breakpoints_status',
  'django_state_snapshot',
  'django_variables_expand',
  'django_request_context',
  'django_failure_snapshot',
]);

/** Retry only operations whose debugger-visible effects are read-only. */
function isSafeToRetry(request: ParsedJsonRpcLine): boolean {
  if (!isRecord(request.value)
    || !Object.prototype.hasOwnProperty.call(request.value, 'id')
    || typeof request.value.method !== 'string') {
    // Notifications and batches are never resent: delivery may have succeeded.
    return false;
  }
  if (RETRY_SAFE_METHODS.has(request.value.method)) {
    return true;
  }
  if (request.value.method !== 'tools/call' || !isRecord(request.value.params)) {
    return false;
  }
  return typeof request.value.params.name === 'string'
    && RETRY_SAFE_TOOLS.has(request.value.params.name);
}

function isValidClientId(value: string): boolean {
  return value.length >= 16
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

/** Stateful stdio-to-HTTP adapter. One instance belongs to one client process. */
export class McpStdioBridge {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly errorOutput: Writable;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly discover: (options: ManifestDiscoveryOptions) => Promise<McpWindowManifest>;
  private readonly post: NonNullable<StdioBridgeOptions['post']>;
  private readonly clientId: string;
  private manifest?: McpWindowManifest;
  private discovery?: Promise<McpWindowManifest>;
  private sessionId?: string;
  private protocolVersion?: string;

  constructor(private readonly options: StdioBridgeOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.errorOutput = options.errorOutput ?? process.stderr;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.clientId = options.clientId ?? randomBytes(24).toString('base64url');
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new McpBridgeError('INVALID_ARGUMENT', 'requestTimeoutMs must be a positive integer');
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new McpBridgeError('INVALID_ARGUMENT', 'maxResponseBytes must be a positive integer');
    }
    if (!Number.isInteger(this.connectTimeoutMs) || this.connectTimeoutMs < 0) {
      throw new McpBridgeError('INVALID_ARGUMENT', 'connectTimeoutMs must be a non-negative integer');
    }
    if (!isValidClientId(this.clientId)) {
      throw new McpBridgeError(
        'INVALID_ARGUMENT',
        'clientId must be 16-128 base64url characters',
      );
    }
    this.discover = options.discover ?? discoverMcpWindow;
    this.post = options.post ?? postMcpHttp;
  }

  async connect(): Promise<McpWindowManifest> {
    return this.getManifest(true);
  }

  async run(): Promise<void> {
    await this.connect();
    const lines = readline.createInterface({
      input: this.input,
      crlfDelay: Infinity,
      terminal: false,
    });
    const pending = new Set<Promise<void>>();
    lines.on('line', (line) => {
      if (!line.trim()) {
        return;
      }
      const operation = this.forwardLine(line).finally(() => pending.delete(operation));
      pending.add(operation);
    });
    await new Promise<void>((resolve) => lines.once('close', resolve));
    await Promise.allSettled([...pending]);
  }

  async forwardLine(line: string): Promise<void> {
    let request: ParsedJsonRpcLine;
    try {
      request = parseJsonRpcLine(line);
    } catch (error) {
      this.writeProtocolError(undefined, error);
      return;
    }

    let requestedProtocolVersion: string | undefined;
    if (request.method === 'initialize' && isRecord(request.value)) {
      const params = request.value.params;
      if (isRecord(params) && typeof params.protocolVersion === 'string') {
        requestedProtocolVersion = params.protocolVersion;
      }
    }

    try {
      let response: HttpResponse;
      try {
        response = await this.send(request.raw);
        assertForwardableHttpResponse(response);
      } catch (error) {
        if (!isRetryable(error)) {
          throw error;
        }
        if (!isSafeToRetry(request)) {
          // The endpoint may have executed a mutating request before the
          // response was lost. Invalidate discovery/session state, but never
          // risk executing that request a second time.
          this.manifest = undefined;
          this.sessionId = undefined;
          this.log(`request failed; connection invalidated without retry: ${errorMessage(error)}`);
          throw error;
        }
        this.log(`request failed; rediscovering once: ${errorMessage(error)}`);
        const previous = this.manifest;
        this.manifest = undefined;
        const refreshed = await this.getManifest(true);
        if (previous === undefined
          || previous.windowId !== refreshed.windowId
          || previous.url !== refreshed.url
          || previous.token !== refreshed.token
          || previous.startedAt !== refreshed.startedAt) {
          this.sessionId = undefined;
        }
        response = await this.send(request.raw);
        assertForwardableHttpResponse(response);
      }

      const responseSessionHeader = response.headers['mcp-session-id'];
      const responseSession = Array.isArray(responseSessionHeader)
        ? responseSessionHeader[0]
        : responseSessionHeader;
      if (typeof responseSession === 'string' && responseSession.trim()) {
        this.sessionId = responseSession.trim();
      }
      const lines = responseLines(response);
      if (request.method === 'initialize') {
        const negotiated = negotiatedProtocolVersion(lines);
        if (negotiated !== undefined) {
          this.protocolVersion = negotiated;
        } else if (hasJsonRpcSuccess(lines)) {
          this.protocolVersion = requestedProtocolVersion;
        }
      }
      for (const responseLine of lines) {
        this.output.write(`${responseLine}\n`);
      }
    } catch (error) {
      this.log(`request failed: ${errorMessage(error)}`);
      if (request.id !== undefined) {
        this.writeProtocolError(request.id, error);
      }
    }
  }

  private async send(body: string): Promise<HttpResponse> {
    const manifest = await this.getManifest();
    const headers: Record<string, string> = {
      [MCP_BRIDGE_CLIENT_ID_HEADER]: this.clientId,
    };
    if (this.sessionId !== undefined) {
      headers['mcp-session-id'] = this.sessionId;
    }
    if (this.protocolVersion !== undefined) {
      headers['mcp-protocol-version'] = this.protocolVersion;
    }
    return this.post(
      manifest,
      body,
      headers,
      this.requestTimeoutMs,
      this.maxResponseBytes,
    );
  }

  private async getManifest(force = false): Promise<McpWindowManifest> {
    if (!force && this.manifest !== undefined) {
      return this.manifest;
    }
    if (this.discovery === undefined) {
      this.discovery = this.discoverWithPolling().then((manifest) => {
        this.manifest = manifest;
        return manifest;
      }).finally(() => {
        this.discovery = undefined;
      });
    }
    return this.discovery;
  }

  private async discoverWithPolling(): Promise<McpWindowManifest> {
    const deadline = Date.now() + this.connectTimeoutMs;
    for (;;) {
      try {
        return await this.discover(this.options);
      } catch (error) {
        const retryable = error instanceof McpBridgeError
          && (error.code === 'NO_LIVE_WINDOW' || error.code === 'WINDOW_NOT_FOUND');
        if (!retryable || Date.now() >= deadline) {
          throw error;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(CONNECT_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
        });
      }
    }
  }

  private writeProtocolError(id: unknown, error: unknown): void {
    const bridgeError = error instanceof McpBridgeError ? error : undefined;
    this.output.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: id === undefined ? -32700 : -32098,
        message: errorMessage(error),
        data: { bridgeCode: bridgeError?.code ?? 'HTTP_ERROR' },
      },
    })}\n`);
  }

  private log(message: string): void {
    this.errorOutput.write(`[django-debugger-mcp] ${message}${os.EOL}`);
  }
}

function negotiatedProtocolVersion(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    try {
      const response = JSON.parse(line) as unknown;
      if (isRecord(response)
        && isRecord(response.result)
        && typeof response.result.protocolVersion === 'string') {
        return response.result.protocolVersion;
      }
    } catch {
      // responseLines already validated JSON; keep this helper defensive.
    }
  }
  return undefined;
}

function hasJsonRpcSuccess(lines: readonly string[]): boolean {
  return lines.some((line) => {
    try {
      const response = JSON.parse(line) as unknown;
      return isRecord(response)
        && response.jsonrpc === '2.0'
        && Object.prototype.hasOwnProperty.call(response, 'result')
        && !Object.prototype.hasOwnProperty.call(response, 'error');
    } catch {
      return false;
    }
  });
}

export function parseStdioCli(argv: readonly string[]): CliOptions {
  if (argv[0] !== 'stdio') {
    throw new McpBridgeError(
      'INVALID_ARGUMENT',
      'Usage: stdio --workspace <path> [--window-id <id>] [--connect-timeout-ms <ms>]',
    );
  }
  let workspacePath: string | undefined;
  let windowId: string | undefined;
  let registryDir: string | undefined;
  let connectTimeoutMs: number | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    if (name !== '--workspace'
      && name !== '--window-id'
      && name !== '--registry-dir'
      && name !== '--connect-timeout-ms') {
      throw new McpBridgeError('INVALID_ARGUMENT', `Unknown argument: ${argument}`);
    }
    const value = inline ?? argv[++index];
    if (!isNonEmptyString(value)) {
      throw new McpBridgeError('INVALID_ARGUMENT', `${name} requires a value`);
    }
    if (name === '--workspace') {
      workspacePath = value;
    } else if (name === '--window-id') {
      windowId = value;
    } else if (name === '--registry-dir') {
      registryDir = value;
    } else {
      connectTimeoutMs = Number(value);
      if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 0) {
        throw new McpBridgeError(
          'INVALID_ARGUMENT',
          '--connect-timeout-ms must be a non-negative integer',
        );
      }
    }
  }
  if (workspacePath === undefined) {
    throw new McpBridgeError('INVALID_ARGUMENT', '--workspace is required');
  }
  return { workspacePath, windowId, registryDir, connectTimeoutMs };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseStdioCli(argv);
  const bridge = new McpStdioBridge(cli);
  await bridge.run();
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`[django-debugger-mcp] ${errorMessage(error)}${os.EOL}`);
    process.exitCode = 1;
  });
}
