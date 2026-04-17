import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DebugpyInjector, BOOTSTRAP_VERSION } from '../../debugpyInjector';
import { getPerf } from './perfReporter';
import { findSystemPython, projectRoot } from './testHelpers';

const execFileAsync = promisify(execFile);

describe('Feature: debugpy injector bootstrap lifecycle', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const vendored = path.join(projectRoot(), 'vendor', 'python');
  let tmpDir: string;
  let sitePackages: string;

  before(async function () {
    injector.setBundledDebugpyPath(vendored);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpd-inj-'));
    sitePackages = path.join(tmpDir, 'site-packages');
    await fs.mkdir(sitePackages, { recursive: true });
  });

  after(async function () {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('installs bootstrap (.pth + module) into a fake site-packages', async function () {
    await perf.measure('installBootstrap', async () => {
      await injector.installBootstrap(sitePackages);
    }, { group: 'injector' });

    await assert.doesNotReject(fs.access(path.join(sitePackages, 'django_process_debugger.pth')));
    await assert.doesNotReject(fs.access(path.join(sitePackages, '_django_debug_bootstrap.py')));
  });

  it('isBootstrapInstalled returns true after install', async function () {
    const installed = await perf.measure('isBootstrapInstalled', async () =>
      injector.isBootstrapInstalled(sitePackages),
    { group: 'injector' });
    assert.strictEqual(installed, true);
  });

  it('isBootstrapUpToDate returns true for current version', async function () {
    const upToDate = await perf.measure('isBootstrapUpToDate', async () =>
      injector.isBootstrapUpToDate(sitePackages),
    { group: 'injector' });
    assert.strictEqual(upToDate, true);
  });

  it('isBootstrapUpToDate detects an older version', async function () {
    const modPath = path.join(sitePackages, '_django_debug_bootstrap.py');
    const original = await fs.readFile(modPath, 'utf-8');
    await fs.writeFile(modPath, original.replace(BOOTSTRAP_VERSION, '1970.01.01'));
    try {
      const upToDate = await injector.isBootstrapUpToDate(sitePackages);
      assert.strictEqual(upToDate, false);
    } finally {
      await fs.writeFile(modPath, original);
    }
  });

  it('generated bootstrap script is syntactically valid Python', async function () {
    this.timeout(15_000);
    const python = await findSystemPython();
    if (!python) { this.skip(); return; }

    const modPath = path.join(sitePackages, '_django_debug_bootstrap.py');
    await perf.measure('python -m py_compile bootstrap', async () => {
      await execFileAsync(python, ['-m', 'py_compile', modPath], { timeout: 10_000 });
    }, { group: 'injector' });
  });

  it('resolveSitePackages works on the system python', async function () {
    this.timeout(15_000);
    const python = await findSystemPython();
    if (!python) { this.skip(); return; }

    const resolved = await perf.measure('resolveSitePackages', async () =>
      injector.resolveSitePackages(python),
    { group: 'injector' });

    assert.ok(resolved.length > 0, 'site-packages should not be empty');
    assert.ok(resolved.includes('site-packages') || resolved.includes('lib'),
      `unexpected site-packages: ${resolved}`);
  });

  it('resolvePythonForPid returns a path for the current process', async function () {
    this.timeout(10_000);
    const resolved = await perf.measure('resolvePythonForPid (self)', async () =>
      injector.resolvePythonForPid(process.pid),
    { group: 'injector' });

    assert.ok(resolved.length > 0);
  });

  it('getActivePort returns null when bootstrap has not activated', async function () {
    const result = await injector.getActivePort(999_999);
    assert.strictEqual(result, null);
  });

  it('uninstallBootstrap removes both files', async function () {
    await injector.uninstallBootstrap(sitePackages);
    await assert.rejects(fs.access(path.join(sitePackages, 'django_process_debugger.pth')));
    await assert.rejects(fs.access(path.join(sitePackages, '_django_debug_bootstrap.py')));
  });
});
