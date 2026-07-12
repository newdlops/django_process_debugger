import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'mocha';
import { setupMcpWorkspace } from '../../mcp/setup';
import { verifyMcpWorkspace, McpVerificationError } from '../../mcp/verification';
import { startMcpWindowHost, StartedMcpWindowHost } from '../../mcp/windowHost';

describe('Feature: installed MCP end-to-end verification', function () {
  const roots: string[] = [];
  const hosts: StartedMcpWindowHost[] = [];

  afterEach(async function () {
    await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
    await Promise.all(roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })));
  });

  async function temporaryRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-mcp-verify-'));
    roots.push(root);
    return root;
  }

  it('executes the copied launcher through stdio and calls the live status tool', async function () {
    const workspace = await temporaryRoot();
    const registryDir = path.join(workspace, 'registry');
    const bridgeModulePath = path.resolve(__dirname, '../../mcp/stdioBridge.js');
    const setup = await setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath });
    const host = await startMcpWindowHost({
      windowId: 'verify-live-window',
      extensionPid: process.pid,
      extensionVersion: 'verification-test',
      workspaceFolders: [{
        name: 'verify-project',
        uri: `file://${workspace}`,
        fsPath: workspace,
        canonicalPath: await fs.realpath(workspace),
      }],
      registryDir,
      backend: {
        listTools: () => [{
          name: 'django_debugger_status',
          description: 'test status',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
        callTool: () => ({
          structuredContent: { ok: true, windowId: 'verify-live-window' },
        }),
      },
    });
    hosts.push(host);

    const result = await verifyMcpWorkspace({
      workspaceRoot: workspace,
      launcherPath: setup.launcherPath,
      nodeCommand: process.execPath,
      windowId: 'verify-live-window',
      registryDir,
      timeoutMs: 8_000,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.serverInfo.name, 'django-process-debugger');
    assert.ok(result.toolNames.includes('django_debugger_status'));
    assert.deepStrictEqual(result.status, { ok: true, windowId: 'verify-live-window' });
  });

  it('refuses a launcher symlink even when its target stays inside the workspace', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const workspace = await temporaryRoot();
    const target = path.join(workspace, 'launcher-target.js');
    const launcher = path.join(workspace, 'launcher-link.js');
    await fs.writeFile(target, 'process.exit(0);\n');
    await fs.symlink(target, launcher);

    await assert.rejects(
      verifyMcpWorkspace({
        workspaceRoot: workspace,
        launcherPath: launcher,
        nodeCommand: process.execPath,
        timeoutMs: 1_000,
      }),
      (error: unknown) => error instanceof McpVerificationError
        && error.code === 'UNSAFE_LAUNCHER',
    );
  });

  it('refuses a modified regular launcher before executing it', async function () {
    const workspace = await temporaryRoot();
    const bridgeModulePath = path.resolve(__dirname, '../../mcp/stdioBridge.js');
    const setup = await setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath });
    await fs.writeFile(
      setup.launcherPath,
      '#!/usr/bin/env node\nrequire("fs").writeFileSync("forged-marker", "ran");\n',
      { mode: 0o700 },
    );

    await assert.rejects(
      verifyMcpWorkspace({
        workspaceRoot: workspace,
        launcherPath: setup.launcherPath,
        nodeCommand: process.execPath,
        timeoutMs: 1_000,
      }),
      (error: unknown) => error instanceof McpVerificationError
        && error.code === 'UNSAFE_LAUNCHER',
    );
    await assert.rejects(fs.stat(path.join(workspace, 'forged-marker')), { code: 'ENOENT' });
  });

  it('refuses a modified copied runtime and executes only trusted runtime bytes', async function () {
    const workspace = await temporaryRoot();
    const bridgeModulePath = path.resolve(__dirname, '../../mcp/stdioBridge.js');
    const setup = await setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath });
    await fs.appendFile(setup.runtimeBridgePath, '\nprocess.exit(99);\n');

    await assert.rejects(
      verifyMcpWorkspace({
        workspaceRoot: workspace,
        launcherPath: setup.launcherPath,
        nodeCommand: process.execPath,
        timeoutMs: 1_000,
      }),
      (error: unknown) => error instanceof McpVerificationError
        && error.code === 'UNSAFE_RUNTIME',
    );
  });
});
