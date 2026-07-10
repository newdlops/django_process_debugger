import * as assert from 'assert';
import { describe, it } from 'mocha';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DjangoProcessFinder } from '../../processFinder';
import { DebugpyInjector } from '../../debugpyInjector';
import { DebugpyManager } from '../../debugpyManager';
import { discoverRuntimeCandidates, inspectRuntimePreflight } from '../../runtimeSetup';
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

  it('exposes expected configuration defaults', async function () {
    const config = vscode.workspace.getConfiguration('djangoProcessDebugger');
    const manifest = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8'));
    const defaults = manifest.contributes.configuration.properties;

    assert.strictEqual(
      config.get<string>('engine') ?? defaults['djangoProcessDebugger.engine'].default,
      'debugpy',
    );
    assert.strictEqual(
      config.get<boolean>('justMyCode') ?? defaults['djangoProcessDebugger.justMyCode'].default,
      true,
    );
    assert.strictEqual(
      config.get<boolean>('redirectOutput') ?? defaults['djangoProcessDebugger.redirectOutput'].default,
      true,
    );
    assert.strictEqual(
      config.get<boolean>('hotReload') ?? defaults['djangoProcessDebugger.hotReload'].default,
      true,
    );
  });

  it('allows setup when interpreter inspection fails but venv site-packages is inferable', async function () {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-runtime-'));
    try {
      const venvDir = path.join(tmpDir, '.venv');
      const binDir = path.join(venvDir, 'bin');
      const sitePackages = path.join(venvDir, 'lib', 'python3.11', 'site-packages');
      const pythonPath = path.join(binDir, 'python3');

      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(sitePackages, { recursive: true });
      await fs.writeFile(path.join(venvDir, 'pyvenv.cfg'), 'home = /tmp/python\n', 'utf-8');
      await fs.writeFile(pythonPath, '#!/bin/sh\nexit 137\n', 'utf-8');
      await fs.chmod(pythonPath, 0o755);

      const debugpyManager = {
        getProvisioningInfo: async () => ({
          path: '/vendor/debugpy',
          source: 'vendored' as const,
          version: 'test',
        }),
        repairPythonRuntime: async () => false,
      } as unknown as DebugpyManager;

      const preflight = await inspectRuntimePreflight(
        pythonPath,
        undefined,
        new DebugpyInjector(),
        debugpyManager,
      );

      assert.deepStrictEqual(preflight.errors, []);
      assert.strictEqual(preflight.sitePackages, sitePackages);
      assert.strictEqual(preflight.isVirtualEnv, true);
      assert.ok(
        preflight.warnings.some((warning) => warning.includes('setup will use inferred site-packages')),
        `expected inferred site-packages warning, got: ${preflight.warnings.join('; ')}`,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('repairs and retries interpreter inspection after macOS SIGKILL', async function () {
    if (process.platform !== 'darwin') {
      this.skip();
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-runtime-repair-'));
    try {
      const venvDir = path.join(tmpDir, '.venv');
      const binDir = path.join(venvDir, 'bin');
      const sitePackages = path.join(venvDir, 'lib', 'python3.11', 'site-packages');
      const pythonPath = path.join(binDir, 'python3');
      const markerPath = path.join(tmpDir, 'repaired');

      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(sitePackages, { recursive: true });
      await fs.writeFile(path.join(venvDir, 'pyvenv.cfg'), 'home = /tmp/python\n', 'utf-8');
      await fs.writeFile(
        pythonPath,
        [
          '#!/bin/sh',
          `if [ -f ${JSON.stringify(markerPath)} ]; then`,
          `  echo ${JSON.stringify(JSON.stringify({
            canImportPip: true,
            isVirtualEnv: true,
            pythonVersion: '3.11.15',
            sitePackages: [sitePackages],
          }))}`,
          '  exit 0',
          'fi',
          'exit 137',
          '',
        ].join('\n'),
        'utf-8',
      );
      await fs.chmod(pythonPath, 0o755);

      let repairCalls = 0;
      const debugpyManager = {
        getProvisioningInfo: async () => ({
          path: '/vendor/debugpy',
          source: 'vendored' as const,
          version: 'test',
        }),
        repairPythonRuntime: async () => {
          repairCalls++;
          await fs.writeFile(markerPath, 'ok', 'utf-8');
          return true;
        },
      } as unknown as DebugpyManager;

      const preflight = await inspectRuntimePreflight(
        pythonPath,
        undefined,
        new DebugpyInjector(),
        debugpyManager,
      );

      assert.strictEqual(repairCalls, 1);
      assert.deepStrictEqual(preflight.errors, []);
      assert.strictEqual(preflight.pythonVersion, '3.11.15');
      assert.strictEqual(preflight.sitePackages, sitePackages);
      assert.ok(preflight.warnings.some((warning) => warning.includes('Repaired macOS code signature')));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
