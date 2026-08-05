import * as assert from 'assert';
import * as http from 'http';
import { afterEach, describe, it } from 'mocha';
import {
  MCP_CLIENT_ID_HEADER,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpJsonRpcError,
  McpToolExecutionError,
  McpTransportBackend,
  McpTransportOptions,
  StartedMcpTransport,
  startMcpTransport,
} from '../../mcp/transport';

interface HttpResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface RequestOptions {
  method?: string;
  path?: string;
  token?: string;
  body?: string;
  headers?: Record<string, string>;
  /** null deliberately omits the bridge client id. */
  clientId?: string | null;
}

const TEST_CLIENT_ID = 'transport-test-client-0001';

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseBody(result: HttpResult): Record<string, any> {
  return JSON.parse(result.body) as Record<string, any>;
}

function request(server: StartedMcpTransport, options: RequestOptions = {}): Promise<HttpResult> {
  const body = options.body;
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    ...(options.clientId === null
      ? {}
      : { [MCP_CLIENT_ID_HEADER]: options.clientId ?? TEST_CLIENT_ID }),
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const outgoing = http.request({
      hostname: server.host,
      port: server.port,
      path: options.path ?? '/mcp',
      method: options.method ?? 'POST',
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      response.once('end', () => {
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
    outgoing.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    outgoing.end(body);
  });
}

function rpcRequest(id: string | number, method: string, params?: unknown): string {
  return json({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function baseBackend(): McpTransportBackend {
  return {
    listTools: () => [{
      name: 'echo',
      title: 'Echo',
      description: 'Return the supplied input',
      inputSchema: {
        type: 'object',
        properties: { value: {} },
      },
      outputSchema: {
        type: 'object',
        properties: { value: {} },
      },
      annotations: { readOnlyHint: true },
    }],
    callTool: (_name, args) => ({ structuredContent: { value: args.value } }),
  };
}

describe('Feature: window-local MCP Streamable HTTP transport', function () {
  const servers: StartedMcpTransport[] = [];

  async function start(overrides: Partial<McpTransportOptions> = {}): Promise<StartedMcpTransport> {
    const server = await startMcpTransport({
      backend: baseBackend(),
      authToken: 'test-secret-token',
      serverInfo: { name: 'transport-test', version: '1.2.3' },
      ...overrides,
    });
    servers.push(server);
    return server;
  }

  afterEach(async function () {
    await Promise.all(servers.splice(0).map((server) => server.dispose()));
  });

  it('binds a different ephemeral IPv4 loopback port per window', async function () {
    const left = await start({ authToken: undefined });
    const right = await start({ authToken: undefined });

    assert.strictEqual(left.host, '127.0.0.1');
    assert.strictEqual(new URL(left.url).hostname, '127.0.0.1');
    assert.strictEqual(new URL(left.url).pathname, '/mcp');
    assert.ok(left.port > 0);
    assert.notStrictEqual(left.port, right.port);
    assert.match(left.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.notStrictEqual(left.token, right.token);
    await left.dispose();
    await left.dispose();
  });

  it('authenticates health checks and returns window discovery metadata', async function () {
    let healthReads = 0;
    const server = await start({
      health: () => {
        healthReads += 1;
        return {
          ok: false,
          windowId: 'window-7',
          workspaceFolders: ['/workspace/a', '/workspace/b'],
          serverVersion: '1.2.3',
        };
      },
    });

    const missing = await request(server, { method: 'GET', path: '/health' });
    assert.strictEqual(missing.statusCode, 401);
    assert.strictEqual(missing.headers['www-authenticate'], 'Bearer');
    assert.strictEqual(healthReads, 0);

    const wrongLength = await request(server, {
      method: 'GET',
      path: '/health',
      token: 'x',
    });
    assert.strictEqual(wrongLength.statusCode, 401);

    const healthy = await request(server, {
      method: 'GET',
      path: '/health',
      token: server.token,
    });
    assert.strictEqual(healthy.statusCode, 200);
    assert.deepStrictEqual(parseBody(healthy), {
      ok: true,
      windowId: 'window-7',
      workspaceFolders: ['/workspace/a', '/workspace/b'],
      serverVersion: '1.2.3',
    });
    assert.strictEqual(healthy.headers['cache-control'], 'no-store');
    assert.strictEqual(healthReads, 1);
  });

  it('rejects DNS-rebinding Host and Origin values while accepting local origins', async function () {
    const server = await start();
    const ping = rpcRequest(1, 'ping', {});

    const badHost = await request(server, {
      token: server.token,
      body: ping,
      headers: { host: `attacker.example:${server.port}` },
    });
    assert.strictEqual(badHost.statusCode, 403);

    const suffixHost = await request(server, {
      token: server.token,
      body: ping,
      headers: { host: `127.0.0.1.attacker.example:${server.port}` },
    });
    assert.strictEqual(suffixHost.statusCode, 403);

    const badOrigin = await request(server, {
      token: server.token,
      body: ping,
      headers: { origin: 'https://attacker.example' },
    });
    assert.strictEqual(badOrigin.statusCode, 403);

    const localOrigin = await request(server, {
      token: server.token,
      body: ping,
      headers: { origin: `http://localhost:${server.port}` },
    });
    assert.strictEqual(localOrigin.statusCode, 200);
    assert.deepStrictEqual(parseBody(localOrigin).result, {});
  });

  it('exposes POST-only /mcp and enforces JSON plus a 1 MiB body cap', async function () {
    const server = await start();
    const get = await request(server, {
      method: 'GET',
      token: server.token,
    });
    assert.strictEqual(get.statusCode, 405);
    assert.strictEqual(get.headers.allow, 'POST');
    assert.strictEqual(get.body, '');

    const wrongType = await request(server, {
      token: server.token,
      body: rpcRequest(1, 'ping'),
      headers: { 'content-type': 'text/plain' },
    });
    assert.strictEqual(wrongType.statusCode, 415);

    const oversized = await request(server, {
      token: server.token,
      // The server rejects this from Content-Length before reading a body.
      // Keep the payload tiny so a correct early 413 cannot race a 1 MiB
      // client write and surface as ECONNRESET in the test harness.
      body: 'x',
      headers: { 'content-length': String(MCP_MAX_REQUEST_BODY_BYTES + 1) },
    });
    assert.strictEqual(oversized.statusCode, 413);
    assert.strictEqual(parseBody(oversized).error.code, -32600);

    const missing = await request(server, {
      method: 'GET',
      path: '/unknown',
      token: server.token,
    });
    assert.strictEqual(missing.statusCode, 404);
  });

  it('requires a bounded base64url bridge client id on MCP requests', async function () {
    const server = await start();
    const body = rpcRequest(1, 'ping', {});

    const missing = await request(server, {
      token: server.token,
      body,
      clientId: null,
    });
    assert.strictEqual(missing.statusCode, 400);
    assert.strictEqual(parseBody(missing).error.code, -32600);

    for (const clientId of ['short', 'a'.repeat(129), 'invalid.client.id']) {
      const invalid = await request(server, { token: server.token, body, clientId });
      assert.strictEqual(invalid.statusCode, 400);
      assert.strictEqual(parseBody(invalid).error.code, -32600);
    }
  });

  it('negotiates the current and two prior MCP protocol versions', async function () {
    const server = await start({ instructions: 'Use debugger references only while stopped.' });

    for (const version of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
      const response = await request(server, {
        token: server.token,
        body: rpcRequest(`init-${version}`, 'initialize', {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1' },
        }),
        headers: { 'mcp-protocol-version': version },
      });
      assert.strictEqual(response.statusCode, 200);
      const message = parseBody(response);
      assert.strictEqual(message.result.protocolVersion, version);
      assert.deepStrictEqual(message.result.capabilities, { tools: {}, resources: {} });
      assert.deepStrictEqual(message.result.serverInfo, { name: 'transport-test', version: '1.2.3' });
      assert.strictEqual(message.result.instructions, 'Use debugger references only while stopped.');
    }

    const futureClient = await request(server, {
      token: server.token,
      body: rpcRequest(9, 'initialize', {
        protocolVersion: '2099-01-01',
        capabilities: {},
        clientInfo: { name: 'future', version: '1' },
      }),
    });
    assert.strictEqual(parseBody(futureClient).result.protocolVersion, MCP_PROTOCOL_VERSION);

    const unsupportedHeader = await request(server, {
      token: server.token,
      body: rpcRequest(10, 'ping'),
      headers: { 'mcp-protocol-version': '2099-01-01' },
    });
    assert.strictEqual(unsupportedHeader.statusCode, 400);
    assert.strictEqual(parseBody(unsupportedHeader).error.code, -32602);
  });

  it('returns JSON-RPC parse, request, parameter, and method errors', async function () {
    const server = await start();
    const malformed = await request(server, { token: server.token, body: '{nope' });
    assert.strictEqual(malformed.statusCode, 400);
    assert.deepStrictEqual(parseBody(malformed), {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });

    const batch = await request(server, { token: server.token, body: '[]' });
    assert.strictEqual(batch.statusCode, 200);
    assert.strictEqual(parseBody(batch).error.code, -32600);

    const badParams = await request(server, {
      token: server.token,
      body: rpcRequest(2, 'tools/call', { name: 'echo', arguments: [] }),
    });
    assert.strictEqual(badParams.statusCode, 200);
    assert.strictEqual(parseBody(badParams).error.code, -32602);

    const unknown = await request(server, {
      token: server.token,
      body: rpcRequest(3, 'does/not/exist'),
    });
    assert.strictEqual(unknown.statusCode, 200);
    assert.deepStrictEqual(parseBody(unknown).error, {
      code: -32601,
      message: 'Method not found: does/not/exist',
    });
  });

  it('handles initialized, cancellation, unknown, and response notifications with 202', async function () {
    const initialized: string[] = [];
    const cancelled: Array<{ id: string | number; reason: string | undefined }> = [];
    const server = await start({
      backend: {
        ...baseBackend(),
        onInitialized: (version) => { initialized.push(version); },
        onCancelled: (id, reason) => { cancelled.push({ id, reason }); },
      },
    });

    const messages = [
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'call-1', reason: 'client timeout' },
      },
      { jsonrpc: '2.0', method: 'notifications/unknown' },
      { jsonrpc: '2.0', id: 'server-request', result: {} },
    ];
    for (const message of messages) {
      const response = await request(server, {
        token: server.token,
        body: json(message),
        headers: { 'mcp-protocol-version': '2025-06-18' },
      });
      assert.strictEqual(response.statusCode, 202);
      assert.strictEqual(response.body, '');
    }
    assert.deepStrictEqual(initialized, ['2025-06-18']);
    // A cancellation for an unknown/scoped-away request is intentionally a no-op.
    assert.deepStrictEqual(cancelled, []);
  });

  it('lists tools and returns structured content with a text compatibility block', async function () {
    const calls: unknown[] = [];
    const backend = baseBackend();
    backend.callTool = (name, args, context) => {
      calls.push({ name, args, version: context.protocolVersion, aborted: context.signal.aborted });
      return { structuredContent: { echoed: args } };
    };
    const server = await start({ backend });

    const listed = await request(server, {
      token: server.token,
      body: rpcRequest(1, 'tools/list', {}),
    });
    assert.strictEqual(parseBody(listed).result.tools[0].name, 'echo');
    assert.strictEqual(parseBody(listed).result.tools[0].annotations.readOnlyHint, true);

    const called = await request(server, {
      token: server.token,
      body: rpcRequest('tool-1', 'tools/call', {
        name: 'echo',
        arguments: { value: 42 },
      }),
      headers: { 'mcp-protocol-version': '2025-11-25' },
    });
    const result = parseBody(called).result;
    assert.deepStrictEqual(result.structuredContent, { echoed: { value: 42 } });
    assert.deepStrictEqual(result.content, [{
      type: 'text',
      text: '{"echoed":{"value":42}}',
    }]);
    assert.strictEqual(result.isError, false);
    assert.deepStrictEqual(calls, [{
      name: 'echo',
      args: { value: 42 },
      version: '2025-11-25',
      aborted: false,
    }]);
  });

  it('separates recoverable tool failures from JSON-RPC protocol and server errors', async function () {
    let mode = 'execution';
    const backend = baseBackend();
    backend.callTool = () => {
      if (mode === 'execution') {
        throw new McpToolExecutionError('Value must be positive', { code: 'BAD_VALUE' });
      }
      if (mode === 'protocol') {
        throw new McpJsonRpcError(-32010, 'Debugger session is stale', { retryable: true });
      }
      throw new Error('secret backend detail');
    };
    const server = await start({ backend });
    const body = rpcRequest(1, 'tools/call', { name: 'echo', arguments: {} });

    const execution = parseBody(await request(server, { token: server.token, body }));
    assert.strictEqual(execution.result.isError, true);
    assert.strictEqual(execution.result.content[0].text, 'Value must be positive');
    assert.deepStrictEqual(execution.result.structuredContent, {
      error: { message: 'Value must be positive', code: 'BAD_VALUE' },
    });

    mode = 'protocol';
    const protocol = parseBody(await request(server, { token: server.token, body }));
    assert.deepStrictEqual(protocol.error, {
      code: -32010,
      message: 'Debugger session is stale',
      data: { retryable: true },
    });

    mode = 'unexpected';
    const unexpectedResponse = await request(server, { token: server.token, body });
    const unexpected = parseBody(unexpectedResponse);
    assert.deepStrictEqual(unexpected.error, { code: -32603, message: 'Internal error' });
    assert.ok(!unexpectedResponse.body.includes('secret backend detail'));

    const missing = parseBody(await request(server, {
      token: server.token,
      body: rpcRequest(2, 'tools/call', { name: 'missing' }),
    }));
    assert.strictEqual(missing.error.code, -32602);
  });

  it('lists, reads, templates, and reports missing resources', async function () {
    const server = await start({
      backend: {
        ...baseBackend(),
        listResources: () => [{
          uri: 'django-debugger://status',
          name: 'Debugger status',
          mimeType: 'application/json',
        }],
        readResource: (uri) => uri === 'django-debugger://status'
          ? {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: '{"attached":true}',
            }],
          }
          : undefined,
        listResourceTemplates: () => [{
          uriTemplate: 'django-debugger://session/{sessionRef}',
          name: 'Debug session',
          mimeType: 'application/json',
        }],
      },
    });

    const listed = parseBody(await request(server, {
      token: server.token,
      body: rpcRequest(1, 'resources/list', {}),
    }));
    assert.strictEqual(listed.result.resources[0].uri, 'django-debugger://status');

    const read = parseBody(await request(server, {
      token: server.token,
      body: rpcRequest(2, 'resources/read', { uri: 'django-debugger://status' }),
    }));
    assert.strictEqual(read.result.contents[0].text, '{"attached":true}');

    const templates = parseBody(await request(server, {
      token: server.token,
      body: rpcRequest(3, 'resources/templates/list', {}),
    }));
    assert.strictEqual(
      templates.result.resourceTemplates[0].uriTemplate,
      'django-debugger://session/{sessionRef}',
    );

    const missing = parseBody(await request(server, {
      token: server.token,
      body: rpcRequest(4, 'resources/read', { uri: 'django-debugger://missing' }),
    }));
    assert.strictEqual(missing.error.code, -32002);
  });

  it('aborts an in-flight tool when a matching cancellation notification arrives', async function () {
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let observedReason: unknown;
    const backend = baseBackend();
    backend.callTool = (_name, _args, context) => new Promise((resolve) => {
      announceStarted();
      context.signal.addEventListener('abort', () => {
        observedReason = context.signal.reason;
        resolve({ structuredContent: { cancelled: true } });
      }, { once: true });
    });
    const server = await start({ backend });

    const call = request(server, {
      token: server.token,
      body: rpcRequest('running-call', 'tools/call', { name: 'echo' }),
    });
    await started;
    const cancellation = await request(server, {
      token: server.token,
      body: json({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'running-call', reason: 'no longer needed' },
      }),
    });
    assert.strictEqual(cancellation.statusCode, 202);

    const result = parseBody(await call);
    assert.deepStrictEqual(result.result.structuredContent, { cancelled: true });
    assert.strictEqual(observedReason, 'no longer needed');
  });

  it('scopes equal request ids and cancellation to one bridge client', async function () {
    const clients = {
      left: 'transport-left-client-0001',
      right: 'transport-right-client-001',
    };
    let announceBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { announceBothStarted = resolve; });
    const running = new Map<string, {
      signal: AbortSignal;
      finish: (value: { structuredContent: { client: string } }) => void;
    }>();
    const cancelled: Array<{ id: string | number; reason: string | undefined }> = [];
    const backend = baseBackend();
    backend.callTool = (_name, args, context) => new Promise((resolve) => {
      const client = String(args.client);
      running.set(client, { signal: context.signal, finish: resolve });
      context.signal.addEventListener('abort', () => {
        resolve({ structuredContent: { client } });
      }, { once: true });
      if (running.size === 2) {
        announceBothStarted();
      }
    });
    backend.onCancelled = (id, reason) => { cancelled.push({ id, reason }); };
    const server = await start({ backend });

    const leftCall = request(server, {
      token: server.token,
      clientId: clients.left,
      body: rpcRequest('same-id', 'tools/call', {
        name: 'echo',
        arguments: { client: 'left' },
      }),
    });
    const rightCall = request(server, {
      token: server.token,
      clientId: clients.right,
      body: rpcRequest('same-id', 'tools/call', {
        name: 'echo',
        arguments: { client: 'right' },
      }),
    });
    await bothStarted;

    const cancellation = await request(server, {
      token: server.token,
      clientId: clients.left,
      body: json({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'same-id', reason: 'left only' },
      }),
    });
    assert.strictEqual(cancellation.statusCode, 202);
    assert.strictEqual(running.get('left')?.signal.aborted, true);
    assert.strictEqual(running.get('right')?.signal.aborted, false);
    assert.deepStrictEqual(cancelled, [{ id: 'same-id', reason: 'left only' }]);

    running.get('right')?.finish({ structuredContent: { client: 'right' } });
    const [left, right] = await Promise.all([leftCall, rightCall]);
    assert.strictEqual(parseBody(left).result.structuredContent.client, 'left');
    assert.strictEqual(parseBody(right).result.structuredContent.client, 'right');
  });

  it('rejects a duplicate active request id from the same bridge client', async function () {
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let finish!: () => void;
    let calls = 0;
    const backend = baseBackend();
    backend.callTool = () => new Promise((resolve) => {
      calls += 1;
      finish = () => resolve({ structuredContent: { done: true } });
      announceStarted();
    });
    const server = await start({ backend });
    const body = rpcRequest('duplicate-id', 'tools/call', { name: 'echo' });

    const first = request(server, { token: server.token, body });
    await started;
    const duplicate = parseBody(await request(server, { token: server.token, body }));
    assert.strictEqual(duplicate.error.code, -32600);
    assert.match(duplicate.error.message, /already active/);
    assert.strictEqual(calls, 1);

    finish();
    assert.deepStrictEqual(parseBody(await first).result.structuredContent, { done: true });
  });
});
