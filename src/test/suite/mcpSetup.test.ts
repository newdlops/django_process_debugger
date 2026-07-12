import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { afterEach, describe, it } from 'mocha';
import {
  mergeClaudeMcpConfig,
  mergeCodexMcpConfig,
  setupMcpWorkspace,
} from '../../mcp/setup';

describe('Feature: MCP workspace setup', function () {
  const temporaryPaths: string[] = [];

  afterEach(async function () {
    await Promise.all(temporaryPaths.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })));
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'django-mcp-setup-test-'));
    temporaryPaths.push(directory);
    return directory;
  }

  async function createRuntimeSources(
    workspace: string,
    bridgeContents = 'exports.main = async () => {};\n',
  ): Promise<string> {
    const bridgeModulePath = path.join(workspace, 'extension', 'out', 'mcp', 'stdioBridge.js');
    await fs.mkdir(path.dirname(bridgeModulePath), { recursive: true });
    await fs.writeFile(bridgeModulePath, bridgeContents);
    await fs.writeFile(
      path.join(path.dirname(bridgeModulePath), 'windowRegistry.js'),
      'exports.runtimeMarker = "registry-copy";\n',
    );
    return bridgeModulePath;
  }

  async function runNode(
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`node exited with ${code}: ${stderr}`));
        }
      });
    });
  }

  const entry = {
    launcherArgument: '.django-process-debugger/mcp-stdio.js',
    nodeCommand: 'node',
  };

  it('merges Claude config without replacing unrelated top-level or server entries', function () {
    const original = JSON.stringify({
      custom: { retained: true },
      mcpServers: {
        other: { command: 'other-command', args: ['serve'] },
        djangoDebugger: { command: 'obsolete' },
      },
    });
    const merged = JSON.parse(mergeClaudeMcpConfig(original, entry));
    assert.deepStrictEqual(merged.custom, { retained: true });
    assert.deepStrictEqual(merged.mcpServers.other, {
      command: 'other-command',
      args: ['serve'],
    });
    assert.deepStrictEqual(merged.mcpServers.djangoDebugger, {
      type: 'stdio',
      command: 'node',
      args: [
        '-e',
        merged.mcpServers.djangoDebugger.args[1],
        'stdio',
        '--workspace',
        '.',
      ],
    });
    assert.match(merged.mcpServers.djangoDebugger.args[1], /CLAUDE_PROJECT_DIR/);
    assert.match(merged.mcpServers.djangoDebugger.args[1], /process\.cwd/);
    assert.match(merged.mcpServers.djangoDebugger.args[1], /\.django-process-debugger\/mcp-stdio\.js/);
  });

  it('merges only managed Codex keys and preserves other tables and custom keys', function () {
    const original = [
      '[mcp_servers.other]',
      'command = "other"',
      'enabled = false',
      '',
      '[mcp_servers.djangoDebugger]',
      'command = "old" # replace me',
      'args = [',
      '  "old-launcher.js",',
      '  "stdio",',
      ']',
      'env_vars = [',
      '  "OLD_WINDOW_ID",',
      '  "OLD_REGISTRY",',
      ']',
      'custom_setting = "keep"',
      'enabled = false',
      '',
      '[features]',
      'apps = true',
      '',
    ].join('\n');
    const merged = mergeCodexMcpConfig(original, entry);
    assert.match(merged, /\[mcp_servers\.other\]\ncommand = "other"\nenabled = false/);
    assert.match(merged, /custom_setting = "keep"/);
    assert.match(merged, /\[features\]\napps = true/);
    assert.match(merged, /\[mcp_servers\.djangoDebugger\]\ncommand = "node"/);
    assert.doesNotMatch(merged, /old-launcher/);
    assert.doesNotMatch(merged, /OLD_WINDOW_ID|OLD_REGISTRY/);
    assert.match(
      merged,
      /env_vars = \["DJANGO_PROCESS_DEBUGGER_WINDOW_ID", "DJANGO_PROCESS_DEBUGGER_MCP_REGISTRY_DIR"\]/,
    );
    assert.match(merged, /default_tools_approval_mode = "writes"/);
    assert.match(merged, /startup_timeout_sec = 15/);
    assert.match(merged, /enabled = true/);
    assert.strictEqual((merged.match(/\[mcp_servers\.djangoDebugger\]/g) ?? []).length, 1);
  });

  it('creates an idempotent local launcher plus Claude and Codex entries', async function () {
    const workspace = await temporaryDirectory();
    const bridgeModulePath = await createRuntimeSources(workspace);
    await fs.writeFile(
      path.join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { retained: { command: 'keep' } } }),
    );
    await fs.mkdir(path.join(workspace, '.codex'));
    await fs.writeFile(
      path.join(workspace, '.codex', 'config.toml'),
      '[mcp_servers.retained]\ncommand = "keep"\n',
    );

    const first = await setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath });
    const firstLauncher = await fs.readFile(first.launcherPath, 'utf8');
    await setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath });
    const secondLauncher = await fs.readFile(first.launcherPath, 'utf8');
    assert.strictEqual(secondLauncher, firstLauncher);
    assert.match(firstLauncher, /bridge\.main/);
    assert.match(firstLauncher, /--workspace/);
    assert.match(firstLauncher, /__dirname/);
    assert.doesNotMatch(firstLauncher, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(firstLauncher, new RegExp(bridgeModulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.strictEqual(
      await fs.readFile(first.runtimeBridgePath, 'utf8'),
      await fs.readFile(bridgeModulePath, 'utf8'),
    );
    assert.strictEqual(
      await fs.readFile(first.runtimeRegistryPath, 'utf8'),
      await fs.readFile(path.join(path.dirname(bridgeModulePath), 'windowRegistry.js'), 'utf8'),
    );

    const claude = JSON.parse(await fs.readFile(first.claudeConfigPath, 'utf8'));
    assert.strictEqual(claude.mcpServers.retained.command, 'keep');
    assert.strictEqual(claude.mcpServers.djangoDebugger.type, 'stdio');
    const codex = await fs.readFile(first.codexConfigPath, 'utf8');
    assert.match(codex, /\[mcp_servers\.retained\]/);
    assert.match(codex, /startup_timeout_sec = 15/);
    assert.match(codex, /default_tools_approval_mode = "writes"/);
    assert.match(codex, /env_vars = \[/);
    assert.strictEqual((codex.match(/\[mcp_servers\.djangoDebugger\]/g) ?? []).length, 1);
    if (process.platform !== 'win32') {
      assert.strictEqual((await fs.stat(first.launcherPath)).mode & 0o111, 0o111);
    }
  });

  it('launches portably from CLAUDE_PROJECT_DIR and from a nested Codex cwd', async function () {
    const workspace = await temporaryDirectory();
    const canonicalWorkspace = await fs.realpath(workspace);
    const bridgeModulePath = await createRuntimeSources(
      workspace,
      [
        "const registry = require('./windowRegistry');",
        'exports.main = async (args) => process.stdout.write(JSON.stringify({ args, marker: registry.runtimeMarker }));',
        '',
      ].join('\n'),
    );
    const result = await setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath });
    const claude = JSON.parse(await fs.readFile(result.claudeConfigPath, 'utf8'));
    const unrelatedCwd = await temporaryDirectory();
    const claudeRun = await runNode(
      claude.mcpServers.djangoDebugger.args,
      unrelatedCwd,
      { ...process.env, CLAUDE_PROJECT_DIR: workspace },
    );
    assert.deepStrictEqual(JSON.parse(claudeRun.stdout), {
      args: ['stdio', '--workspace', canonicalWorkspace],
      marker: 'registry-copy',
    });
    assert.strictEqual(claudeRun.stderr, '');

    const codexText = await fs.readFile(result.codexConfigPath, 'utf8');
    const argsLine = codexText.split(/\r?\n/).find((line) => line.startsWith('args = '));
    assert.ok(argsLine);
    const codexArgs = JSON.parse(argsLine.slice('args = '.length)) as string[];
    const nestedCwd = path.join(workspace, 'nested', 'working', 'directory');
    await fs.mkdir(nestedCwd, { recursive: true });
    const codexEnv = { ...process.env };
    delete codexEnv.CLAUDE_PROJECT_DIR;
    const codexRun = await runNode(codexArgs, nestedCwd, codexEnv);
    assert.deepStrictEqual(JSON.parse(codexRun.stdout), {
      args: ['stdio', '--workspace', canonicalWorkspace],
      marker: 'registry-copy',
    });
    assert.strictEqual(codexRun.stderr, '');
  });

  it('fails closed instead of falling through to a parent project launcher', async function () {
    const parent = await temporaryDirectory();
    const parentBridge = await createRuntimeSources(parent);
    await setupMcpWorkspace({ workspaceRoot: parent, bridgeModulePath: parentBridge });

    const child = path.join(parent, 'child-project');
    await fs.mkdir(child, { recursive: true });
    const childBridge = await createRuntimeSources(child);
    const childSetup = await setupMcpWorkspace({ workspaceRoot: child, bridgeModulePath: childBridge });
    const claude = JSON.parse(await fs.readFile(childSetup.claudeConfigPath, 'utf8'));
    const codexText = await fs.readFile(childSetup.codexConfigPath, 'utf8');
    const argsLine = codexText.split(/\r?\n/).find((line) => line.startsWith('args = '));
    assert.ok(argsLine);
    const codexArgs = JSON.parse(argsLine.slice('args = '.length)) as string[];
    await fs.unlink(childSetup.launcherPath);

    await assert.rejects(
      runNode(
        claude.mcpServers.djangoDebugger.args,
        parent,
        { ...process.env, CLAUDE_PROJECT_DIR: child },
      ),
      /Cannot find project Django debugger MCP launcher/,
    );
    const nested = path.join(child, 'nested');
    await fs.mkdir(nested);
    const codexEnv = { ...process.env };
    delete codexEnv.CLAUDE_PROJECT_DIR;
    await assert.rejects(
      runNode(codexArgs, nested, codexEnv),
      /Cannot find project Django debugger MCP launcher/,
    );
  });

  it('rejects inline, dotted, array-table, and duplicate quoted TOML definitions', function () {
    for (const conflicting of [
      'mcp_servers = { djangoDebugger = { command = "old" } }\n',
      'mcp_servers."djangoDebugger" = { command = "old" }\n',
      '[[mcp_servers.djangoDebugger]]\ncommand = "old"\n',
      '[mcp_servers]\ndjangoDebugger = { command = "old" }\n',
      '["mcp_servers"]\n"djangoDebugger".command = "old"\n',
    ]) {
      assert.throws(
        () => mergeCodexMcpConfig(conflicting, entry),
        /conflicting inline or dotted definition|array table/,
      );
    }
    assert.throws(
      () => mergeCodexMcpConfig([
        '[mcp_servers.djangoDebugger]',
        'command = "one"',
        '["mcp_servers"."djangoDebugger"]',
        'command = "two"',
      ].join('\n'), entry),
      /declared more than once/,
    );
  });

  it('validates all existing config before writing any setup file', async function () {
    const workspace = await temporaryDirectory();
    const bridgeModulePath = await createRuntimeSources(workspace);
    await fs.writeFile(path.join(workspace, '.mcp.json'), '{ invalid json');
    await assert.rejects(
      setupMcpWorkspace({
        workspaceRoot: workspace,
        bridgeModulePath,
      }),
      /not valid JSON/,
    );
    await assert.rejects(
      fs.stat(path.join(workspace, '.django-process-debugger', 'mcp-stdio.js')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    assert.strictEqual(await fs.readFile(path.join(workspace, '.mcp.json'), 'utf8'), '{ invalid json');
  });

  it('refuses a launcher path outside the workspace', async function () {
    const workspace = await temporaryDirectory();
    await assert.rejects(
      setupMcpWorkspace({
        workspaceRoot: workspace,
        bridgeModulePath: path.join(workspace, 'bridge.js'),
        launcherPath: '../outside.js',
      }),
      /inside the workspace/,
    );
  });

  it('requires both extension runtime sources to be regular files', async function () {
    const workspace = await temporaryDirectory();
    const bridgeModulePath = await createRuntimeSources(workspace);
    await fs.unlink(path.join(path.dirname(bridgeModulePath), 'windowRegistry.js'));
    await assert.rejects(
      setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath }),
      /window registry module does not exist/,
    );
    await fs.rm(bridgeModulePath);
    await fs.mkdir(bridgeModulePath);
    await fs.writeFile(
      path.join(path.dirname(bridgeModulePath), 'windowRegistry.js'),
      'exports.ok = true;\n',
    );
    await assert.rejects(
      setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath }),
      /stdio bridge module must be a regular file/,
    );
  });

  it('refuses a symlinked project target directory', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const workspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const bridgeModulePath = await createRuntimeSources(workspace);
    await fs.symlink(outside, path.join(workspace, '.django-process-debugger'));
    await assert.rejects(
      setupMcpWorkspace({ workspaceRoot: workspace, bridgeModulePath }),
      /symbolic-link target components/,
    );
    assert.deepStrictEqual(await fs.readdir(outside), []);
  });
});
