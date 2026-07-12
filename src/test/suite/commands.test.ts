import * as assert from 'assert';
import * as vscode from 'vscode';
import { describe, it, before } from 'mocha';
import { getPerf } from './perfReporter';
import type { DjangoProcessDebuggerPublicApiV1 } from '../../publicApi';
import { mcpToolRequiresEvaluatePermission } from '../../extension';

const EXTENSION_ID = 'newdlops.django-process-debugger';

const EXPECTED_COMMANDS = [
  'djangoProcessDebugger.setup',
  'djangoProcessDebugger.showSetupStatus',
  'djangoProcessDebugger.attachToProcess',
  'djangoProcessDebugger.killProcess',
  'djangoProcessDebugger.reinstallDebugpy',
  'djangoProcessDebugger.cleanPythonLanguageServer',
  'djangoProcessDebugger.installMcp',
  'djangoProcessDebugger.showMcpStatus',
  'djangoProcessDebugger.verifyMcp',
  'djangoProcessDebugger.repairMcp',
];

describe('Feature: command registration', function () {
  const perf = getPerf();

  before(async function () {
    this.timeout(30_000);
    await perf.measure('activate extension', async () => {
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(ext, `extension ${EXTENSION_ID} not found`);
      if (!ext.isActive) {
        await ext.activate();
      }
    }, { group: 'bootstrap' });
  });

  it('registers all documented commands', async function () {
    const all = await perf.measure('getCommands', async () =>
      vscode.commands.getCommands(true),
    { group: 'commands' });

    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(all.includes(cmd), `missing command: ${cmd}`);
    }
  });

  it('returns the public v1 API from extension activation', function () {
    const ext = vscode.extensions.getExtension<DjangoProcessDebuggerPublicApiV1>(EXTENSION_ID)!;
    assert.ok(ext.isActive);
    assert.strictEqual(ext.exports.apiVersion, 1);
    assert.strictEqual(ext.exports.debugType, 'django-process');
    assert.deepStrictEqual([...ext.exports.engines], ['debugpy', 'experimental']);
    assert.deepStrictEqual(ext.exports.commands, {
      setup: 'djangoProcessDebugger.setup',
      status: 'djangoProcessDebugger.showSetupStatus',
    });
    assert.deepStrictEqual(ext.exports.capabilities.experimental, {
      localPid: true,
      hotReload: true,
    });
  });

  it('contributes the django-process debug type', function () {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    const debuggers = (ext.packageJSON.contributes?.debuggers ?? []) as Array<{ type: string }>;
    assert.ok(
      debuggers.some((d) => d.type === 'django-process'),
      'django-process debug type not contributed',
    );
  });

  it('exposes the settings schema', function () {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    const props = ext.packageJSON.contributes?.configuration?.properties ?? {};
    for (const key of [
      'djangoProcessDebugger.engine',
      'djangoProcessDebugger.justMyCode',
      'djangoProcessDebugger.redirectOutput',
      'djangoProcessDebugger.hotReload',
      'djangoProcessDebugger.mcp.enabled',
      'djangoProcessDebugger.mcp.allowControl',
      'djangoProcessDebugger.mcp.allowEvaluate',
    ]) {
      assert.ok(props[key], `missing setting: ${key}`);
    }

    const engine = props['djangoProcessDebugger.engine'];
    assert.strictEqual(engine.type, 'string');
    assert.strictEqual(engine.default, 'debugpy');
    assert.deepStrictEqual(engine.enum, ['debugpy', 'experimental']);
  });

  it('gates every MCP surface that can evaluate application code', function () {
    assert.strictEqual(mcpToolRequiresEvaluatePermission('django_expression_inspect', {}), true);
    assert.strictEqual(mcpToolRequiresEvaluatePermission('django_breakpoints_update', {
      breakpoints: [{ path: 'views.py', line: 1 }],
    }), false);
    assert.strictEqual(mcpToolRequiresEvaluatePermission('django_breakpoints_update', {
      breakpoints: [{ path: 'views.py', line: 1, condition: 'danger()' }],
    }), true);
    assert.strictEqual(mcpToolRequiresEvaluatePermission('django_breakpoints_update', {
      breakpoints: [{ path: 'views.py', line: 1, logMessage: '{danger()}' }],
    }), true);
  });

  it('exposes engine selection in the attach configuration schema and snippet', function () {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
    const debuggerContribution = (ext.packageJSON.contributes?.debuggers ?? [])
      .find((entry: { type?: string }) => entry.type === 'django-process');
    assert.ok(debuggerContribution);

    const engine = debuggerContribution.configurationAttributes?.attach?.properties?.engine;
    assert.ok(engine, 'missing attach engine property');
    assert.strictEqual(engine.default, 'debugpy');
    assert.deepStrictEqual(engine.enum, ['debugpy', 'experimental']);

    const pid = debuggerContribution.configurationAttributes?.attach?.properties?.pid;
    assert.ok(pid, 'missing attach pid property');
    assert.strictEqual(pid.type, 'number');
    assert.strictEqual(pid.minimum, 1);

    const snippet = debuggerContribution.configurationSnippets?.[0]?.body;
    assert.strictEqual(snippet?.engine, 'debugpy');
  });
});
