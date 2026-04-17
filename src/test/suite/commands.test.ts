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
      'djangoProcessDebugger.justMyCode',
      'djangoProcessDebugger.redirectOutput',
      'djangoProcessDebugger.hotReload',
    ]) {
      assert.ok(props[key], `missing setting: ${key}`);
    }
  });
});
