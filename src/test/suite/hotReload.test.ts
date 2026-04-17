import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DebugpyInjector } from '../../debugpyInjector';
import { shouldIgnoreForHotReload, HOT_RELOAD_EXCLUDE_SUBSTRINGS } from '../../hotReloadFilter';
import { getPerf } from './perfReporter';

const PORT_FILE_DIR = '/tmp/django-process-debugger';

describe('Feature: hot reload request/result protocol', function () {
  const perf = getPerf();
  const injector = new DebugpyInjector();
  const fakePid = 1_000_000 + Math.floor(Math.random() * 100_000);

  before(async function () {
    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
  });

  after(async function () {
    for (const name of [`${fakePid}.reload`, `${fakePid}.reload.result`]) {
      await fs.unlink(path.join(PORT_FILE_DIR, name)).catch(() => {});
    }
  });

  it('requestHotReload writes file paths to the reload file', async function () {
    const files = ['/tmp/project/views.py', '/tmp/project/models.py'];
    await perf.measure('requestHotReload', async () => {
      await injector.requestHotReload(fakePid, files);
    }, { group: 'hotReload' });

    const content = await fs.readFile(path.join(PORT_FILE_DIR, `${fakePid}.reload`), 'utf-8');
    assert.deepStrictEqual(content.trim().split('\n'), files);
  });

  it('requestHotReload with empty list is a no-op', async function () {
    const before = Date.now();
    await injector.requestHotReload(fakePid + 1, []);
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 50, `empty request should be instant, took ${elapsed}ms`);
    await assert.rejects(fs.access(path.join(PORT_FILE_DIR, `${fakePid + 1}.reload`)));
  });

  it('readReloadResult parses OK/ERR/SKIP lines and removes the file', async function () {
    const resultFile = path.join(PORT_FILE_DIR, `${fakePid}.reload.result`);
    const lines = [
      'OK:myapp.views (patched: index_view, home_view)',
      'ERR:myapp.urls:SyntaxError',
      'SKIP:/tmp/unloaded.py',
    ];
    await fs.writeFile(resultFile, lines.join('\n'), 'utf-8');

    const results = await perf.measure('readReloadResult', async () =>
      injector.readReloadResult(fakePid),
    { group: 'hotReload' });

    assert.deepStrictEqual(results, lines);
    await assert.rejects(fs.access(resultFile), 'result file should be consumed');
  });

  it('readReloadResult returns null when no result file exists', async function () {
    const results = await injector.readReloadResult(fakePid + 999);
    assert.strictEqual(results, null);
  });
});

/**
 * The file-watcher exclusion rule used to be inlined in extension.ts.
 * It was extracted into src/hotReloadFilter.ts so it can be unit-tested
 * without activating the whole extension. See optimization.md 🟡 MEDIUM.
 */
describe('Feature: hot reload exclusion filter', function () {
  const reloadPaths = [
    '/Users/me/project/myapp/views.py',
    '/Users/me/project/myapp/forms.py',
    '/workspaces/proj/settings.py',
  ];
  const skipPaths = [
    '/Users/me/project/.venv/lib/python3.11/site-packages/django/db/models.py',
    '/Users/me/project/venv/lib/python3.11/somepkg/x.py',
    '/Users/me/project/myapp/__pycache__/views.cpython-311.pyc',
    '/Users/me/project/myapp/migrations/0001_initial.py',
    '/Users/me/project/node_modules/@types/node/fs.d.ts',
    // raw `site-packages` anywhere
    '/opt/homebrew/lib/python3.11/site-packages/foo.py',
  ];

  it('reloads ordinary workspace .py files', function () {
    for (const p of reloadPaths) {
      assert.strictEqual(shouldIgnoreForHotReload(p), false, `should reload: ${p}`);
    }
  });

  it('ignores venv / site-packages / __pycache__ / migrations / node_modules', function () {
    for (const p of skipPaths) {
      assert.strictEqual(shouldIgnoreForHotReload(p), true, `should ignore: ${p}`);
    }
  });

  it('exposes the exclusion list for documentation/self-check', function () {
    // Prevent accidental empty list or change in count without review.
    assert.ok(HOT_RELOAD_EXCLUDE_SUBSTRINGS.length >= 5,
      `exclusion list shrank unexpectedly: ${HOT_RELOAD_EXCLUDE_SUBSTRINGS}`);
    assert.ok(HOT_RELOAD_EXCLUDE_SUBSTRINGS.includes('site-packages'));
    assert.ok(HOT_RELOAD_EXCLUDE_SUBSTRINGS.includes('__pycache__'));
  });
});
