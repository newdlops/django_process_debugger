import * as assert from 'assert';
import { describe, it, before, after } from 'mocha';
import {
  buildPortManagerDjangoProcesses,
  collectPortManagerCeleryScanRoots,
  DjangoProcess,
  DjangoProcessFinder,
  filterShadowedCommandDerivedDjangoProcesses,
  isCeleryWorkerCommand,
  isIpv4LoopbackEndpoint,
  isLoopbackEndpoint,
  isCurrentBootstrapRecoveryState,
  mergeLoopbackAliasEndpoints,
  parsePortManagerNetworkNamesTsv,
} from '../../processFinder';
import { parseLsofTcpListenLine } from '../../listeningEndpoint';
import { BOOTSTRAP_VERSION } from '../../debugpyInjector';
import { getPerf } from './perfReporter';
import {
  allocateLoopbackPort,
  findSystemPython,
  spawnFakeRunserver,
  SpawnedProcess,
} from './testHelpers';

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

    it('recognizes absolute worktree, module, and console runserver forms', function () {
      for (const command of [
        'python /worktree/app/manage.py runserver 8000',
        'python -m django runserver 8000',
        '/worktree/.venv/bin/django-admin runserver 8000',
      ]) {
        assert.strictEqual(finder.classifyProcess(command), 'django', command);
      }
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
      assert.strictEqual(
        finder.classifyProcess('uv run celery multi start 1 --pidfile=.celery/%n.pid --logfile=.celery/celery.log'),
        'celery',
      );
      assert.strictEqual(
        finder.classifyProcess('/app/.venv/bin/celeryd --loglevel=info'),
        'celery',
      );
    });

    it('recognizes celery command variants without matching worker names alone', function () {
      assert.strictEqual(
        isCeleryWorkerCommand('/app/.venv/bin/python -m celery -A zuzu.worker worker --loglevel=INFO'),
        true,
      );
      assert.strictEqual(
        isCeleryWorkerCommand('/app/.venv/bin/celery -A zuzu.worker multi start 1 --pidfile=.celery/%n.pid'),
        true,
      );
      assert.strictEqual(
        isCeleryWorkerCommand('redis-server *:6379 # redis-worker'),
        false,
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

  describe('bootstrap-state recovery validation', function () {
    const pid = 4242;
    const socket = `/tmp/django-process-debugger/${pid}.control.sock`;
    const current = {
      pid,
      version: BOOTSTRAP_VERSION,
      activationVersion: 2,
      pythonExecutable: '/worktree/.venv/bin/python',
      runtimeId: 'a'.repeat(64),
      controlSocket: socket,
    };

    it('accepts only current PID-bound private state shape', function () {
      assert.strictEqual(isCurrentBootstrapRecoveryState(current, pid, socket), true);
      assert.strictEqual(isCurrentBootstrapRecoveryState({ ...current, version: 'old' }, pid, socket), false);
      assert.strictEqual(isCurrentBootstrapRecoveryState({ ...current, pid: 9 }, pid, socket), false);
      assert.strictEqual(isCurrentBootstrapRecoveryState({ ...current, controlSocket: '/tmp/spoof.sock' }, pid, socket), false);
      assert.strictEqual(isCurrentBootstrapRecoveryState({ ...current, runtimeId: 'spoofed' }, pid, socket), false);
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

  describe('loopback endpoint detection', function () {
    it('includes portmanager public listeners on 127.0.0.1', function () {
      assert.strictEqual(isIpv4LoopbackEndpoint({ host: '127.0.0.1', port: 8004 }), true);
      assert.strictEqual(isIpv4LoopbackEndpoint({ host: '127.125.100.191', port: 8004 }), true);
      assert.strictEqual(isIpv4LoopbackEndpoint({ host: '::1', port: 8004 }), false);
      assert.strictEqual(isLoopbackEndpoint({ host: '::1', port: 8004 }), true);
      assert.strictEqual(isLoopbackEndpoint({ host: '::ffff:127.0.0.1', port: 8004 }), true);
    });
  });

  describe('loopback alias merging', function () {
    it('adds portmanager 127.0.0.1 listeners on the same port as selectable endpoints', function () {
      const processes: DjangoProcess[] = [{
        pid: 101,
        command: 'python manage.py runserver 8004',
        pythonPath: 'python',
        arch: process.arch,
        type: 'django',
        host: '127.103.218.122',
        port: 8004,
        endpoints: [{ host: '127.103.218.122', port: 8004 }],
      }];

      mergeLoopbackAliasEndpoints(processes, new Map([
        [8004, [
          { pid: 5950, endpoint: { host: '127.0.0.1', port: 8004 } },
        ]],
      ]));

      assert.deepStrictEqual(processes[0].endpoints, [
        { host: '127.103.218.122', port: 8004 },
        { host: '127.0.0.1', port: 8004 },
      ]);
    });

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

    it('does not spread an ambiguously owned relay alias across Django processes', function () {
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
      ]);
      assert.deepStrictEqual(processes[1].endpoints, [
        { host: '127.97.194.31', port: 8004 },
      ]);
    });
  });

  describe('verified endpoint shadowing', function () {
    const processInfo = (
      pid: number,
      cwd: string,
      port: number,
      endpointVerified: boolean,
    ): DjangoProcess => ({
      pid,
      command: `python manage.py runserver ${port}`,
      pythonPath: 'python',
      arch: process.arch,
      type: 'django',
      cwd,
      port,
      endpoints: [{ host: endpointVerified ? '127.92.67.173' : '127.0.0.1', port }],
      endpointVerified,
    });

    it('keeps the verified Port Manager listener instead of a same-project command fallback', function () {
      const commandFallback = processInfo(27048, '/repo/captain/./', 8004, false);
      const portManagerListener = processInfo(27086, '/repo/captain', 8004, true);

      const filtered = filterShadowedCommandDerivedDjangoProcesses([
        commandFallback,
        portManagerListener,
      ]);

      assert.deepStrictEqual(filtered.map((candidate) => candidate.pid), [27086]);
    });

    it('keeps unverified candidates from another cwd or an unshadowed port', function () {
      const verified = processInfo(27086, '/repo/captain', 8004, true);
      const otherProject = processInfo(2909, '/repo/rtcc', 8004, false);
      const otherPort = processInfo(27048, '/repo/captain', 8010, false);

      const filtered = filterShadowedCommandDerivedDjangoProcesses([
        verified,
        otherProject,
        otherPort,
      ]);

      assert.deepStrictEqual(filtered.map((candidate) => candidate.pid), [27086, 2909, 27048]);
    });

    it('keeps a multi-port fallback while any advertised port remains unshadowed', function () {
      const verified = processInfo(27086, '/repo/captain', 8004, true);
      const partlyShadowed = processInfo(27048, '/repo/captain', 8004, false);
      partlyShadowed.endpoints?.push({ host: '127.0.0.1', port: 8005 });

      const filtered = filterShadowedCommandDerivedDjangoProcesses([
        verified,
        partlyShadowed,
      ]);

      assert.deepStrictEqual(filtered.map((candidate) => candidate.pid), [27086, 27048]);
    });
  });

  describe('Port Manager network registry parsing', function () {
    it('reads bounded network id/name rows and ignores malformed or duplicate entries', function () {
      const names = parsePortManagerNetworkNamesTsv([
        'network-alpha\talphac\textra-field',
        'network-beta\tbetac\r',
        'network-alpha\treplaced-name',
        'unsafe id\tignored',
        'network-gamma\tunsafe name',
        'missing-tab',
      ].join('\n'));

      assert.deepStrictEqual([...names], [
        ['network-alpha', 'alphac'],
        ['network-beta', 'betac'],
      ]);
    });

    it('rejects an oversized registry instead of parsing a prefix', function () {
      const names = parsePortManagerNetworkNamesTsv(
        `network-alpha\talphac\n${'x'.repeat(256 * 1024)}`,
      );

      assert.strictEqual(names.size, 0);
    });
  });

  describe('portmanager snapshot discovery', function () {
    it('creates Django candidates from hooked python routes with shortened commands', function () {
      const processes = buildPortManagerDjangoProcesses({
        processes: [{
          id: 'managed-process-58',
          pid: 8288,
          name: 'python3',
          command: 'python3',
          cwd: '/Users/lky/project/app',
          networkId: 'network-alpha',
          terminalSessionId: 'pm-terminal-alpha',
          processGroupId: 1234,
          requestedPort: 8004,
          actualPort: 8004,
          status: 'running',
          url: 'http://127.103.218.122:8004',
          source: 'hooked',
        }],
        routes: [{
          logicalPort: 8004,
          actualPort: 8004,
          routeDirection: 'listen',
          host: '127.103.218.122',
          processId: 'managed-process-58',
          processName: 'python3',
          status: 'running',
          source: 'hooked',
        }],
        listeners: [{
          localAddress: '127.103.218.122',
          port: 8004,
          pid: 8288,
          processName: 'python3.11',
          command: 'python3.11',
        }],
      }, new Map([['network-alpha', 'alphac']]));

      assert.strictEqual(processes.length, 1);
      assert.strictEqual(processes[0].pid, 8288);
      assert.strictEqual(processes[0].type, 'django');
      assert.strictEqual(processes[0].pythonPath, 'python3');
      assert.strictEqual(processes[0].cwd, '/Users/lky/project/app');
      assert.strictEqual(processes[0].processGroupId, 1234);
      assert.strictEqual(processes[0].endpointVerified, true);
      assert.strictEqual(processes[0].networkId, 'network-alpha');
      assert.strictEqual(processes[0].networkName, 'alphac');
      assert.strictEqual(processes[0].terminalSessionId, 'pm-terminal-alpha');
      assert.strictEqual(processes[0].command, 'python3 (Port Manager, /Users/lky/project/app, :8004)');
      assert.deepStrictEqual(processes[0].endpoints, [
        { host: '127.103.218.122', port: 8004 },
      ]);
    });

    it('ignores detected router rows and non-python routes', function () {
      const processes = buildPortManagerDjangoProcesses({
        processes: [
          {
            id: 'detected-router',
            pid: 86587,
            name: 'portmanager_tcp_router',
            command: 'portmanager_tcp_router',
            requestedPort: 8004,
            actualPort: 8004,
            status: 'running',
            source: 'detected',
          },
          {
            id: 'managed-node',
            pid: 41484,
            name: 'node',
            command: 'node',
            requestedPort: 3004,
            actualPort: 3004,
            status: 'running',
            source: 'hooked',
          },
          {
            id: 'managed-redis-worker',
            pid: 41485,
            name: 'redis-worker',
            command: 'redis-server *:6379',
            requestedPort: 6379,
            actualPort: 6379,
            status: 'running',
            source: 'hooked',
          },
          {
            id: 'debugpy-adapter',
            pid: 72506,
            name: 'python3',
            command: '/repo/.venv/bin/python3 /extension/debugpy/debugpy/adapter --for-server 53451 --host 127.0.0.1 --port 53449 --server-access-token token',
            requestedPort: 53449,
            actualPort: 53449,
            status: 'running',
            source: 'hooked',
          },
        ],
        routes: [
          {
            logicalPort: 8004,
            actualPort: 8004,
            routeDirection: 'listen',
            host: '127.0.0.1',
            processId: 'detected-router',
            processName: 'portmanager_tcp_router',
            status: 'running',
          },
          {
            logicalPort: 3004,
            actualPort: 3004,
            routeDirection: 'listen',
            host: '127.0.0.1',
            processId: 'managed-node',
            processName: 'node',
            status: 'running',
          },
          {
            logicalPort: 6379,
            actualPort: 6379,
            routeDirection: 'listen',
            host: '127.0.0.1',
            processId: 'managed-redis-worker',
            processName: 'redis-worker',
            status: 'running',
          },
          {
            logicalPort: 53449,
            actualPort: 53449,
            routeDirection: 'listen',
            host: '127.0.0.1',
            processId: 'debugpy-adapter',
            processName: 'python3',
            status: 'running',
          },
        ],
      });

      assert.deepStrictEqual(processes, []);
    });

    it('collects celery pidfile scan roots from running managed cwd rows', function () {
      const roots = collectPortManagerCeleryScanRoots({
        processes: [
          {
            cwd: '/repo',
            status: 'running',
            source: 'hooked',
          },
          {
            cwd: '/repo/docker',
            status: 'running',
            source: 'hooked',
          },
          {
            cwd: '/repo/zuzu/client',
            status: 'running',
            source: 'hooked',
          },
          {
            cwd: '/ignored/stopped',
            status: 'stopped',
            source: 'hooked',
          },
          {
            cwd: '/ignored/detected',
            status: 'running',
            source: 'detected',
          },
          {
            command: '/repo/.venv/bin/python3 /extension/debugpy/debugpy/adapter --for-server 53451 --server-access-token token',
            cwd: '/ignored/debugpy',
            status: 'running',
            source: 'hooked',
          },
        ],
      });

      assert.deepStrictEqual(roots, [
        '/repo',
        '/repo/docker',
        '/repo/zuzu/client',
      ]);
    });

    it('merges multiple running routes owned by the same python pid', function () {
      const processes = buildPortManagerDjangoProcesses({
        processes: [{
          id: 'managed-python',
          pid: 9001,
          name: 'python3.11',
          command: 'python3.11',
          cwd: '/app',
          requestedPort: 8004,
          actualPort: 8004,
          status: 'running',
          source: 'hooked',
        }],
        routes: [
          {
            logicalPort: 8004,
            actualPort: 8004,
            routeDirection: 'listen',
            host: '127.10.0.1',
            processId: 'managed-python',
            processName: 'python3.11',
            status: 'running',
          },
          {
            logicalPort: 8005,
            actualPort: 8005,
            routeDirection: 'listen',
            host: '127.10.0.1',
            processId: 'managed-python',
            processName: 'python3.11',
            status: 'running',
          },
        ],
      });

      assert.strictEqual(processes.length, 1);
      assert.deepStrictEqual(processes[0].endpoints, [
        { host: '127.10.0.1', port: 8004 },
        { host: '127.10.0.1', port: 8005 },
      ]);
    });

    it('collects worker pids from the same execution scope and port', function () {
      const processes = buildPortManagerDjangoProcesses({
        processes: [
          {
            id: 'managed-owner',
            pid: 1001,
            name: 'python3',
            command: 'python3',
            cwd: '/app',
            networkId: 'network-1',
            terminalSessionId: 'terminal-1',
            processGroupId: 7001,
            requestedPort: 8004,
            actualPort: 8004,
            status: 'running',
            source: 'hooked',
          },
          {
            id: 'managed-worker',
            pid: 1002,
            name: 'python3',
            command: 'python3',
            cwd: '/app',
            networkId: 'network-1',
            terminalSessionId: 'terminal-1',
            processGroupId: 7001,
            requestedPort: 8004,
            actualPort: 8004,
            status: 'running',
            source: 'hooked',
          },
          {
            id: 'other-port',
            pid: 1003,
            name: 'python3',
            command: 'python3',
            cwd: '/app',
            networkId: 'network-1',
            terminalSessionId: 'terminal-1',
            processGroupId: 7001,
            requestedPort: 8005,
            actualPort: 8005,
            status: 'running',
            source: 'hooked',
          },
        ],
        routes: [{
          logicalPort: 8004,
          actualPort: 8004,
          routeDirection: 'listen',
          host: '127.10.0.1',
          processId: 'managed-owner',
          processName: 'python3',
          status: 'running',
        }],
        listeners: [
          {
            localAddress: '127.10.0.1',
            port: 8004,
            pid: 1004,
            processName: 'python3.11',
            command: 'python3.11',
          },
          {
            localAddress: '127.10.0.1',
            port: 8005,
            pid: 1005,
            processName: 'python3.11',
            command: 'python3.11',
          },
        ],
      });

      assert.strictEqual(processes.length, 1);
      assert.deepStrictEqual(processes[0].workerPids, [1002, 1004]);
    });
  });

  describe('live ps integration', function () {
    let fake: SpawnedProcess | null = null;
    let port = 0;
    let pythonBin: string | null;

    before(async function () {
      this.timeout(15_000);
      pythonBin = await findSystemPython();
      if (!pythonBin) {
        this.skip();
        return;
      }
      port = await allocateLoopbackPort();
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
