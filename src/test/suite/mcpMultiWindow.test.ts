import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { afterEach, describe, it } from 'mocha';
import {
  McpWindowIdCollisionError,
  publishMcpWindowManifest,
} from '../../mcp/windowRegistry';
import {
  McpBridgeError,
  McpStdioBridge,
  canonicalWorkspacePath,
  discoverMcpWindow,
} from '../../mcp/stdioBridge';
import {
  McpTransportBackend,
  McpToolDefinition,
} from '../../mcp/transport';
import {
  McpWindowHostOptions,
  StartedMcpWindowHost,
  startMcpWindowHost,
} from '../../mcp/windowHost';

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

  jsonLines(): Array<Record<string, any>> {
    return this.chunks.join('').trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  }
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

function markerTool(marker: string): McpToolDefinition {
  return {
    name: `marker_${marker}`,
    description: `Marker for ${marker}`,
    inputSchema: EMPTY_SCHEMA,
  };
}

describe('Feature: MCP multi-window isolation', function () {
  const roots: string[] = [];
  const hosts: StartedMcpWindowHost[] = [];

  afterEach(async function () {
    await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
    await Promise.all(roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })));
  });

  async function temporaryRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-multi-window-'));
    roots.push(root);
    return root;
  }

  async function startHost(
    input: {
      windowId: string;
      extensionPid?: number;
      workspace: string;
      registryDir: string;
      backend?: McpTransportBackend;
      marker?: string;
    },
  ): Promise<StartedMcpWindowHost> {
    const marker = input.marker ?? input.windowId;
    const options: McpWindowHostOptions = {
      windowId: input.windowId,
      extensionPid: input.extensionPid ?? process.pid,
      extensionVersion: 'multi-window-test',
      workspaceFolders: [{
        name: path.basename(input.workspace),
        uri: `file://${input.workspace}`,
        fsPath: input.workspace,
        canonicalPath: await canonicalWorkspacePath(input.workspace),
      }],
      registryDir: input.registryDir,
      backend: input.backend ?? {
        listTools: () => [markerTool(marker)],
        callTool: () => ({ structuredContent: { marker } }),
      },
    };
    const host = await startMcpWindowHost(options);
    hosts.push(host);
    return host;
  }

  it('routes two different workspace roots to two real loopback window hosts', async function () {
    const root = await temporaryRoot();
    const registryDir = path.join(root, 'registry');
    const workspaceA = path.join(root, 'project-a');
    const workspaceB = path.join(root, 'project-b');
    await Promise.all([fs.mkdir(workspaceA), fs.mkdir(workspaceB)]);
    await startHost({ windowId: 'window-a', workspace: workspaceA, registryDir, marker: 'a' });
    await startHost({ windowId: 'window-b', workspace: workspaceB, registryDir, marker: 'b' });

    const outputA = new CaptureWriter();
    const outputB = new CaptureWriter();
    const bridgeA = new McpStdioBridge({
      workspacePath: workspaceA,
      registryDir,
      connectTimeoutMs: 0,
      output: outputA,
      errorOutput: new CaptureWriter(),
      clientId: 'multi-window-client-a-0001',
    });
    const bridgeB = new McpStdioBridge({
      workspacePath: workspaceB,
      registryDir,
      connectTimeoutMs: 0,
      output: outputB,
      errorOutput: new CaptureWriter(),
      clientId: 'multi-window-client-b-0001',
    });
    await Promise.all([
      bridgeA.forwardLine('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'),
      bridgeB.forwardLine('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'),
    ]);

    assert.strictEqual(outputA.jsonLines()[0].result.tools[0].name, 'marker_a');
    assert.strictEqual(outputB.jsonLines()[0].result.tools[0].name, 'marker_b');
  });

  it('fails closed for duplicate workspace windows and applies explicit, env, then parent ownership', async function () {
    const root = await temporaryRoot();
    const registryDir = path.join(root, 'registry');
    const workspace = path.join(root, 'same-project');
    await fs.mkdir(workspace);
    await startHost({
      windowId: 'same-window-a',
      extensionPid: 51_001,
      workspace,
      registryDir,
    });
    await startHost({
      windowId: 'same-window-b',
      extensionPid: 51_002,
      workspace,
      registryDir,
    });
    const common = {
      workspacePath: workspace,
      registryDir,
      isProcessAlive: () => true,
    };

    await assert.rejects(
      discoverMcpWindow({ ...common, parentPid: 0 }),
      (error: unknown) => error instanceof McpBridgeError
        && error.code === 'AMBIGUOUS_WINDOW',
    );
    assert.strictEqual((await discoverMcpWindow({
      ...common,
      windowId: 'same-window-a',
      env: { DJANGO_PROCESS_DEBUGGER_WINDOW_ID: 'same-window-b' },
      parentPid: 51_002,
    })).windowId, 'same-window-a');
    assert.strictEqual((await discoverMcpWindow({
      ...common,
      env: { DJANGO_PROCESS_DEBUGGER_WINDOW_ID: 'same-window-b' },
      parentPid: 51_001,
    })).windowId, 'same-window-b');
    assert.strictEqual((await discoverMcpWindow({
      ...common,
      parentPid: 51_001,
    })).windowId, 'same-window-a');

    await assert.rejects(
      discoverMcpWindow({
        ...common,
        windowId: 'explicit-id-does-not-exist',
        parentPid: 51_001,
      }),
      (error: unknown) => error instanceof McpBridgeError
        && error.code === 'WINDOW_NOT_FOUND',
    );
  });

  it('rediscovers a reloaded host when a terminal retains the stale environment window id', async function () {
    const root = await temporaryRoot();
    const registryDir = path.join(root, 'registry');
    const workspace = path.join(root, 'reload-project');
    await fs.mkdir(workspace);
    const oldHost = await startHost({
      windowId: 'before-reload',
      workspace,
      registryDir,
      marker: 'old',
    });
    const output = new CaptureWriter();
    const errors = new CaptureWriter();
    const bridge = new McpStdioBridge({
      workspacePath: workspace,
      registryDir,
      env: { DJANGO_PROCESS_DEBUGGER_WINDOW_ID: 'before-reload' },
      connectTimeoutMs: 0,
      output,
      errorOutput: errors,
      clientId: 'reload-persistent-client-01',
    });
    await bridge.forwardLine('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');

    await oldHost.dispose();
    await startHost({
      windowId: 'after-reload',
      workspace,
      registryDir,
      marker: 'new',
    });
    await bridge.forwardLine('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}');

    const responses = output.jsonLines();
    assert.strictEqual(responses[0].result.tools[0].name, 'marker_old');
    assert.strictEqual(responses[1].result.tools[0].name, 'marker_new');
    assert.match(errors.chunks.join(''), /rediscovering once/);
  });

  it('isolates equal request ids and cancellation across two simultaneous stdio clients', async function () {
    const root = await temporaryRoot();
    const registryDir = path.join(root, 'registry');
    const workspace = path.join(root, 'shared-client-project');
    await fs.mkdir(workspace);
    let announceBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { announceBothStarted = resolve; });
    const running = new Map<string, {
      signal: AbortSignal;
      finish: () => void;
    }>();
    const cancelled: Array<{ id: string | number; reason: string | undefined }> = [];
    const backend: McpTransportBackend = {
      listTools: () => [markerTool('shared')],
      callTool: (_name, args, context) => new Promise((resolve) => {
        const client = String(args.client);
        const finish = (): void => resolve({ structuredContent: { client, cancelled: false } });
        running.set(client, { signal: context.signal, finish });
        context.signal.addEventListener('abort', () => {
          resolve({ structuredContent: { client, cancelled: true } });
        }, { once: true });
        if (running.size === 2) {
          announceBothStarted();
        }
      }),
      onCancelled: (id, reason) => { cancelled.push({ id, reason }); },
    };
    await startHost({ windowId: 'shared-window', workspace, registryDir, backend });
    const claudeOutput = new CaptureWriter();
    const codexOutput = new CaptureWriter();
    const claude = new McpStdioBridge({
      workspacePath: workspace,
      registryDir,
      connectTimeoutMs: 0,
      output: claudeOutput,
      errorOutput: new CaptureWriter(),
      clientId: 'claude-bridge-client-0001',
    });
    const codex = new McpStdioBridge({
      workspacePath: workspace,
      registryDir,
      connectTimeoutMs: 0,
      output: codexOutput,
      errorOutput: new CaptureWriter(),
      clientId: 'codex-bridge-client-00001',
    });
    const call = (client: string): string => JSON.stringify({
      jsonrpc: '2.0',
      id: 'same-request-id',
      method: 'tools/call',
      params: { name: 'marker_shared', arguments: { client } },
    });
    const claudeCall = claude.forwardLine(call('claude'));
    const codexCall = codex.forwardLine(call('codex'));
    await bothStarted;

    await claude.forwardLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'same-request-id', reason: 'claude cancelled' },
    }));
    assert.strictEqual(running.get('claude')?.signal.aborted, true);
    assert.strictEqual(running.get('codex')?.signal.aborted, false);
    running.get('codex')?.finish();
    await Promise.all([claudeCall, codexCall]);

    assert.deepStrictEqual(cancelled, [{
      id: 'same-request-id',
      reason: 'claude cancelled',
    }]);
    assert.deepStrictEqual(claudeOutput.jsonLines()[0].result.structuredContent, {
      client: 'claude',
      cancelled: true,
    });
    assert.deepStrictEqual(codexOutput.jsonLines()[0].result.structuredContent, {
      client: 'codex',
      cancelled: false,
    });
  });

  it('never lets a second publisher overwrite an already claimed window id', async function () {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'collision-project');
    const registryDir = path.join(root, 'registry');
    await fs.mkdir(workspace);
    const folder = {
      name: 'collision-project',
      uri: `file://${workspace}`,
      fsPath: workspace,
      canonicalPath: await canonicalWorkspacePath(workspace),
    };
    const first = await publishMcpWindowManifest({
      windowId: 'colliding-window-id',
      extensionPid: process.pid,
      url: 'http://127.0.0.1:41001/mcp',
      token: 'first-owner-token',
      workspaceFolders: [folder],
      extensionVersion: 'first',
    }, {
      registryDir,
      heartbeatMs: 60_000,
      leaseMs: 120_000,
    });
    try {
      await assert.rejects(
        publishMcpWindowManifest({
          windowId: 'colliding-window-id',
          extensionPid: process.pid,
          url: 'http://127.0.0.1:41002/mcp',
          token: 'second-owner-token',
          workspaceFolders: [folder],
          extensionVersion: 'second',
        }, {
          registryDir,
          heartbeatMs: 60_000,
          leaseMs: 120_000,
        }),
        (error: unknown) => error instanceof McpWindowIdCollisionError
          && error.code === 'WINDOW_ID_COLLISION',
      );
      const manifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf-8')) as {
        token: string;
        extensionVersion: string;
      };
      assert.strictEqual(manifest.token, 'first-owner-token');
      assert.strictEqual(manifest.extensionVersion, 'first');
    } finally {
      await first.dispose();
    }
  });

  it('never lets an old heartbeat overwrite a manifest replaced by another owner', async function () {
    const root = await temporaryRoot();
    const registryDir = path.join(root, 'registry');
    const first = await publishMcpWindowManifest({
      windowId: 'heartbeat-owner-collision',
      extensionPid: process.pid,
      url: 'http://127.0.0.1:41003/mcp',
      token: 'original-heartbeat-owner',
      workspaceFolders: [],
      extensionVersion: 'original',
    }, {
      registryDir,
      heartbeatMs: 20,
      leaseMs: 100,
    });
    try {
      const replacement = {
        schemaVersion: 'django-process-debugger.mcp/1',
        windowId: 'heartbeat-owner-collision',
        extensionPid: process.pid + 1,
        url: 'http://127.0.0.1:41004/mcp',
        token: 'replacement-heartbeat-owner',
        workspaceFolders: [],
        extensionVersion: 'replacement',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      await fs.writeFile(first.manifestPath, JSON.stringify(replacement), 'utf-8');
      await new Promise((resolve) => setTimeout(resolve, 55));
      const current = JSON.parse(await fs.readFile(first.manifestPath, 'utf-8')) as {
        token: string;
        extensionVersion: string;
      };
      assert.strictEqual(current.token, 'replacement-heartbeat-owner');
      assert.strictEqual(current.extensionVersion, 'replacement');
    } finally {
      await first.dispose();
    }
  });
});
