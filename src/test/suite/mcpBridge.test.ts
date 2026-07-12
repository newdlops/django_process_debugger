import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { afterEach, describe, it } from 'mocha';
import {
  MCP_MANIFEST_SCHEMA_VERSION,
  McpWindowManifest,
} from '../../mcp/windowRegistry';
import {
  MCP_BRIDGE_CLIENT_ID_HEADER,
  McpBridgeError,
  McpStdioBridge,
  canonicalWorkspacePath,
  checkMcpWindowHealth,
  discoverMcpWindow,
  parseMcpWindowManifest,
  parseStdioCli,
} from '../../mcp/stdioBridge';
import { StartedMcpTransport, startMcpTransport } from '../../mcp/transport';

class CaptureWriter extends Writable {
  readonly chunks: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

describe('Feature: MCP stdio bridge', function () {
  const temporaryPaths: string[] = [];
  const servers: http.Server[] = [];
  const transports: StartedMcpTransport[] = [];

  afterEach(async function () {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    await Promise.all(transports.splice(0).map((transport) => transport.dispose()));
    await Promise.all(temporaryPaths.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })));
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'django-mcp-bridge-test-'));
    temporaryPaths.push(directory);
    return directory;
  }

  async function manifest(
    workspace: string,
    overrides: Partial<McpWindowManifest> = {},
  ): Promise<McpWindowManifest> {
    const now = Date.now();
    return {
      schemaVersion: MCP_MANIFEST_SCHEMA_VERSION,
      windowId: 'window-a',
      extensionPid: process.pid,
      url: 'http://127.0.0.1:43210/mcp',
      token: 'secret-token',
      workspaceFolders: [{
        name: path.basename(workspace),
        uri: `file://${workspace}`,
        fsPath: workspace,
        canonicalPath: await canonicalWorkspacePath(workspace),
      }],
      extensionVersion: '1.0.0',
      startedAt: new Date(now - 1_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + 30_000).toISOString(),
      ...overrides,
    };
  }

  async function writeManifest(directory: string, value: McpWindowManifest): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(directory, 0o700);
    }
    await fs.writeFile(
      path.join(directory, `${value.windowId}.json`),
      JSON.stringify(value),
      { encoding: 'utf8', mode: 0o600 },
    );
    if (process.platform !== 'win32') {
      await fs.chmod(path.join(directory, `${value.windowId}.json`), 0o600);
    }
  }

  it('strictly parses manifests and rejects non-loopback endpoints', async function () {
    const workspace = await temporaryDirectory();
    const valid = await manifest(workspace);
    assert.deepStrictEqual(parseMcpWindowManifest(valid), valid);
    assert.strictEqual(parseMcpWindowManifest({ ...valid, token: '' }), null);
    assert.strictEqual(parseMcpWindowManifest({ ...valid, url: 'https://127.0.0.1/mcp' }), null);
    assert.strictEqual(parseMcpWindowManifest({ ...valid, url: 'http://example.com/mcp' }), null);
    assert.strictEqual(parseMcpWindowManifest({ ...valid, schemaVersion: 'old' }), null);
  });

  it('matches a real canonical root when the CLI path is a symlink', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const parent = await temporaryDirectory();
    const workspace = path.join(parent, 'workspace');
    const alias = path.join(parent, 'alias');
    const registry = path.join(parent, 'registry');
    await fs.mkdir(workspace);
    await fs.symlink(workspace, alias);
    const value = await manifest(workspace);
    await writeManifest(registry, value);

    const selected = await discoverMcpWindow({
      workspacePath: alias,
      registryDir: registry,
      healthCheck: async () => true,
    });
    assert.strictEqual(selected.windowId, value.windowId);
  });

  it('fails closed for insecure registry permissions and manifest symlinks', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const workspace = await temporaryDirectory();
    const registry = path.join(workspace, 'registry');
    const value = await manifest(workspace);
    await writeManifest(registry, value);
    await fs.chmod(registry, 0o755);

    await assert.rejects(
      discoverMcpWindow({
        workspacePath: workspace,
        registryDir: registry,
        healthCheck: async () => true,
      }),
      (error: unknown) => error instanceof McpBridgeError
        && error.code === 'UNSAFE_REGISTRY'
        && error.message.includes('mode must be 0700'),
    );

    await fs.chmod(registry, 0o700);
    const manifestPath = path.join(registry, `${value.windowId}.json`);
    const targetPath = path.join(workspace, 'manifest-target.json');
    await fs.rename(manifestPath, targetPath);
    await fs.symlink(targetPath, manifestPath);
    await assert.rejects(
      discoverMcpWindow({
        workspacePath: workspace,
        registryDir: registry,
        healthCheck: async () => true,
      }),
      (error: unknown) => error instanceof McpBridgeError
        && error.code === 'UNSAFE_REGISTRY'
        && error.message.includes('symbolic link'),
    );

    await fs.unlink(manifestPath);
    await fs.rename(targetPath, manifestPath);
    await fs.chmod(manifestPath, 0o644);
    await assert.rejects(
      discoverMcpWindow({
        workspacePath: workspace,
        registryDir: registry,
        healthCheck: async () => true,
      }),
      (error: unknown) => error instanceof McpBridgeError
        && error.code === 'UNSAFE_REGISTRY'
        && error.message.includes('mode must be 0600'),
    );
  });

  it('fails closed for duplicate live windows and honors explicit/env selection', async function () {
    const workspace = await temporaryDirectory();
    const registry = path.join(workspace, 'registry');
    await writeManifest(registry, await manifest(workspace, { windowId: 'window-a' }));
    await writeManifest(registry, await manifest(workspace, { windowId: 'window-b' }));

    await assert.rejects(
      discoverMcpWindow({
        workspacePath: workspace,
        registryDir: registry,
        healthCheck: async () => true,
      }),
      (error: unknown) => error instanceof McpBridgeError
        && error.code === 'AMBIGUOUS_WINDOW'
        && error.message.includes('--window-id'),
    );
    const fromEnv = await discoverMcpWindow({
      workspacePath: workspace,
      registryDir: registry,
      env: { DJANGO_PROCESS_DEBUGGER_WINDOW_ID: 'window-b' },
      healthCheck: async () => true,
    });
    assert.strictEqual(fromEnv.windowId, 'window-b');
    const explicitWins = await discoverMcpWindow({
      workspacePath: workspace,
      registryDir: registry,
      windowId: 'window-a',
      env: { DJANGO_PROCESS_DEBUGGER_WINDOW_ID: 'window-b' },
      healthCheck: async () => true,
    });
    assert.strictEqual(explicitWins.windowId, 'window-a');
  });

  it('recovers a stale window id only through an unambiguous workspace owner', async function () {
    const workspace = await temporaryDirectory();
    const registry = path.join(workspace, 'registry');
    await writeManifest(registry, await manifest(workspace, {
      windowId: 'window-a',
      extensionPid: 41_001,
    }));
    await writeManifest(registry, await manifest(workspace, {
      windowId: 'window-b',
      extensionPid: 41_002,
    }));
    const common = {
      workspacePath: workspace,
      registryDir: registry,
      env: { DJANGO_PROCESS_DEBUGGER_WINDOW_ID: 'stale-after-reload' },
      isProcessAlive: () => true,
    };

    const uniqueWorkspaceOwner = await discoverMcpWindow({
      ...common,
      healthCheck: async (candidate) => candidate.windowId === 'window-a',
    });
    assert.strictEqual(uniqueWorkspaceOwner.windowId, 'window-a');

    const parentOwned = await discoverMcpWindow({
      ...common,
      parentPid: 41_002,
      healthCheck: async () => true,
    });
    assert.strictEqual(parentOwned.windowId, 'window-b');

    const validExplicitStillWins = await discoverMcpWindow({
      ...common,
      windowId: 'window-a',
      parentPid: 41_002,
      healthCheck: async () => true,
    });
    assert.strictEqual(validExplicitStillWins.windowId, 'window-a');

    await assert.rejects(
      discoverMcpWindow({
        ...common,
        parentPid: 99_999,
        healthCheck: async () => true,
      }),
      (error: unknown) => error instanceof McpBridgeError
        && error.code === 'AMBIGUOUS_WINDOW',
    );
  });

  it('ignores expired leases and dead extension processes', async function () {
    const workspace = await temporaryDirectory();
    const registry = path.join(workspace, 'registry');
    await writeManifest(registry, await manifest(workspace, {
      leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
    }));
    await assert.rejects(
      discoverMcpWindow({
        workspacePath: workspace,
        registryDir: registry,
        healthCheck: async () => true,
      }),
      (error: unknown) => error instanceof McpBridgeError && error.code === 'NO_LIVE_WINDOW',
    );

    await writeManifest(registry, await manifest(workspace));
    await assert.rejects(
      discoverMcpWindow({
        workspacePath: workspace,
        registryDir: registry,
        isProcessAlive: () => false,
        healthCheck: async () => true,
      }),
      (error: unknown) => error instanceof McpBridgeError && error.code === 'NO_LIVE_WINDOW',
    );
  });

  it('authenticates health and verifies the responding window id', async function () {
    const workspace = await temporaryDirectory();
    let authorization: string | undefined;
    const server = http.createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ windowId: 'window-a' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const value = await manifest(workspace, { url: `http://127.0.0.1:${address.port}/mcp` });

    assert.strictEqual(await checkMcpWindowHealth(value), true);
    assert.strictEqual(authorization, 'Bearer secret-token');
    assert.strictEqual(await checkMcpWindowHealth({ ...value, windowId: 'another-window' }), false);
  });

  it('forwards requests concurrently and keeps stdout JSON-only', async function () {
    const workspace = await temporaryDirectory();
    const value = await manifest(workspace);
    const output = new CaptureWriter();
    const errors = new CaptureWriter();
    const clientIds: string[] = [];
    const bridge = new McpStdioBridge({
      workspacePath: workspace,
      connectTimeoutMs: 0,
      input: Readable.from([]),
      output,
      errorOutput: errors,
      discover: async () => value,
      post: async (_manifest, body, headers) => {
        clientIds.push(headers[MCP_BRIDGE_CLIENT_ID_HEADER]);
        const request = JSON.parse(body) as { id: number };
        if (request.id === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.id }),
        };
      },
    });
    await bridge.connect();
    await Promise.all([
      bridge.forwardLine('{"jsonrpc":"2.0","id":1,"method":"slow"}'),
      bridge.forwardLine('{"jsonrpc":"2.0","id":2,"method":"fast"}'),
    ]);
    const responses = output.text().trim().split('\n').map((line) => JSON.parse(line));
    assert.deepStrictEqual(responses.map((response) => response.id), [2, 1]);
    assert.strictEqual(clientIds.length, 2);
    assert.match(clientIds[0], /^[A-Za-z0-9_-]{16,128}$/);
    assert.strictEqual(clientIds[1], clientIds[0]);
    assert.strictEqual(errors.text(), '');
  });

  it('preserves MCP session/protocol headers and rediscovers exactly once', async function () {
    const workspace = await temporaryDirectory();
    const value = await manifest(workspace);
    const output = new CaptureWriter();
    const errors = new CaptureWriter();
    let discoveries = 0;
    let posts = 0;
    const observedHeaders: Readonly<Record<string, string>>[] = [];
    const bridge = new McpStdioBridge({
      workspacePath: workspace,
      connectTimeoutMs: 0,
      input: Readable.from([]),
      output,
      errorOutput: errors,
      clientId: 'bridge-test-client-0001',
      discover: async () => {
        discoveries += 1;
        return value;
      },
      post: async (_manifest, body, headers) => {
        posts += 1;
        observedHeaders.push({ ...headers });
        const request = JSON.parse(body) as { id: number };
        if (request.id === 2 && posts === 2) {
          throw new McpBridgeError('HTTP_ERROR', 'stale endpoint');
        }
        return {
          statusCode: 200,
          headers: request.id === 1
            ? { 'content-type': 'application/json', 'mcp-session-id': 'session-1' }
            : { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }),
        };
      },
    });
    await bridge.connect();
    await bridge.forwardLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }));
    await bridge.forwardLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');

    assert.strictEqual(discoveries, 2);
    assert.strictEqual(posts, 3);
    assert.deepStrictEqual(observedHeaders[1], {
      [MCP_BRIDGE_CLIENT_ID_HEADER]: 'bridge-test-client-0001',
      'mcp-session-id': 'session-1',
      'mcp-protocol-version': '2025-11-25',
    });
    assert.deepStrictEqual(observedHeaders[2], observedHeaders[1]);
    assert.match(errors.text(), /rediscovering once/);
    assert.strictEqual(output.text().trim().split('\n').length, 2);
  });

  it('retries only explicitly read-safe debugger tools', async function () {
    const workspace = await temporaryDirectory();
    const value = await manifest(workspace);
    const output = new CaptureWriter();
    let discoveries = 0;
    let posts = 0;
    const bridge = new McpStdioBridge({
      workspacePath: workspace,
      connectTimeoutMs: 0,
      input: Readable.from([]),
      output,
      errorOutput: new CaptureWriter(),
      discover: async () => {
        discoveries += 1;
        return value;
      },
      post: async (_manifest, body) => {
        posts += 1;
        if (posts % 2 === 1) {
          throw new McpBridgeError('HTTP_ERROR', 'response lost');
        }
        const request = JSON.parse(body) as { id: number };
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }),
        };
      },
    });
    await bridge.connect();
    const safeTools = [
      'django_debugger_status',
      'django_targets_list',
      'django_execution_wait',
      'django_state_snapshot',
      'django_variables_expand',
    ];
    for (let index = 0; index < safeTools.length; index += 1) {
      await bridge.forwardLine(JSON.stringify({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/call',
        params: { name: safeTools[index], arguments: {} },
      }));
    }

    assert.strictEqual(posts, safeTools.length * 2);
    assert.strictEqual(discoveries, safeTools.length + 1);
    assert.strictEqual(output.text().trim().split('\n').length, safeTools.length);
  });

  it('never resends mutating requests or notifications after a transport failure', async function () {
    const workspace = await temporaryDirectory();
    const value = await manifest(workspace);
    const output = new CaptureWriter();
    const errors = new CaptureWriter();
    let discoveries = 0;
    let posts = 0;
    const bridge = new McpStdioBridge({
      workspacePath: workspace,
      connectTimeoutMs: 0,
      input: Readable.from([]),
      output,
      errorOutput: errors,
      discover: async () => {
        discoveries += 1;
        return value;
      },
      post: async () => {
        posts += 1;
        throw new McpBridgeError('HTTP_ERROR', 'response lost after delivery');
      },
    });
    await bridge.connect();
    const mutatingTools = [
      'django_session_start',
      'django_breakpoints_update',
      'django_execution_control',
    ];
    for (let index = 0; index < mutatingTools.length; index += 1) {
      await bridge.forwardLine(JSON.stringify({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/call',
        params: { name: mutatingTools[index], arguments: {} },
      }));
    }
    await bridge.forwardLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 99 },
    }));

    assert.strictEqual(posts, 4);
    assert.strictEqual(discoveries, 4);
    assert.strictEqual(output.text().trim().split('\n').length, 3);
    assert.strictEqual((errors.text().match(/invalidated without retry/g) ?? []).length, 4);
  });

  it('forwards an HTTP 400 JSON-RPC error without retrying the tool request', async function () {
    const workspace = await temporaryDirectory();
    const value = await manifest(workspace);
    const output = new CaptureWriter();
    let discoveries = 0;
    let posts = 0;
    const bridge = new McpStdioBridge({
      workspacePath: workspace,
      connectTimeoutMs: 0,
      input: Readable.from([]),
      output,
      errorOutput: new CaptureWriter(),
      discover: async () => {
        discoveries += 1;
        return value;
      },
      post: async () => {
        posts += 1;
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            error: { code: -32602, message: 'Invalid params' },
          }),
        };
      },
    });
    await bridge.connect();
    await bridge.forwardLine('{"jsonrpc":"2.0","id":7,"method":"tools/call"}');
    assert.strictEqual(discoveries, 1);
    assert.strictEqual(posts, 1);
    assert.deepStrictEqual(JSON.parse(output.text()), {
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32602, message: 'Invalid params' },
    });
  });

  it('connects end-to-end to the window-local Streamable HTTP transport', async function () {
    const workspace = await temporaryDirectory();
    const transport = await startMcpTransport({
      health: { windowId: 'window-a' },
      backend: {
        listTools: () => [{
          name: 'django_debugger_status',
          description: 'Read debugger status',
          inputSchema: { type: 'object', properties: {} },
        }],
        callTool: () => ({ structuredContent: { ok: true } }),
      },
    });
    transports.push(transport);
    const value = await manifest(workspace, {
      url: transport.url,
      token: transport.token,
    });
    const output = new CaptureWriter();
    const bridge = new McpStdioBridge({
      workspacePath: workspace,
      connectTimeoutMs: 0,
      input: Readable.from([]),
      output,
      errorOutput: new CaptureWriter(),
      discover: async () => value,
    });
    await bridge.connect();
    await bridge.forwardLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'bridge-test', version: '1.0.0' },
      },
    }));
    await bridge.forwardLine('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}');
    const responses = output.text().trim().split('\n').map((line) => JSON.parse(line));
    assert.strictEqual(responses[0].result.protocolVersion, '2025-11-25');
    assert.strictEqual(responses[1].result.tools[0].name, 'django_debugger_status');
  });

  it('polls during startup and parses the connect timeout CLI option', async function () {
    const workspace = await temporaryDirectory();
    const value = await manifest(workspace);
    let attempts = 0;
    const bridge = new McpStdioBridge({
      workspacePath: workspace,
      connectTimeoutMs: 500,
      input: Readable.from([]),
      output: new CaptureWriter(),
      errorOutput: new CaptureWriter(),
      discover: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new McpBridgeError('NO_LIVE_WINDOW', 'not yet');
        }
        return value;
      },
    });
    assert.strictEqual((await bridge.connect()).windowId, 'window-a');
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(
      parseStdioCli(['stdio', '--workspace=.', '--window-id', 'w', '--connect-timeout-ms', '123']),
      { workspacePath: '.', windowId: 'w', registryDir: undefined, connectTimeoutMs: 123 },
    );
  });
});
