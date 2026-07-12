import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'mocha';
import {
  MCP_DIAGNOSTIC_CODES,
  diagnoseMcpWorkspace,
} from '../../mcp/diagnostics';
import { setupMcpWorkspace } from '../../mcp/setup';
import {
  MCP_MANIFEST_SCHEMA_VERSION,
  McpWindowManifest,
} from '../../mcp/windowRegistry';

describe('Feature: MCP workspace diagnostics', function () {
  const temporaryPaths: string[] = [];

  afterEach(async function () {
    await Promise.all(temporaryPaths.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })));
  });

  async function temporaryDirectory(prefix = 'dpd-mcp-diagnostics-'): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryPaths.push(directory);
    return directory;
  }

  async function createExtensionRuntime(workspace: string): Promise<string> {
    const bridgePath = path.join(workspace, 'extension', 'out', 'mcp', 'stdioBridge.js');
    await fs.mkdir(path.dirname(bridgePath), { recursive: true });
    await fs.writeFile(
      bridgePath,
      "const registry = require('./windowRegistry');\nexports.main = async () => registry;\n",
    );
    await fs.writeFile(
      path.join(path.dirname(bridgePath), 'windowRegistry.js'),
      'exports.schemaVersion = 1;\n',
    );
    return bridgePath;
  }

  async function manifest(
    workspace: string,
    overrides: Partial<McpWindowManifest> = {},
  ): Promise<McpWindowManifest> {
    const now = Date.now();
    const canonicalWorkspace = await fs.realpath(workspace);
    return {
      schemaVersion: MCP_MANIFEST_SCHEMA_VERSION,
      windowId: 'window-diagnostics',
      extensionPid: process.pid,
      url: 'http://127.0.0.1:43210/mcp',
      token: 'diagnostics-secret-token',
      workspaceFolders: [{
        name: path.basename(workspace),
        uri: `file://${canonicalWorkspace}`,
        fsPath: canonicalWorkspace,
        canonicalPath: canonicalWorkspace,
      }],
      extensionVersion: '9.9.9',
      startedAt: new Date(now - 1_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + 30_000).toISOString(),
      ...overrides,
    };
  }

  async function writeManifest(
    registryDir: string,
    value: McpWindowManifest,
  ): Promise<void> {
    await fs.mkdir(registryDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(registryDir, 0o700);
    }
    await fs.writeFile(
      path.join(registryDir, `${value.windowId}.json`),
      JSON.stringify(value),
      { encoding: 'utf8', mode: 0o600 },
    );
    if (process.platform !== 'win32') {
      await fs.chmod(path.join(registryDir, `${value.windowId}.json`), 0o600);
    }
  }

  async function installFixture(): Promise<{
    workspace: string;
    workspaceRoot: string;
    bridgeModulePath: string;
    registryDir: string;
  }> {
    const workspace = await temporaryDirectory();
    const bridgeModulePath = await createExtensionRuntime(workspace);
    await setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath });
    const registryDir = path.join(workspace, 'window-registry');
    await writeManifest(registryDir, await manifest(workspace));
    return { workspace, workspaceRoot: workspace, bridgeModulePath, registryDir };
  }

  function issueCodes(result: Awaited<ReturnType<typeof diagnoseMcpWorkspace>>): string[] {
    return result.issues.map((issue) => issue.code);
  }

  it('verifies current configs, copied runtime hashes, and a healthy live window', async function () {
    const fixture = await installFixture();
    const result = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => true,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.repairNeeded, false);
    assert.deepStrictEqual(result.issues, []);
    assert.strictEqual(result.configs.claude.state, 'current');
    assert.strictEqual(result.configs.codex.state, 'current');
    assert.strictEqual(result.launcher.state, 'regular');
    assert.strictEqual(result.runtime.current, true);
    assert.strictEqual(result.runtime.bridge.byteEqual, true);
    assert.match(result.runtime.bridge.source.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.strictEqual(result.runtime.bridge.source.sha256, result.runtime.bridge.copy.sha256);
    assert.strictEqual(result.liveWindow.state, 'healthy');
    assert.strictEqual(result.liveWindow.manifest?.windowId, 'window-diagnostics');
    assert.ok(!JSON.stringify(result).includes('diagnostics-secret-token'));
    assert.ok(!Object.prototype.hasOwnProperty.call(result.liveWindow.manifest ?? {}, 'token'));
  });

  it('reports every missing workspace installation component as repair-needed', async function () {
    const workspace = await temporaryDirectory();
    const bridgeModulePath = await createExtensionRuntime(workspace);
    const registryDir = path.join(workspace, 'missing-registry');
    const result = await diagnoseMcpWorkspace({
      workspaceRoot: workspace,
      bridgeModulePath,
      registryDir,
      env: {},
      healthCheck: async () => true,
    });

    const codes = issueCodes(result);
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.repairNeeded, true);
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.CLAUDE_CONFIG_MISSING));
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.CODEX_CONFIG_MISSING));
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.LAUNCHER_MISSING));
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_MISSING));
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.RUNTIME_REGISTRY_MISSING));
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_NOT_FOUND));
  });

  it('detects copied runtime drift by both bytes and hashes', async function () {
    const fixture = await installFixture();
    await fs.appendFile(fixture.bridgeModulePath, '// extension updated\n');
    const result = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => true,
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.runtime.current, false);
    assert.strictEqual(result.runtime.bridge.current, false);
    assert.strictEqual(result.runtime.bridge.byteEqual, false);
    assert.notStrictEqual(
      result.runtime.bridge.source.sha256,
      result.runtime.bridge.copy.sha256,
    );
    assert.strictEqual(result.repairNeeded, true);
    assert.ok(issueCodes(result).includes(MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_STALE));
  });

  it('detects a regular but modified project launcher', async function () {
    const fixture = await installFixture();
    const initial = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => true,
    });
    await fs.writeFile(
      initial.paths.launcher,
      '#!/usr/bin/env node\nprocess.stdout.write("forged\\n");\n',
      { mode: 0o700 },
    );
    const result = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => true,
    });
    assert.strictEqual(result.launcher.state, 'regular');
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.repairNeeded, true);
    assert.ok(issueCodes(result).includes(MCP_DIAGNOSTIC_CODES.LAUNCHER_STALE));
  });

  it('fails closed for symbolic-link launcher and runtime artifacts', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const fixture = await installFixture();
    const first = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => true,
    });
    const launcherTarget = path.join(fixture.workspace, 'launcher-target.js');
    await fs.writeFile(launcherTarget, '#!/usr/bin/env node\n');
    await fs.unlink(first.paths.launcher);
    await fs.symlink(launcherTarget, first.paths.launcher);
    const runtimeDirectory = path.dirname(first.paths.runtimeBridge);
    const runtimeTarget = path.join(fixture.workspace, 'runtime-target');
    await fs.rename(runtimeDirectory, runtimeTarget);
    await fs.symlink(runtimeTarget, runtimeDirectory, 'dir');

    const result = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => true,
    });
    const codes = issueCodes(result);
    assert.strictEqual(result.launcher.state, 'symlink');
    assert.strictEqual(result.runtime.bridge.copy.state, 'symlink');
    assert.strictEqual(result.runtime.registry.copy.state, 'symlink');
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.repairNeeded, true);
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.LAUNCHER_SYMLINK));
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.RUNTIME_BRIDGE_SYMLINK));
    assert.ok(codes.includes(MCP_DIAGNOSTIC_CODES.RUNTIME_REGISTRY_SYMLINK));
    assert.strictEqual(
      result.issues.find((issue) => issue.code === MCP_DIAGNOSTIC_CODES.LAUNCHER_SYMLINK)?.repairable,
      false,
    );
  });

  it('distinguishes stale and structurally invalid client configuration', async function () {
    const fixture = await installFixture();
    const initial = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => true,
    });
    const claude = JSON.parse(await fs.readFile(initial.paths.claudeConfig, 'utf8'));
    claude.mcpServers.djangoDebugger.args = ['obsolete-launcher'];
    await fs.writeFile(initial.paths.claudeConfig, JSON.stringify(claude));
    await fs.writeFile(
      initial.paths.codexConfig,
      'mcp_servers = { djangoDebugger = { command = "old" } }\n',
    );

    const result = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => true,
    });
    assert.strictEqual(result.configs.claude.state, 'stale');
    assert.strictEqual(result.configs.claude.entryPresent, true);
    assert.strictEqual(result.configs.codex.state, 'invalid');
    assert.strictEqual(result.configs.codex.entryPresent, false);
    assert.ok(issueCodes(result).includes(MCP_DIAGNOSTIC_CODES.CLAUDE_SERVER_STALE));
    assert.ok(issueCodes(result).includes(MCP_DIAGNOSTIC_CODES.CODEX_CONFIG_INVALID));
    assert.strictEqual(result.repairNeeded, true);
  });

  it('reports manifest health failure without requesting workspace repair', async function () {
    const fixture = await installFixture();
    const result = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => false,
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.runtime.current, true);
    assert.strictEqual(result.liveWindow.state, 'unhealthy');
    assert.strictEqual(result.liveWindow.healthChecks, 1);
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.repairNeeded, false);
    assert.deepStrictEqual(issueCodes(result), [MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_UNHEALTHY]);
  });

  it('reports an unsafe live-window registry without exposing its manifests', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const fixture = await installFixture();
    await fs.chmod(fixture.registryDir, 0o755);
    let healthCalled = false;
    const result = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      healthCheck: async () => {
        healthCalled = true;
        return true;
      },
    });

    assert.strictEqual(result.liveWindow.state, 'error');
    assert.strictEqual(result.liveWindow.healthChecks, 0);
    assert.strictEqual(healthCalled, false);
    assert.strictEqual(result.repairNeeded, false);
    assert.ok(issueCodes(result).includes(MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_REGISTRY_UNSAFE));
    assert.ok(!JSON.stringify(result).includes('diagnostics-secret-token'));
  });

  it('reports multiple healthy workspace windows as ambiguous', async function () {
    const fixture = await installFixture();
    await writeManifest(
      fixture.registryDir,
      await manifest(fixture.workspace, { windowId: 'window-diagnostics-2' }),
    );
    const result = await diagnoseMcpWorkspace({
      ...fixture,
      env: {},
      parentPid: process.pid + 100_000,
      healthCheck: async () => true,
    });

    assert.strictEqual(result.liveWindow.state, 'ambiguous');
    assert.strictEqual(result.liveWindow.healthChecks, 2);
    assert.strictEqual(result.liveWindow.healthyCandidates, 2);
    assert.strictEqual(result.repairNeeded, false);
    assert.ok(issueCodes(result).includes(MCP_DIAGNOSTIC_CODES.LIVE_WINDOW_AMBIGUOUS));
  });
});
