import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { DjangoProcessFinder } from '../../processFinder';
import { DebugpyInjector } from '../../debugpyInjector';
import { discoverRuntimeCandidates } from '../../runtimeSetup';
import { getPerf } from './perfReporter';

describe('Feature: runtime discovery', function () {
  const perf = getPerf();

  it('discoverRuntimeCandidates returns an array and completes under a reasonable budget', async function () {
    this.timeout(30_000);
    const finder = new DjangoProcessFinder();
    const injector = new DebugpyInjector();

    const candidates = await perf.measure('discoverRuntimeCandidates', async () =>
      discoverRuntimeCandidates(finder, injector),
    { group: 'runtimeSetup' });

    assert.ok(Array.isArray(candidates));
    // On a dev machine we expect at least one python candidate (asdf/pyenv/brew/venv).
    // In a clean CI container there may be none — so just validate the shape.
    for (const c of candidates) {
      assert.ok(typeof c.pythonPath === 'string' && c.pythonPath.length > 0);
      assert.ok(typeof c.resolvedPythonPath === 'string');
      assert.ok(typeof c.sourceLabel === 'string');
      assert.ok(typeof c.displayLabel === 'string');
    }
  });

  it('exposes expected configuration defaults', function () {
    const config = vscode.workspace.getConfiguration('djangoProcessDebugger');
    assert.strictEqual(config.get<boolean>('justMyCode'), true);
    assert.strictEqual(config.get<boolean>('redirectOutput'), true);
    assert.strictEqual(config.get<boolean>('hotReload'), true);
  });
});
