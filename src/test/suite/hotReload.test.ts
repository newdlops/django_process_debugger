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
  const requestLeaseId = 'a'.repeat(64);
  const renewableLeaseId = 'b'.repeat(64);

  before(async function () {
    await fs.mkdir(PORT_FILE_DIR, { recursive: true });
  });

  after(async function () {
    for (const name of [
      `${fakePid}.reload`,
      `${fakePid}.reload.processing`,
      `${fakePid}.reload.result`,
      `${fakePid}.hot-reload.${requestLeaseId}.lease`,
      `${fakePid}.hot-reload.${renewableLeaseId}.lease`,
    ]) {
      await fs.unlink(path.join(PORT_FILE_DIR, name)).catch(() => {});
    }
  });

  it('requestHotReload atomically publishes a correlated v2 request', async function () {
    const files = ['/tmp/project/views.py', '/tmp/project/models.py'];
    let requestId: string | null = null;
    await perf.measure('requestHotReload', async () => {
      requestId = await injector.requestHotReload(fakePid, files);
    }, { group: 'hotReload' });

    const content = await fs.readFile(path.join(PORT_FILE_DIR, `${fakePid}.reload`), 'utf-8');
    assert.ok(requestId);
    assert.deepStrictEqual(JSON.parse(content), {
      version: 2,
      requestId,
      paths: files,
    });
  });

  it('requestHotReload publishes a private correlated v3 request when leased', async function () {
    const files = ['/tmp/project/leased.py'];
    const requestId = await injector.requestHotReload(fakePid, files, requestLeaseId);
    const requestFile = path.join(PORT_FILE_DIR, `${fakePid}.reload`);
    const [content, stat] = await Promise.all([
      fs.readFile(requestFile, 'utf-8'),
      fs.stat(requestFile),
    ]);

    assert.ok(requestId);
    assert.deepStrictEqual(JSON.parse(content), {
      version: 3,
      requestId,
      leaseId: requestLeaseId,
      paths: files,
    });
    assert.strictEqual(stat.mode & 0o777, 0o600);
  });

  it('rejects malformed lease IDs and out-of-range lease TTLs', async function () {
    await assert.rejects(
      injector.requestHotReload(fakePid, ['/tmp/project/views.py'], 'A'.repeat(64)),
      (error: unknown) => error instanceof TypeError
        && error.message.includes('64 lowercase hexadecimal'),
    );
    await assert.rejects(
      injector.renewHotReloadLease(fakePid, 'not-a-lease'),
      (error: unknown) => error instanceof TypeError
        && error.message.includes('64 lowercase hexadecimal'),
    );

    for (const ttlMs of [499, 120_001, 1_000.5]) {
      await assert.rejects(
        injector.renewHotReloadLease(fakePid, renewableLeaseId, ttlMs),
        (error: unknown) => error instanceof RangeError
          && error.message.includes('between 500 and 120000ms'),
      );
    }
  });

  it('atomically creates and renews a private lease file, then releases it', async function () {
    const leaseFile = path.join(
      PORT_FILE_DIR,
      `${fakePid}.hot-reload.${renewableLeaseId}.lease`,
    );

    await injector.renewHotReloadLease(fakePid, renewableLeaseId, 1_000);
    const firstContent = JSON.parse(await fs.readFile(leaseFile, 'utf-8')) as {
      version: number;
      pid: number;
      leaseId: string;
      ttlMs: number;
      renewedAt: number;
    };
    const firstStat = await fs.stat(leaseFile);
    assert.deepStrictEqual(firstContent, {
      version: 1,
      pid: fakePid,
      leaseId: renewableLeaseId,
      ttlMs: 1_000,
      renewedAt: firstContent.renewedAt,
    });
    assert.ok(Number.isFinite(firstContent.renewedAt));
    assert.strictEqual(firstStat.mode & 0o777, 0o600);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await injector.renewHotReloadLease(fakePid, renewableLeaseId, 2_000);
    const secondContent = JSON.parse(await fs.readFile(leaseFile, 'utf-8')) as {
      ttlMs: number;
      renewedAt: number;
    };
    const secondStat = await fs.stat(leaseFile);
    assert.strictEqual(secondContent.ttlMs, 2_000);
    assert.ok(secondContent.renewedAt > firstContent.renewedAt);
    assert.notStrictEqual(secondStat.ino, firstStat.ino, 'renewal should replace the lease atomically');

    const temporaryPrefix = `${fakePid}.hot-reload.${renewableLeaseId}.lease.`;
    const temporaryFiles = (await fs.readdir(PORT_FILE_DIR)).filter(
      (name) => name.startsWith(temporaryPrefix) && name.endsWith('.tmp'),
    );
    assert.deepStrictEqual(temporaryFiles, []);

    await injector.releaseHotReloadLease(fakePid, renewableLeaseId);
    await assert.rejects(
      fs.access(leaseFile),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  });

  it('requestHotReload with empty list is a no-op', async function () {
    const before = Date.now();
    const requestId = await injector.requestHotReload(fakePid + 1, []);
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 50, `empty request should be instant, took ${elapsed}ms`);
    assert.strictEqual(requestId, null);
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

  it('does not consume a result belonging to another request', async function () {
    const resultFile = path.join(PORT_FILE_DIR, `${fakePid}.reload.result`);
    await fs.writeFile(resultFile, JSON.stringify({
      version: 2,
      requestId: 'older-request',
      results: ['OK:myapp.views'],
    }), 'utf-8');

    assert.strictEqual(
      await injector.readReloadResult(fakePid, 'newer-request'),
      null,
    );
    await fs.access(resultFile);
    assert.deepStrictEqual(
      await injector.readReloadResult(fakePid, 'older-request'),
      ['OK:myapp.views'],
    );
    await assert.rejects(fs.access(resultFile));
  });

  it('treats an atomically claimed processing file as pending', async function () {
    const requestId = await injector.requestHotReload(fakePid, ['/tmp/app.py']);
    assert.ok(requestId);
    await fs.rename(
      path.join(PORT_FILE_DIR, `${fakePid}.reload`),
      path.join(PORT_FILE_DIR, `${fakePid}.reload.processing`),
    );
    assert.strictEqual(
      await injector.isReloadPending(fakePid, requestId ?? undefined),
      true,
    );
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
    '/Users/me/project/.django-shell/console-cell.py',
    'C:\\Users\\me\\project\\.django-shell\\analysis.py',
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

  it('ignores generated .django-shell files with normalized directory boundaries', function () {
    assert.strictEqual(
      shouldIgnoreForHotReload('/workspace/project/.django-shell/console-cell.py'),
      true,
    );
    assert.strictEqual(
      shouldIgnoreForHotReload('C:\\workspace\\project\\.django-shell\\console-cell.py'),
      true,
    );
    assert.strictEqual(
      shouldIgnoreForHotReload('/workspace/project/.django-shell-backup/console-cell.py'),
      false,
    );
    assert.ok(HOT_RELOAD_EXCLUDE_SUBSTRINGS.includes('/.django-shell/'));
  });

  it('exposes the exclusion list for documentation/self-check', function () {
    // Prevent accidental empty list or change in count without review.
    assert.ok(HOT_RELOAD_EXCLUDE_SUBSTRINGS.length >= 5,
      `exclusion list shrank unexpectedly: ${HOT_RELOAD_EXCLUDE_SUBSTRINGS}`);
    assert.ok(HOT_RELOAD_EXCLUDE_SUBSTRINGS.includes('site-packages'));
    assert.ok(HOT_RELOAD_EXCLUDE_SUBSTRINGS.includes('__pycache__'));
  });
});
