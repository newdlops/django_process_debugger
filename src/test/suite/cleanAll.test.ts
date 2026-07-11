import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it } from 'mocha';
import {
  preflightCleanAll,
  runCleanAll,
  type CleanAllScope,
} from '../../cleanAll';

describe('Feature: scoped Clean All', function () {
  const temporaryRoots: string[] = [];

  async function makeRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-clean-all-'));
    temporaryRoots.push(root);
    return root;
  }

  afterEach(async function () {
    await Promise.all(temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    ));
  });

  async function createManagedScope(root: string, pid = 42420): Promise<{
    scope: CleanAllScope;
    sitePackages: string;
    artifactDirectory: string;
    debugpyDirectory: string;
  }> {
    const sitePackages = path.join(root, '.venv', 'lib', 'python3.12', 'site-packages');
    const cacheDirectory = path.join(sitePackages, '__pycache__');
    const artifactDirectory = path.join(root, 'django-process-debugger');
    const storageRoot = path.join(root, 'global-storage');
    const debugpyDirectory = path.join(storageRoot, 'debugpy');

    await fs.mkdir(cacheDirectory, { recursive: true });
    await fs.mkdir(artifactDirectory, { recursive: true });
    await fs.mkdir(debugpyDirectory, { recursive: true });
    await fs.writeFile(path.join(sitePackages, 'django_process_debugger.pth'), 'managed');
    await fs.writeFile(path.join(sitePackages, '_django_debug_bootstrap.py'), 'managed');
    await fs.writeFile(path.join(sitePackages, '_django_debug_tracer.py'), 'managed');
    await fs.writeFile(
      path.join(cacheDirectory, '_django_debug_bootstrap.cpython-312.pyc'),
      'managed',
    );
    await fs.writeFile(path.join(sitePackages, 'keep.py'), 'unrelated');
    await fs.writeFile(path.join(cacheDirectory, 'keep.cpython-312.pyc'), 'unrelated');

    await fs.writeFile(path.join(artifactDirectory, `${pid}.bootstrap.json`), '{}');
    await fs.writeFile(path.join(artifactDirectory, `${pid}.reload.result.123.tmp`), 'managed');
    await fs.writeFile(path.join(artifactDirectory, `debug-session.${pid}.lock`), '{}');
    await fs.writeFile(
      path.join(artifactDirectory, `${pid}.hot-reload.${'a'.repeat(64)}.lease`),
      '{}',
    );
    await fs.writeFile(path.join(artifactDirectory, `${pid + 1}.bootstrap.json`), 'unrelated');
    await fs.writeFile(path.join(artifactDirectory, 'bootstrap.log'), 'unrelated');
    await fs.writeFile(path.join(debugpyDirectory, '.installed'), 'managed');
    await fs.writeFile(path.join(storageRoot, 'keep.txt'), 'unrelated');

    return {
      scope: {
        runtimes: [{ sitePackages, label: 'test runtime' }],
        targetPids: [pid],
        artifactDirectory,
        debugpyStorage: { storageRoot, debugpyDirectory },
      },
      sitePackages,
      artifactDirectory,
      debugpyDirectory,
    };
  }

  it('preflights and dry-runs only explicitly managed resources', async function () {
    const root = await makeRoot();
    const { scope, sitePackages, artifactDirectory, debugpyDirectory } =
      await createManagedScope(root);

    const preflight = await preflightCleanAll(scope);
    assert.strictEqual(preflight.safe, true, preflight.summary);
    assert.ok(preflight.counts.existing >= 9, preflight.summary);
    assert.strictEqual(preflight.counts.issues, 0);
    assert.ok(preflight.items.every((item) => item.path.startsWith(root + path.sep)));

    const result = await runCleanAll(scope, { dryRun: true });
    assert.strictEqual(result.ok, true, result.summary);
    assert.strictEqual(result.counts.removed, 0);
    assert.strictEqual(result.counts.wouldRemove, preflight.counts.existing);
    assert.ok(result.summary.startsWith('Dry run:'));

    await assert.doesNotReject(fs.access(path.join(sitePackages, '_django_debug_bootstrap.py')));
    await assert.doesNotReject(fs.access(path.join(artifactDirectory, '42420.bootstrap.json')));
    await assert.doesNotReject(fs.access(debugpyDirectory));
  });

  it('removes bootstrap assets, selected-PID artifacts, and extension-owned debugpy only', async function () {
    const root = await makeRoot();
    const { scope, sitePackages, artifactDirectory, debugpyDirectory } =
      await createManagedScope(root);

    const result = await runCleanAll(scope);
    assert.strictEqual(result.ok, true, result.summary);
    assert.ok(result.counts.removed >= 9, result.summary);
    assert.strictEqual(result.counts.failed, 0);

    for (const name of [
      'django_process_debugger.pth',
      '_django_debug_bootstrap.py',
      '_django_debug_tracer.py',
    ]) {
      await assert.rejects(fs.access(path.join(sitePackages, name)));
    }
    await assert.rejects(fs.access(
      path.join(sitePackages, '__pycache__', '_django_debug_bootstrap.cpython-312.pyc'),
    ));
    await assert.rejects(fs.access(path.join(artifactDirectory, '42420.bootstrap.json')));
    await assert.rejects(fs.access(path.join(artifactDirectory, 'debug-session.42420.lock')));
    await assert.rejects(fs.access(debugpyDirectory));

    // Clean All does not recurse through runtimes or remove shared/global data.
    await assert.doesNotReject(fs.access(path.join(sitePackages, 'keep.py')));
    await assert.doesNotReject(fs.access(
      path.join(sitePackages, '__pycache__', 'keep.cpython-312.pyc'),
    ));
    await assert.doesNotReject(fs.access(path.join(artifactDirectory, '42421.bootstrap.json')));
    await assert.doesNotReject(fs.access(path.join(artifactDirectory, 'bootstrap.log')));
    await assert.doesNotReject(fs.access(path.join(root, 'global-storage', 'keep.txt')));
  });

  it('fails closed when any PID or managed path is invalid', async function () {
    const root = await makeRoot();
    const { scope, sitePackages } = await createManagedScope(root);
    const bootstrapPath = path.join(sitePackages, '_django_debug_bootstrap.py');

    const result = await runCleanAll({
      ...scope,
      targetPids: [42420, 0],
      runtimes: [
        ...(scope.runtimes ?? []),
        { sitePackages: root, label: 'unsafe runtime path' },
      ],
    });

    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((entry) => entry.code === 'invalid-pid'));
    assert.ok(result.issues.some((entry) => entry.code === 'invalid-site-packages'));
    assert.ok(result.counts.blocked > 0);
    assert.strictEqual(result.counts.removed, 0);
    await assert.doesNotReject(fs.access(bootstrapPath));
  });

  it('refuses a debugpy path outside extension global storage', async function () {
    const root = await makeRoot();
    const protectedDirectory = path.join(root, 'protected', 'debugpy');
    await fs.mkdir(protectedDirectory, { recursive: true });
    await fs.writeFile(path.join(protectedDirectory, 'keep.txt'), 'do not remove');

    const result = await runCleanAll({
      debugpyStorage: {
        storageRoot: path.join(root, 'global-storage'),
        debugpyDirectory: protectedDirectory,
      },
    });

    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((entry) => entry.code === 'invalid-debugpy-storage'));
    assert.strictEqual(result.counts.removed, 0);
    await assert.doesNotReject(fs.access(path.join(protectedDirectory, 'keep.txt')));
  });

  it('removes a legacy global lock only when it belongs to an explicit PID', async function () {
    const root = await makeRoot();
    const artifactDirectory = path.join(root, 'django-process-debugger');
    const legacyLock = path.join(artifactDirectory, 'debug-session.lock');
    await fs.mkdir(artifactDirectory, { recursive: true });
    await fs.writeFile(legacyLock, JSON.stringify({ pid: 70001 }));

    await runCleanAll({ targetPids: [70002], artifactDirectory });
    await assert.doesNotReject(fs.access(legacyLock));

    const result = await runCleanAll({ targetPids: [70001], artifactDirectory });
    assert.strictEqual(result.ok, true, result.summary);
    await assert.rejects(fs.access(legacyLock));
  });
});
