import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import { DjangoProcessFinder } from '../../processFinder';
import { getPerf } from './perfReporter';
import { findSystemPython, spawnFakeRunserver, SpawnedProcess } from './testHelpers';

/**
 * Verifies that findDjangoProcesses handles more than one running server
 * correctly — this is the realistic case for a developer running Django +
 * Celery worker side-by-side, or two runservers on different ports.
 *
 * Measures the marginal cost of discovering N processes vs 1, which feeds
 * the "subprocess cost scales with process count" observation in optimization.md.
 */
describe('Feature: multi-process discovery', function () {
  const perf = getPerf();
  const finder = new DjangoProcessFinder();
  const portA = 49_881;
  const portB = 49_882;
  let pythonBin: string | null;
  let serverA: SpawnedProcess | null = null;
  let serverB: SpawnedProcess | null = null;

  before(async function () {
    this.timeout(20_000);
    pythonBin = await findSystemPython();
    if (!pythonBin) { this.skip(); return; }

    serverA = await spawnFakeRunserver(pythonBin, portA);
    serverB = await spawnFakeRunserver(pythonBin, portB);
  });

  after(async function () {
    this.timeout(10_000);
    if (serverA) { await serverA.stop(); }
    if (serverB) { await serverB.stop(); }
  });

  it('finds both runservers with distinct ports', async function () {
    if (!serverA || !serverB) { this.skip(); return; }
    this.timeout(15_000);

    const results = await perf.measure('findDjangoProcesses (2 fake)', async () =>
      finder.findDjangoProcesses(),
    { group: 'processFinder', meta: { count: 2 } });

    const a = results.find((p) => p.pid === serverA!.pid);
    const b = results.find((p) => p.pid === serverB!.pid);

    assert.ok(a, `server A (pid=${serverA.pid}) not found in results`);
    assert.ok(b, `server B (pid=${serverB.pid}) not found in results`);
    assert.strictEqual(a.port, portA, 'server A port mismatch');
    assert.strictEqual(b.port, portB, 'server B port mismatch');
    assert.notStrictEqual(a.pid, b.pid, 'pids must differ');
  });

  it('resolveDebuggablePid works independently per pid', async function () {
    if (!serverA || !serverB) { this.skip(); return; }
    this.timeout(15_000);

    const [resolvedA, resolvedB] = await Promise.all([
      finder.resolveDebuggablePid(serverA.pid),
      finder.resolveDebuggablePid(serverB.pid),
    ]);

    assert.strictEqual(resolvedA.pid, serverA.pid);
    assert.strictEqual(resolvedB.pid, serverB.pid);
  });
});
