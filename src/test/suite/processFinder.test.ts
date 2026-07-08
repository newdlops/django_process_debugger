import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import { DjangoProcess, DjangoProcessFinder, mergeLoopbackAliasEndpoints } from '../../processFinder';
import { parseLsofTcpListenLine } from '../../listeningEndpoint';
import { getPerf } from './perfReporter';
import { findSystemPython, spawnFakeRunserver, SpawnedProcess } from './testHelpers';

describe('Feature: process discovery', function () {
  const perf = getPerf();
  const finder = new DjangoProcessFinder();

  describe('pure classifiers', function () {
    it('classifies runserver as django', function () {
      assert.strictEqual(
        finder.classifyProcess('python /app/manage.py runserver 0.0.0.0:8000'),
        'django',
      );
    });

    it('classifies uvicorn asgi as django', function () {
      assert.strictEqual(
        finder.classifyProcess('uvicorn myapp.asgi:application --port 8001'),
        'django',
      );
    });

    it('classifies gunicorn wsgi as django', function () {
      assert.strictEqual(
        finder.classifyProcess('gunicorn myapp.wsgi:application -b 0.0.0.0:8002'),
        'django',
      );
    });

    it('classifies daphne asgi as django', function () {
      assert.strictEqual(
        finder.classifyProcess('daphne myapp.asgi:application -p 8003'),
        'django',
      );
    });

    it('classifies celery worker as celery', function () {
      assert.strictEqual(
        finder.classifyProcess('python -m celery worker -A myapp'),
        'celery',
      );
      assert.strictEqual(
        finder.classifyProcess('celery -A myapp worker --loglevel=info'),
        'celery',
      );
    });

    it('returns null for tools and language servers', function () {
      for (const line of [
        'python -m pip install something',
        'python -m pytest tests/',
        'jedi-language-server',
        'pylance --stdio',
        '/usr/bin/vim',
      ]) {
        assert.strictEqual(finder.classifyProcess(line), null, `should be null: ${line}`);
      }
    });
  });

  describe('port extraction', function () {
    const cases: Array<[string, number | undefined]> = [
      ['python manage.py runserver 8080', 8080],
      ['python manage.py runserver 0.0.0.0:8000', 8000],
      ['python manage.py runserver 127.0.0.1:9090', 9090],
      ['uvicorn app.asgi:application --host 0.0.0.0 --port 8001', 8001],
      ['gunicorn app.wsgi:application -b :8002', 8002],
      ['gunicorn app.wsgi:application --bind 0.0.0.0:8003', 8003],
      ['daphne app.asgi:application -p 8004', 8004],
      ['daphne --port 8005 app.asgi:application', 8005],
      ['python -m celery worker', undefined],
    ];
    for (const [cmd, expected] of cases) {
      it(`extracts port ${expected} from: ${cmd}`, function () {
        assert.strictEqual(finder.extractPortFromCommand(cmd), expected);
      });
    }
  });

  describe('endpoint extraction', function () {
    const cases: Array<[string, { host: string; port: number } | undefined]> = [
      ['python manage.py runserver 8080', { host: '127.0.0.1', port: 8080 }],
      ['python manage.py runserver 0.0.0.0:8000', { host: '127.0.0.1', port: 8000 }],
      ['python manage.py runserver 127.83.116.219:9090', { host: '127.83.116.219', port: 9090 }],
      ['uvicorn app.asgi:application --host 127.83.116.219 --port 8001', { host: '127.83.116.219', port: 8001 }],
      ['gunicorn app.wsgi:application -b :8002', { host: '127.0.0.1', port: 8002 }],
      ['gunicorn app.wsgi:application --bind 127.83.116.219:8003', { host: '127.83.116.219', port: 8003 }],
      ['daphne -b 127.83.116.219 -p 8004 app.asgi:application', { host: '127.83.116.219', port: 8004 }],
      ['python -m celery worker', undefined],
    ];
    for (const [cmd, expected] of cases) {
      it(`extracts endpoint ${expected ? `${expected.host}:${expected.port}` : 'undefined'} from: ${cmd}`, function () {
        assert.deepStrictEqual(finder.extractEndpointFromCommand(cmd), expected);
      });
    }
  });

  describe('lsof listen parsing', function () {
    it('parses macOS loopback aliases with LISTEN state', function () {
      const endpoint = parseLsofTcpListenLine(
        'python3.1 26422 lky 3u IPv4 0x704380322b7c396d 0t0 TCP 127.83.116.219:53343 (LISTEN)',
      );
      assert.deepStrictEqual(endpoint, { host: '127.83.116.219', port: 53343 });
    });

    it('normalizes wildcard listeners to a connectable localhost address', function () {
      const endpoint = parseLsofTcpListenLine(
        'Python 123 lky 3u IPv4 0x0 0t0 TCP *:8000 (LISTEN)',
      );
      assert.deepStrictEqual(endpoint, { host: '127.0.0.1', port: 8000 });
    });

    it('parses bracketed IPv6 listeners', function () {
      const endpoint = parseLsofTcpListenLine(
        'Python 123 lky 3u IPv6 0x0 0t0 TCP [::1]:5678 (LISTEN)',
      );
      assert.deepStrictEqual(endpoint, { host: '::1', port: 5678 });
    });
  });

  describe('loopback alias merging', function () {
    it('adds non-Django 127.x listeners on the same port as selectable endpoints', function () {
      const processes: DjangoProcess[] = [{
        pid: 101,
        command: 'python manage.py runserver 8004',
        pythonPath: 'python',
        arch: process.arch,
        type: 'django',
        host: '127.1.0.1',
        port: 8004,
        endpoints: [{ host: '127.1.0.1', port: 8004 }],
      }];

      mergeLoopbackAliasEndpoints(processes, new Map([
        [8004, [
          { pid: 202, endpoint: { host: '127.135.15.126', port: 8004 } },
        ]],
      ]));

      assert.deepStrictEqual(processes[0].endpoints, [
        { host: '127.1.0.1', port: 8004 },
        { host: '127.135.15.126', port: 8004 },
      ]);
    });

    it('does not mix endpoints owned by another discovered Django process', function () {
      const processes: DjangoProcess[] = [
        {
          pid: 101,
          command: 'python manage.py runserver 127.1.0.1:8004',
          pythonPath: 'python',
          arch: process.arch,
          type: 'django',
          host: '127.1.0.1',
          port: 8004,
          endpoints: [{ host: '127.1.0.1', port: 8004 }],
        },
        {
          pid: 202,
          command: 'python manage.py runserver 127.97.194.31:8004',
          pythonPath: 'python',
          arch: process.arch,
          type: 'django',
          host: '127.97.194.31',
          port: 8004,
          endpoints: [{ host: '127.97.194.31', port: 8004 }],
        },
      ];

      mergeLoopbackAliasEndpoints(processes, new Map([
        [8004, [
          { pid: 202, endpoint: { host: '127.97.194.31', port: 8004 } },
          { pid: 303, endpoint: { host: '127.135.15.126', port: 8004 } },
        ]],
      ]));

      assert.deepStrictEqual(processes[0].endpoints, [
        { host: '127.1.0.1', port: 8004 },
        { host: '127.135.15.126', port: 8004 },
      ]);
      assert.deepStrictEqual(processes[1].endpoints, [
        { host: '127.97.194.31', port: 8004 },
        { host: '127.135.15.126', port: 8004 },
      ]);
    });
  });

  describe('live ps integration', function () {
    let fake: SpawnedProcess | null = null;
    const port = 49871;
    let pythonBin: string | null;

    before(async function () {
      this.timeout(15_000);
      pythonBin = await findSystemPython();
      if (!pythonBin) {
        this.skip();
        return;
      }
      fake = await spawnFakeRunserver(pythonBin, port);
    });

    after(async function () {
      if (fake) {
        await fake.stop();
      }
    });

    it('finds the fake runserver via ps aux', async function () {
      if (!fake) { this.skip(); return; }
      this.timeout(10_000);

      const results = await perf.measure('findDjangoProcesses (live)', async () =>
        finder.findDjangoProcesses(),
      { group: 'processFinder', meta: { port } });

      const mine = results.find((p) => p.pid === fake!.pid);
      assert.ok(mine, `spawned pid ${fake!.pid} not found in results (found: ${results.map((r) => r.pid).join(',')})`);
      assert.strictEqual(mine.type, 'django');
      assert.ok(mine.host, 'host should be detected or inferred');
      assert.strictEqual(mine.port, port);
    });

    it('resolveDebuggablePid returns the same pid for a leaf process', async function () {
      if (!fake) { this.skip(); return; }
      this.timeout(10_000);

      const resolved = await perf.measure('resolveDebuggablePid (leaf)', async () =>
        finder.resolveDebuggablePid(fake!.pid),
      { group: 'processFinder' });

      assert.strictEqual(resolved.pid, fake!.pid);
      assert.ok(resolved.pythonPath.includes('python'));
    });
  });
});
