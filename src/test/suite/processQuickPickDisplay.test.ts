import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
  cwdFolderName,
  processQuickPickDescription,
  processQuickPickDetail,
  sanitizeQuickPickText,
  selectDisplayCwd,
  selectGroupedDisplayCwd,
} from '../../processQuickPickDisplay';

describe('Feature: readable process QuickPick paths', function () {
  it('puts the full CWD first and exposes its project folder beside the PID', function () {
    const cwd = '/Users/developer/company/platform/services/customer-api';

    assert.strictEqual(
      processQuickPickDetail(cwd, [
        'Python: /Users/developer/company/.venv/bin/python',
        'Experimental Native Tracer not attached',
      ]),
      `CWD: ${cwd}  |  Python: /Users/developer/company/.venv/bin/python` +
        '  |  Experimental Native Tracer not attached',
    );
    assert.strictEqual(
      processQuickPickDescription(cwd, 'PID: 321'),
      '$(folder) customer-api  •  PID: 321',
    );
  });

  it('handles trailing separators, roots, Windows paths, and missing CWDs', function () {
    assert.strictEqual(cwdFolderName('/workspace/backend/'), 'backend');
    assert.strictEqual(cwdFolderName('/'), '/');
    assert.strictEqual(cwdFolderName('C:\\work\\service\\'), 'service');
    assert.strictEqual(cwdFolderName(undefined), undefined);
    assert.strictEqual(processQuickPickDescription(undefined, 'PID: 7'), 'PID: 7');
    assert.strictEqual(
      processQuickPickDetail(undefined, ['Python: /usr/bin/python3']),
      'Python: /usr/bin/python3',
    );
  });

  it('uses a sibling process CWD when the preferred group representative lacks one', function () {
    assert.strictEqual(
      selectDisplayCwd(undefined, [undefined, '/srv/apps/orders']),
      '/srv/apps/orders',
    );
    assert.strictEqual(
      selectDisplayCwd('/srv/apps/preferred', ['/srv/apps/fallback']),
      '/srv/apps/preferred',
    );
    assert.strictEqual(
      selectGroupedDisplayCwd(41, undefined, [
        { resolvedPid: 42, cwd: '/srv/apps/unrelated' },
        { resolvedPid: 41, cwd: '/srv/apps/correct-worker' },
      ]),
      '/srv/apps/correct-worker',
    );
    assert.strictEqual(
      selectGroupedDisplayCwd(41, undefined, [
        { resolvedPid: 42, cwd: '/srv/apps/unrelated' },
      ]),
      undefined,
    );
  });

  it('keeps path text on one QuickPick line', function () {
    assert.strictEqual(
      sanitizeQuickPickText('/srv/projects/customer\napi\tworker'),
      '/srv/projects/customer api worker',
    );
  });
});
