import * as assert from 'assert';
import * as vscode from 'vscode';
import { describe, it, before } from 'mocha';
import { getPerf } from './perfReporter';

const EXTENSION_ID = 'newdlops.django-process-debugger';

const EXPECTED_COMMANDS = [
  'djangoProcessDebugger.setup',
  'djangoProcessDebugger.showSetupStatus',
  'djangoProcessDebugger.attachToProcess',
  'djangoProcessDebugger.killProcess',
  'djangoProcessDebugger.reinstallDebugpy',
  'djangoProcessDebugger.cleanPythonLanguageServer',
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
    ]) {
      assert.ok(props[key], `missing setting: ${key}`);
    }

    const engine = props['djangoProcessDebugger.engine'];
    assert.strictEqual(engine.type, 'string');
    assert.strictEqual(engine.default, 'debugpy');
    assert.deepStrictEqual(engine.enum, ['debugpy', 'experimental']);
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
