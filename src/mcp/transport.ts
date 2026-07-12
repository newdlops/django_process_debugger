import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as http from 'http';
import { Socket } from 'net';

export const MCP_PROTOCOL_VERSION = '2025-11-25' as const;
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
] as const;
export const MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MCP_CLIENT_ID_HEADER = 'x-django-debugger-mcp-client-id';
export const MCP_MAX_CLIENT_ID_LENGTH = 128;

export type McpProtocolVersion = typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number];
export type McpRequestId = string | number;
export type MaybePromise<T> = T | Promise<T>;
export type McpJsonObject = Record<string, unknown>;

export interface McpIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/** A standards-shaped definition returned verbatim from `tools/list`. */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: McpJsonObject;
  outputSchema?: McpJsonObject;
  annotations?: McpToolAnnotations;
  icons?: McpIcon[];
  _meta?: McpJsonObject;
}

export interface McpToolCallResult {
  /** JSON object intended for programmatic consumption by MCP clients. */
  structuredContent?: McpJsonObject;
  /** Human-readable rendering. JSON serialization is supplied when omitted. */
  text?: string;
  isError?: boolean;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  icons?: McpIcon[];
  annotations?: McpJsonObject;
  _meta?: McpJsonObject;
}

export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: McpIcon[];
  annotations?: McpJsonObject;
  _meta?: McpJsonObject;
}

export interface McpTextResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
  _meta?: McpJsonObject;
}

export interface McpBlobResourceContents {
  uri: string;
  mimeType?: string;
  blob: string;
  _meta?: McpJsonObject;
}

export type McpResourceContents = McpTextResourceContents | McpBlobResourceContents;

export interface McpResourceReadResult {
  contents: McpResourceContents[];
  _meta?: McpJsonObject;
}

export interface McpRequestContext {
  requestId: McpRequestId;
  protocolVersion: McpProtocolVersion;
  signal: AbortSignal;
}

/**
 * Window-owned implementation behind the transport. Methods may read live
 * debugger state, but the HTTP layer deliberately owns no client session.
 */
export interface McpTransportBackend {
  listTools(): MaybePromise<readonly McpToolDefinition[]>;
  callTool(
    name: string,
    args: McpJsonObject,
    context: McpRequestContext,
  ): MaybePromise<McpToolCallResult>;
  listResources?(): MaybePromise<readonly McpResourceDefinition[]>;
  readResource?(
    uri: string,
    context: McpRequestContext,
  ): MaybePromise<McpResourceReadResult | undefined>;
  listResourceTemplates?(): MaybePromise<readonly McpResourceTemplateDefinition[]>;
  onInitialized?(protocolVersion: McpProtocolVersion): MaybePromise<void>;
  onCancelled?(requestId: McpRequestId, reason: string | undefined): MaybePromise<void>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
  description?: string;
}

export interface McpHealthMetadata {
  windowId?: string;
  workspaceFolders?: unknown;
  serverVersion?: string;
  [key: string]: unknown;
}

export interface McpTransportOptions {
  backend: McpTransportBackend;
  /** Generated securely when omitted. Never written to logs by this module. */
  authToken?: string;
  serverInfo?: McpServerInfo;
  instructions?: string;
  health?: McpHealthMetadata | (() => MaybePromise<McpHealthMetadata>);
}

export interface StartedMcpTransport {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly url: string;
  readonly healthUrl: string;
  readonly token: string;
  dispose(): Promise<void>;
}

/** A recoverable error produced while a valid tool invocation is executing. */
export class McpToolExecutionError extends Error {
  readonly structuredContent: McpJsonObject;

  constructor(message: string, details: McpJsonObject = {}) {
    super(message);
    this.name = 'McpToolExecutionError';
    this.structuredContent = {
      error: {
        message,
        ...details,
      },
    };
  }
}

/** An explicit JSON-RPC error for backend failures that are not tool outcomes. */
export class McpJsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpJsonRpcError';
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: McpRequestId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: McpRequestId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: McpRequestId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface DispatchResponse {
  kind: 'response';
  value: JsonRpcSuccess | JsonRpcFailure;
}

interface DispatchNotification {
  kind: 'notification';
}

type DispatchResult = DispatchResponse | DispatchNotification;

class HttpRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRequestId(value: unknown): value is McpRequestId {
  return typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isSupportedProtocolVersion(value: string): value is McpProtocolVersion {
  return (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

function rpcSuccess(id: McpRequestId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function rpcFailure(
  id: McpRequestId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function parseBearerToken(header: string | undefined): string {
  if (header === undefined) {
    return '';
  }
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(header);
  return match?.[1] ?? '';
}

/** Hashing makes both operands a fixed length before the constant-time check. */
function bearerMatches(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

function loopbackAuthorityIsValid(authority: string | undefined, port: number): boolean {
  if (!authority || /[\s/@\\]/.test(authority)) {
    return false;
  }
  try {
    const parsed = new URL(`http://${authority}`);
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && parsed.port === String(port)
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/';
  } catch {
    return false;
  }
}

function originIsValid(origin: string | undefined, port: number): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin
      && parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && parsed.port === String(port)
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function requestPath(request: http.IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/__invalid_request_target__';
  }
}

function writeEmpty(response: http.ServerResponse, statusCode: number, headers: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end();
}

function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      request.resume();
      throw new HttpRequestError(400, 'Invalid Content-Length');
    }
    if (parsed > MCP_MAX_REQUEST_BODY_BYTES) {
      request.resume();
      throw new HttpRequestError(413, 'Request body exceeds 1 MiB');
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > MCP_MAX_REQUEST_BODY_BYTES) {
        rejectOnce(new HttpRequestError(413, 'Request body exceeds 1 MiB'));
        request.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, byteLength));
    };
    const onAborted = (): void => rejectOnce(new HttpRequestError(400, 'Request aborted'));
    const onError = (error: Error): void => rejectOnce(error);

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

function protocolVersionFromHeader(request: http.IncomingMessage): McpProtocolVersion {
  const header = request.headers['mcp-protocol-version'];
  if (header === undefined) {
    return '2025-03-26';
  }
  if (typeof header !== 'string' || !isSupportedProtocolVersion(header)) {
    throw new HttpRequestError(400, 'Unsupported MCP-Protocol-Version');
  }
  return header;
}

function clientIdFromHeader(request: http.IncomingMessage): string {
  const value = request.headers[MCP_CLIENT_ID_HEADER];
  if (typeof value !== 'string'
    || value.length < 16
    || value.length > MCP_MAX_CLIENT_ID_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpRequestError(
      400,
      `${MCP_CLIENT_ID_HEADER} must be 16-${MCP_MAX_CLIENT_ID_LENGTH} base64url characters`,
    );
  }
  return value;
}

function requireParamsObject(params: unknown, method: string): McpJsonObject {
  if (!isRecord(params)) {
    throw new McpJsonRpcError(-32602, `${method} params must be an object`);
  }
  return params;
}

function optionalParamsObject(params: unknown, method: string): McpJsonObject {
  if (params === undefined) {
    return {};
  }
  return requireParamsObject(params, method);
}

function normalizeToolResult(result: McpToolCallResult): McpJsonObject {
  const structuredContent = result.structuredContent ?? (
    result.isError
      ? { error: { message: result.text ?? 'Tool execution failed' } }
      : { result: result.text ?? null }
  );
  if (!isRecord(structuredContent)) {
    throw new McpJsonRpcError(-32603, 'Tool returned invalid structuredContent');
  }
  const text = result.text ?? JSON.stringify(structuredContent);
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError: result.isError === true,
  };
}

function requestKey(clientId: string, id: McpRequestId): string {
  return `${clientId.length}:${clientId}:${typeof id}:${String(id)}`;
}

async function resolveHealth(options: McpTransportOptions): Promise<McpJsonObject> {
  const metadata = typeof options.health === 'function'
    ? await options.health()
    : options.health ?? {};
  return { ...metadata, ok: true };
}

/** Start an authenticated, window-local, stateless MCP Streamable HTTP server. */
export async function startMcpTransport(options: McpTransportOptions): Promise<StartedMcpTransport> {
  if (!options || !options.backend) {
    throw new TypeError('backend is required');
  }
  const token = options.authToken ?? randomBytes(32).toString('base64url');
  if (token.length === 0 || /\s/.test(token)) {
    throw new TypeError('authToken must be a non-empty token without whitespace');
  }

  let port = 0;
  let disposePromise: Promise<void> | undefined;
  const activeRequests = new Map<string, AbortController>();
  const sockets = new Set<Socket>();

  const dispatchRequest = async (
    request: JsonRpcRequest,
    protocolVersion: McpProtocolVersion,
    clientId: string,
  ): Promise<DispatchResponse> => {
    const { id, method, params } = request;
    try {
      switch (method) {
        case 'initialize': {
          const input = requireParamsObject(params, method);
          const requestedVersion = input.protocolVersion;
          if (typeof requestedVersion !== 'string') {
            throw new McpJsonRpcError(-32602, 'initialize params.protocolVersion must be a string');
          }
          const negotiated = isSupportedProtocolVersion(requestedVersion)
            ? requestedVersion
            : MCP_PROTOCOL_VERSION;
          return {
            kind: 'response',
            value: rpcSuccess(id, {
              protocolVersion: negotiated,
              capabilities: {
                tools: {},
                resources: {},
              },
              serverInfo: options.serverInfo ?? {
                name: 'django-process-debugger',
                version: '0.0.0',
              },
              ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
            }),
          };
        }
        case 'ping': {
          optionalParamsObject(params, method);
          return { kind: 'response', value: rpcSuccess(id, {}) };
        }
        case 'tools/list': {
          optionalParamsObject(params, method);
          const tools = await options.backend.listTools();
          return { kind: 'response', value: rpcSuccess(id, { tools: [...tools] }) };
        }
        case 'tools/call': {
          const input = requireParamsObject(params, method);
          if (typeof input.name !== 'string' || input.name.length === 0) {
            throw new McpJsonRpcError(-32602, 'tools/call params.name must be a non-empty string');
          }
          const args = input.arguments === undefined ? {} : input.arguments;
          if (!isRecord(args)) {
            throw new McpJsonRpcError(-32602, 'tools/call params.arguments must be an object');
          }
          const tools = await options.backend.listTools();
          if (!tools.some((tool) => tool.name === input.name)) {
            throw new McpJsonRpcError(-32602, `Unknown tool: ${input.name}`);
          }
          const controller = new AbortController();
          const key = requestKey(clientId, id);
          if (activeRequests.has(key)) {
            throw new McpJsonRpcError(-32600, `Request id is already active: ${String(id)}`);
          }
          activeRequests.set(key, controller);
          try {
            const result = await options.backend.callTool(input.name, args, {
              requestId: id,
              protocolVersion,
              signal: controller.signal,
            });
            return { kind: 'response', value: rpcSuccess(id, normalizeToolResult(result)) };
          } catch (error) {
            if (error instanceof McpToolExecutionError) {
              return {
                kind: 'response',
                value: rpcSuccess(id, normalizeToolResult({
                  structuredContent: error.structuredContent,
                  text: error.message,
                  isError: true,
                })),
              };
            }
            throw error;
          } finally {
            if (activeRequests.get(key) === controller) {
              activeRequests.delete(key);
            }
          }
        }
        case 'resources/list': {
          optionalParamsObject(params, method);
          const resources = await options.backend.listResources?.() ?? [];
          return { kind: 'response', value: rpcSuccess(id, { resources: [...resources] }) };
        }
        case 'resources/read': {
          const input = requireParamsObject(params, method);
          if (typeof input.uri !== 'string' || input.uri.length === 0) {
            throw new McpJsonRpcError(-32602, 'resources/read params.uri must be a non-empty string');
          }
          if (!options.backend.readResource) {
            throw new McpJsonRpcError(-32002, `Resource not found: ${input.uri}`);
          }
          const controller = new AbortController();
          const key = requestKey(clientId, id);
          if (activeRequests.has(key)) {
            throw new McpJsonRpcError(-32600, `Request id is already active: ${String(id)}`);
          }
          activeRequests.set(key, controller);
          try {
            const result = await options.backend.readResource(input.uri, {
              requestId: id,
              protocolVersion,
              signal: controller.signal,
            });
            if (result === undefined) {
              throw new McpJsonRpcError(-32002, `Resource not found: ${input.uri}`);
            }
            return { kind: 'response', value: rpcSuccess(id, result) };
          } finally {
            if (activeRequests.get(key) === controller) {
              activeRequests.delete(key);
            }
          }
        }
        case 'resources/templates/list': {
          optionalParamsObject(params, method);
          const resourceTemplates = await options.backend.listResourceTemplates?.() ?? [];
          return {
            kind: 'response',
            value: rpcSuccess(id, { resourceTemplates: [...resourceTemplates] }),
          };
        }
        default:
          throw new McpJsonRpcError(-32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (error instanceof McpJsonRpcError) {
        return { kind: 'response', value: rpcFailure(id, error.code, error.message, error.data) };
      }
      return { kind: 'response', value: rpcFailure(id, -32603, 'Internal error') };
    }
  };

  const dispatchNotification = async (
    notification: JsonRpcNotification,
    protocolVersion: McpProtocolVersion,
    clientId: string,
  ): Promise<void> => {
    switch (notification.method) {
      case 'notifications/initialized':
        if (notification.params !== undefined && !isRecord(notification.params)) {
          throw new HttpRequestError(400, 'notifications/initialized params must be an object');
        }
        await options.backend.onInitialized?.(protocolVersion);
        return;
      case 'notifications/cancelled': {
        const input = requireParamsObject(notification.params, notification.method);
        if (!isRequestId(input.requestId)) {
          throw new HttpRequestError(400, 'notifications/cancelled params.requestId is invalid');
        }
        if (input.reason !== undefined && typeof input.reason !== 'string') {
          throw new HttpRequestError(400, 'notifications/cancelled params.reason must be a string');
        }
        const controller = activeRequests.get(requestKey(clientId, input.requestId));
        if (controller !== undefined) {
          controller.abort(input.reason);
          await options.backend.onCancelled?.(input.requestId, input.reason);
        }
        return;
      }
      default:
        // JSON-RPC notifications never receive JSON-RPC error responses.
        return;
    }
  };

  const dispatch = async (
    value: unknown,
    protocolVersion: McpProtocolVersion,
    clientId: string,
  ): Promise<DispatchResult> => {
    if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
      if (isRecord(value)
        && value.jsonrpc === '2.0'
        && isRequestId(value.id)
        && (hasOwn(value, 'result') || hasOwn(value, 'error'))) {
        return { kind: 'notification' };
      }
      return { kind: 'response', value: rpcFailure(null, -32600, 'Invalid Request') };
    }
    if (hasOwn(value, 'id')) {
      if (!isRequestId(value.id)) {
        return { kind: 'response', value: rpcFailure(null, -32600, 'Invalid Request') };
      }
      return dispatchRequest(value as unknown as JsonRpcRequest, protocolVersion, clientId);
    }
    await dispatchNotification(value as unknown as JsonRpcNotification, protocolVersion, clientId);
    return { kind: 'notification' };
  };

  const handleRequest = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    if (!loopbackAuthorityIsValid(request.headers.host, port)
      || !originIsValid(typeof request.headers.origin === 'string' ? request.headers.origin : undefined, port)) {
      writeJson(response, 403, { error: 'Forbidden' });
      request.resume();
      return;
    }
    const presentedToken = parseBearerToken(request.headers.authorization);
    if (!bearerMatches(presentedToken, token)) {
      writeJson(response, 401, { error: 'Unauthorized' }, {
        'www-authenticate': 'Bearer',
      });
      request.resume();
      return;
    }

    const path = requestPath(request);
    if (path === '/health') {
      if (request.method !== 'GET') {
        writeEmpty(response, 405, { allow: 'GET' });
        request.resume();
        return;
      }
      writeJson(response, 200, await resolveHealth(options));
      return;
    }
    if (path !== '/mcp') {
      writeJson(response, 404, { error: 'Not Found' });
      request.resume();
      return;
    }
    if (request.method !== 'POST') {
      writeEmpty(response, 405, { allow: 'POST' });
      request.resume();
      return;
    }
    const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      writeJson(response, 415, { error: 'Content-Type must be application/json' });
      request.resume();
      return;
    }

    let protocolVersion: McpProtocolVersion;
    try {
      protocolVersion = protocolVersionFromHeader(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid MCP protocol version';
      writeJson(response, 400, rpcFailure(null, -32602, message));
      request.resume();
      return;
    }
    let clientId: string;
    try {
      clientId = clientIdFromHeader(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid MCP bridge client id';
      writeJson(response, 400, rpcFailure(null, -32600, message));
      request.resume();
      return;
    }

    let body: Buffer;
    try {
      body = await readRequestBody(request);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        writeJson(response, error.statusCode, rpcFailure(null, -32600, error.message));
        return;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      writeJson(response, 400, rpcFailure(null, -32700, 'Parse error'));
      return;
    }

    let result: DispatchResult;
    try {
      result = await dispatch(value, protocolVersion, clientId);
    } catch (error) {
      if (error instanceof HttpRequestError || error instanceof McpJsonRpcError) {
        writeJson(response, 400, rpcFailure(
          null,
          error instanceof McpJsonRpcError ? error.code : -32600,
          error.message,
          error instanceof McpJsonRpcError ? error.data : undefined,
        ));
        return;
      }
      writeJson(response, 500, rpcFailure(null, -32603, 'Internal error'));
      return;
    }
    if (result.kind === 'notification') {
      writeEmpty(response, 202);
      return;
    }
    writeJson(response, 200, result.value);
  };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, rpcFailure(null, -32603, 'Internal error'));
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('MCP transport did not receive a TCP address');
  }
  port = address.port;
  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    host: '127.0.0.1',
    port,
    url,
    healthUrl: `http://127.0.0.1:${port}/health`,
    token,
    dispose(): Promise<void> {
      if (disposePromise) {
        return disposePromise;
      }
      for (const controller of activeRequests.values()) {
        controller.abort('MCP transport disposed');
      }
      activeRequests.clear();
      disposePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      return disposePromise;
    },
  };
}
