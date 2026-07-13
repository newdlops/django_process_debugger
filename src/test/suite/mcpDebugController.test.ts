import * as assert from 'assert';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import {
  DJANGO_MCP_SESSION_REF_CONFIG_KEY,
  DjangoMcpDebugController,
  DjangoProcessFinderLike,
  McpToolCallResult,
} from '../../mcp/debugController';
import { DjangoProcess } from '../../processFinder';

const fixturesRoot = path.resolve(__dirname, '../../../src/test/fixtures');

function fixtureFolder(): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.file(fixturesRoot),
    name: 'fixtures',
    index: 0,
  };
}

function success(result: McpToolCallResult): Record<string, unknown> {
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  return result as Record<string, unknown>;
}

function failureCode(result: McpToolCallResult): string {
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  return (result as { ok: false; error: { code: string } }).error.code;
}

function mockSession(
  id: string,
  configuration: vscode.DebugConfiguration,
  customRequest: (command: string, args?: unknown) => Promise<unknown>,
  getDebugProtocolBreakpoint: vscode.DebugSession['getDebugProtocolBreakpoint'] = async () => undefined,
  folder: vscode.WorkspaceFolder = fixtureFolder(),
): vscode.DebugSession {
  return {
    id,
    type: 'django-process',
    name: configuration.name ?? 'Django via MCP',
    workspaceFolder: folder,
    configuration,
    customRequest,
    getDebugProtocolBreakpoint,
  };
}

describe('Feature: window-scoped Django MCP debug controller', function () {
  it('issues workspace-scoped target refs and starts only through django-process', async function () {
    const folder = fixtureFolder();
    const processInfo: DjangoProcess = {
      pid: 100,
      command: 'python -m celery -A sample worker',
      pythonPath: 'python',
      arch: process.arch,
      type: 'celery',
      cwd: fixturesRoot,
      workerPids: [201, 202],
      endpoints: [{ host: '127.0.0.1', port: 8000 }],
      endpointVerified: true,
      networkId: 'internal-network-uuid',
      networkName: 'alphac',
      terminalSessionId: 'internal-terminal-session',
    };
    const outside: DjangoProcess = {
      ...processInfo,
      pid: 999,
      cwd: path.dirname(fixturesRoot),
      workerPids: undefined,
    };
    const djangoProcesses: DjangoProcess[] = [true, false].map((endpointVerified, index) => ({
      ...processInfo,
      pid: 300 + index,
      command: 'python manage.py runserver',
      type: 'django',
      workerPids: undefined,
      endpointVerified,
      networkName: index === 0 ? 'alphac' : 'betac',
    }));
    const resolvedInputs: number[] = [];
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() {
        return [processInfo, ...djangoProcesses, outside];
      },
      async resolveDebuggablePid(pid) {
        resolvedInputs.push(pid);
        return { pid: pid + 1_000, pythonPath: '/venv/bin/python' };
      },
    };
    let startedFolder: vscode.WorkspaceFolder | undefined;
    let startedConfiguration: vscode.DebugConfiguration | undefined;
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [folder],
      getEngine: () => 'experimental',
      getJustMyCode: () => false,
      getRedirectOutput: () => false,
      startDebugging: async (workspaceFolder, configuration) => {
        startedFolder = workspaceFolder;
        startedConfiguration = configuration;
        return true;
      },
    });

    const listed = success(await controller.callTool('django_targets_list', {}));
    const targets = listed.targets as Array<Record<string, unknown>>;
    assert.strictEqual(targets.length, 4);
    assert.deepStrictEqual(resolvedInputs, [201, 202, 300, 301]);
    assert.strictEqual(listed.excludedOutsideWorkspace, 1);
    assert.match(targets[0].targetRef as string, /^target_[a-f0-9]{32}$/);
    assert.strictEqual(targets[0].network, 'alphac');
    assert.strictEqual('servesTraffic' in targets[0], false);
    assert.strictEqual(targets[2].network, 'alphac');
    assert.strictEqual(targets[2].servesTraffic, true);
    assert.strictEqual(targets[3].network, 'betac');
    assert.strictEqual(targets[3].servesTraffic, false);
    const serializedTargets = JSON.stringify(targets);
    assert.strictEqual(serializedTargets.includes('"pid"'), false);
    assert.strictEqual(serializedTargets.includes('networkId'), false);
    assert.strictEqual(serializedTargets.includes('terminalSessionId'), false);
    assert.strictEqual(serializedTargets.includes('internal-network-uuid'), false);
    assert.strictEqual(serializedTargets.includes('internal-terminal-session'), false);

    const started = success(await controller.callTool('django_session_start', {
      targetRef: targets[0].targetRef,
    }));
    assert.match(started.sessionRef as string, /^session_[a-f0-9]{32}$/);
    assert.strictEqual(started.cursor, 1);
    assert.strictEqual(startedFolder, folder);
    assert.strictEqual(startedConfiguration?.type, 'django-process');
    assert.strictEqual(startedConfiguration?.request, 'attach');
    assert.strictEqual(startedConfiguration?.pid, 1_201);
    assert.strictEqual(startedConfiguration?.port, 0);
    assert.strictEqual(startedConfiguration?.engine, 'experimental');
    assert.strictEqual(startedConfiguration?.justMyCode, false);
    assert.strictEqual(startedConfiguration?.redirectOutput, false);
    assert.strictEqual(
      startedConfiguration?.[DJANGO_MCP_SESSION_REF_CONFIG_KEY],
      started.sessionRef,
    );

    const rawPidAttempt = await controller.callTool('django_session_start', {
      targetRef: targets[1].targetRef,
      pid: 202,
    });
    assert.strictEqual(failureCode(rawPidAttempt), 'INVALID_ARGUMENT');
  });

  it('expires target capabilities without accepting a stale reference', async function () {
    let now = 1_000;
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() {
        return [{
          pid: 100,
          command: 'python manage.py runserver',
          pythonPath: 'python',
          arch: process.arch,
          type: 'django',
          cwd: fixturesRoot,
        }];
      },
      async resolveDebuggablePid(pid) {
        return { pid, pythonPath: 'python' };
      },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      targetTtlMs: 100,
      now: () => now,
      startDebugging: async () => true,
    });
    const listed = success(await controller.callTool('django_targets_list', {}));
    const targetRef = (listed.targets as Array<Record<string, unknown>>)[0].targetRef;
    now += 101;
    const expired = await controller.callTool('django_session_start', { targetRef });
    assert.strictEqual(failureCode(expired), 'TARGET_EXPIRED');
  });

  it('terminates an MCP session immediately when DAP attach is rejected before ready', async function () {
    const processInfo: DjangoProcess = {
      pid: 401,
      command: 'python manage.py runserver',
      pythonPath: 'python',
      arch: process.arch,
      type: 'django',
      cwd: fixturesRoot,
    };
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return [processInfo]; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    let failedSession!: vscode.DebugSession;
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      startDebugging: async (_folder, configuration) => {
        failedSession = mockSession('pre-start-attach-failure', configuration, async () => ({}));
        controller.handleDapMessage(failedSession, {
          type: 'response',
          command: 'initialize',
          success: true,
        });
        controller.handleDapMessage(failedSession, {
          type: 'response',
          command: 'attach',
          success: false,
        });
        return true;
      },
    });

    const listed = success(await controller.callTool('django_targets_list', {}));
    const targetRef = (listed.targets as Array<Record<string, unknown>>)[0].targetRef;
    const started = success(await controller.callTool('django_session_start', { targetRef }));
    assert.strictEqual(started.state, 'terminated');

    const ready = success(await controller.callTool('django_session_wait_ready', {
      sessionRef: started.sessionRef,
      timeoutMs: 10_000,
    }));
    assert.strictEqual(ready.ready, false);
    assert.strictEqual(ready.terminated, true);
    assert.strictEqual(ready.timedOut, false);

    // Late lifecycle delivery must not move the failed session back to running.
    controller.handleSessionStarted(failedSession);
    controller.handleDapMessage(failedSession, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'late-breakpoint', threadId: 99 },
    });
    const afterLateStart = success(await controller.callTool('django_session_wait_ready', {
      sessionRef: started.sessionRef,
      timeoutMs: 0,
    }));
    assert.strictEqual(afterLateStart.state, 'terminated');
  });

  it('removes reentrantly bound MCP indexes when VS Code rejects or throws during start', async function () {
    for (const outcome of ['false', 'throw'] as const) {
      const processInfo: DjangoProcess = {
        pid: outcome === 'false' ? 402 : 403,
        command: 'python manage.py runserver',
        pythonPath: 'python',
        arch: process.arch,
        type: 'django',
        cwd: fixturesRoot,
      };
      const finder: DjangoProcessFinderLike = {
        async findDjangoProcesses() { return [processInfo]; },
        async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
      };
      let reentrantSession!: vscode.DebugSession;
      let rejectedWaiterNotified = false;
      const controller = new DjangoMcpDebugController({
        processFinder: finder,
        getWorkspaceFolders: () => [fixtureFolder()],
        startDebugging: async (_folder, configuration) => {
          reentrantSession = mockSession(`reentrant-${outcome}`, configuration, async () => ({}));
          controller.handleDapMessage(reentrantSession, {
            type: 'response',
            command: 'initialize',
            success: true,
          });
          controller.handleDapMessage(reentrantSession, {
            type: 'event',
            event: 'stopped',
            body: { reason: 'reentrant-breakpoint', threadId: 7 },
          });
          const boundRecord = [...(controller as unknown as {
            sessionsById: Map<string, { waiters: Set<() => void> }>;
          }).sessionsById.values()][0];
          assert.ok(boundRecord);
          boundRecord.waiters.add(() => { rejectedWaiterNotified = true; });
          if (outcome === 'throw') {
            throw new Error('synthetic VS Code rejection');
          }
          return false;
        },
      });

      const listed = success(await controller.callTool('django_targets_list', {}));
      const targetRef = (listed.targets as Array<Record<string, unknown>>)[0].targetRef;
      const rejected = await controller.callTool('django_session_start', { targetRef });
      assert.strictEqual(
        failureCode(rejected),
        outcome === 'throw' ? 'SESSION_START_FAILED' : 'SESSION_START_REJECTED',
      );
      const internals = controller as unknown as {
        sessions: Map<string, unknown>;
        sessionsById: Map<string, unknown>;
        stops: Map<string, unknown>;
        frames: Map<string, unknown>;
        variables: Map<string, unknown>;
      };
      assert.strictEqual(internals.sessions.size, 0);
      assert.strictEqual(internals.sessionsById.size, 0);
      assert.strictEqual(internals.stops.size, 0);
      assert.strictEqual(internals.frames.size, 0);
      assert.strictEqual(internals.variables.size, 0);
      assert.strictEqual(rejectedWaiterNotified, true);
      controller.handleDapMessage(reentrantSession, {
        type: 'event',
        event: 'stopped',
        body: { reason: 'late-breakpoint', threadId: 99 },
      });
      assert.strictEqual(internals.sessions.size, 0);
      assert.strictEqual(internals.sessionsById.size, 0);
      assert.strictEqual(internals.stops.size, 0);
    }
  });

  it('consumes target refs atomically and revalidates workspace identity before attach', async function () {
    const processInfo: DjangoProcess = {
      pid: 411,
      command: 'python manage.py runserver',
      pythonPath: 'python',
      arch: process.arch,
      type: 'django',
      cwd: fixturesRoot,
    };
    let discoveryCalls = 0;
    let releaseRevalidation: ((processes: DjangoProcess[]) => void) | undefined;
    const revalidation = new Promise<DjangoProcess[]>((resolve) => {
      releaseRevalidation = resolve;
    });
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() {
        discoveryCalls++;
        return discoveryCalls === 1 ? [processInfo] : revalidation;
      },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    let starts = 0;
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      startDebugging: async () => { starts++; return true; },
    });
    const listed = success(await controller.callTool('django_targets_list', {}));
    const targetRef = (listed.targets as Array<Record<string, unknown>>)[0].targetRef;
    const first = controller.callTool('django_session_start', { targetRef });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(failureCode(await controller.callTool('django_session_start', {
      targetRef,
    })), 'TARGET_NOT_FOUND');
    releaseRevalidation!([processInfo]);
    success(await first);
    assert.strictEqual(starts, 1);
  });

  it('rejects a target that changes cwd before attach', async function () {
    let processInfo: DjangoProcess = {
      pid: 412,
      command: 'python manage.py runserver',
      pythonPath: 'python',
      arch: process.arch,
      type: 'django',
      cwd: fixturesRoot,
    };
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return [processInfo]; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    let started = false;
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      startDebugging: async () => { started = true; return true; },
    });
    const listed = success(await controller.callTool('django_targets_list', {}));
    const targetRef = (listed.targets as Array<Record<string, unknown>>)[0].targetRef;
    processInfo = { ...processInfo, cwd: path.dirname(fixturesRoot) };
    assert.strictEqual(failureCode(await controller.callTool('django_session_start', {
      targetRef,
    })), 'TARGET_CHANGED');
    assert.strictEqual(started, false);
  });

  it('rejects verified targets when their route or listener identity changes', async function () {
    const scenarios: Array<{
      name: string;
      mutate(processInfo: DjangoProcess): void;
    }> = [
      {
        name: 'traffic ownership is no longer verified',
        mutate(processInfo) { processInfo.endpointVerified = false; },
      },
      {
        name: 'network identity changes',
        mutate(processInfo) { processInfo.networkId = 'network-b'; },
      },
      {
        name: 'listener port changes',
        mutate(processInfo) {
          processInfo.endpoints = [{ host: '127.92.0.1', port: 8005 }];
        },
      },
    ];

    for (const scenario of scenarios) {
      const processInfo: DjangoProcess = {
        pid: 413,
        command: 'python manage.py runserver',
        pythonPath: 'python',
        arch: process.arch,
        type: 'django',
        cwd: fixturesRoot,
        endpoints: [{ host: '127.92.0.1', port: 8004 }],
        endpointVerified: true,
        networkId: 'network-a',
        networkName: 'alphac',
        terminalSessionId: 'terminal-a',
      };
      const finder: DjangoProcessFinderLike = {
        async findDjangoProcesses() { return [processInfo]; },
        async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
      };
      let starts = 0;
      const controller = new DjangoMcpDebugController({
        processFinder: finder,
        getWorkspaceFolders: () => [fixtureFolder()],
        startDebugging: async () => { starts++; return true; },
      });
      const listed = success(await controller.callTool('django_targets_list', {}));
      const targetRef = (listed.targets as Array<Record<string, unknown>>)[0].targetRef;

      scenario.mutate(processInfo);

      const result = await controller.callTool('django_session_start', { targetRef });
      assert.strictEqual(
        failureCode(result),
        'TARGET_CHANGED',
        `${scenario.name}: ${JSON.stringify(result)}`,
      );
      assert.strictEqual(starts, 0, scenario.name);
    }
  });

  it('snapshots stopped state with opaque refs and invalidates variables on resume', async function () {
    const requests: Array<{ command: string; args?: unknown }> = [];
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    const session = mockSession(
      'debug-session-1',
      { type: 'django-process', request: 'attach', name: 'test', engine: 'debugpy' },
      async (command, args) => {
        requests.push({ command, args });
        switch (command) {
          case 'threads':
            return { threads: [{ id: 7, name: 'MainThread' }] };
          case 'stackTrace':
            return {
              stackFrames: [{
                id: 41,
                name: 'sample_view',
                line: 3,
                column: 1,
                source: {
                  name: 'views.py',
                  path: path.join(fixturesRoot, 'sampleapp/views.py'),
                },
              }],
              totalFrames: 1,
            };
          case 'scopes':
            return {
              scopes: [{
                name: 'Locals',
                variablesReference: 55,
                expensive: false,
                namedVariables: 1,
              }],
            };
          case 'variables': {
            const request = args as { variablesReference: number };
            return request.variablesReference === 55
              ? {
                variables: [{
                  name: 'request',
                  value: '<WSGIRequest>',
                  type: 'WSGIRequest',
                  variablesReference: 66,
                  namedVariables: 1,
                }],
              }
              : {
                variables: [{
                  name: 'method',
                  value: "'GET'",
                  type: 'str',
                  variablesReference: 0,
                }],
              };
          }
          case 'exceptionInfo':
            return {
              exceptionId: 'ValueError',
              description: 'bad value',
              breakMode: 'always',
              details: { message: 'bad value', typeName: 'ValueError' },
            };
          case 'continue':
            return { allThreadsContinued: true };
          default:
            throw new Error(`Unexpected DAP command: ${command}`);
        }
      },
    );
    const sessionRef = controller.handleSessionStarted(session);
    assert.ok(sessionRef);
    controller.handleDapMessage(session, {
      type: 'event',
      event: 'stopped',
      body: {
        reason: 'exception',
        description: 'ValueError',
        threadId: 7,
        allThreadsStopped: true,
      },
    });

    const waited = success(await controller.callTool('django_execution_wait', {
      sessionRef,
      cursor: 0,
    }));
    const events = waited.events as Array<Record<string, unknown>>;
    const stopped = events.find((event) => event.event === 'stopped');
    assert.ok(stopped);
    assert.match(stopped.stopRef as string, /^stop_[a-f0-9]{32}$/);
    assert.strictEqual('threadId' in stopped, false);

    const snapshot = success(await controller.callTool('django_state_snapshot', {
      sessionRef,
      stopRef: stopped.stopRef,
      maxVariables: 10,
    }));
    const snapshotJson = JSON.stringify(snapshot);
    assert.strictEqual(snapshotJson.includes('threadId'), false);
    assert.strictEqual(snapshotJson.includes('frameId'), false);
    assert.strictEqual(snapshotJson.includes('variablesReference'), false);
    assert.match(snapshot.primaryFrameRef as string, /^frame_[a-f0-9]{32}$/);
    assert.deepStrictEqual(snapshot.exceptionInfo, {
      exceptionId: 'ValueError',
      description: 'bad value',
      breakMode: 'always',
      details: { message: 'bad value', typeName: 'ValueError' },
    });

    const scopes = snapshot.scopes as Array<Record<string, unknown>>;
    const topVariable = (scopes[0].variables as Array<Record<string, unknown>>)[0];
    const childRef = topVariable.variablesRef as string;
    assert.match(childRef, /^variables_[a-f0-9]{32}$/);
    const expanded = success(await controller.callTool('django_variables_expand', {
      variablesRef: childRef,
      start: 0,
      count: 5,
    }));
    assert.deepStrictEqual(expanded.variables, [{
      name: 'method',
      value: "'GET'",
      type: 'str',
    }]);

    const missingStopRef = await controller.callTool('django_execution_control', {
      sessionRef,
      action: 'continue',
    });
    assert.strictEqual(failureCode(missingStopRef), 'STOP_REF_REQUIRED');

    const continued = success(await controller.callTool('django_execution_control', {
      sessionRef,
      stopRef: stopped.stopRef,
      action: 'continue',
    }));
    assert.strictEqual(continued.state, 'running');
    assert.ok(requests.some((request) => request.command === 'continue'));
    const stale = await controller.callTool('django_variables_expand', {
      variablesRef: childRef,
    });
    assert.strictEqual(failureCode(stale), 'STALE_STOP');
  });

  it('serializes execution control and never overwrites a newer stop', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    let releaseContinue: (() => void) | undefined;
    const continueResponse = new Promise<void>((resolve) => { releaseContinue = resolve; });
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    const session = mockSession(
      'control-race-session',
      { type: 'django-process', request: 'attach', name: 'control-race' },
      async (command) => {
        assert.strictEqual(command, 'continue');
        await continueResponse;
        return { allThreadsContinued: true };
      },
    );
    const sessionRef = controller.handleSessionStarted(session)!;
    controller.handleDapMessage(session, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1 },
    });
    const firstEvents = success(await controller.callTool('django_execution_wait', {
      sessionRef,
      cursor: 0,
    })).events as Array<Record<string, unknown>>;
    const firstStopRef = firstEvents.find((event) => event.event === 'stopped')!.stopRef;
    const firstControl = controller.callTool('django_execution_control', {
      sessionRef,
      stopRef: firstStopRef,
      action: 'continue',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(failureCode(await controller.callTool('django_execution_control', {
      sessionRef,
      stopRef: firstStopRef,
      action: 'continue',
    })), 'CONTROL_IN_PROGRESS');

    controller.handleDapMessage(session, {
      type: 'event',
      event: 'continued',
      body: { allThreadsContinued: true },
    });
    controller.handleDapMessage(session, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 2 },
    });
    releaseContinue!();
    const completed = success(await firstControl);
    assert.strictEqual(completed.state, 'stopped');
    const finalState = success(await controller.callTool('django_execution_wait', {
      sessionRef,
      cursor: 0,
    }));
    assert.strictEqual(finalState.state, 'stopped');
    const stoppedEvents = (finalState.events as Array<Record<string, unknown>>)
      .filter((event) => event.event === 'stopped');
    assert.strictEqual(stoppedEvents.length, 2);
    assert.notStrictEqual(stoppedEvents[1].stopRef, firstStopRef);
    assert.strictEqual(failureCode(await controller.callTool('django_execution_control', {
      sessionRef,
      stopRef: firstStopRef,
      action: 'continue',
    })), 'STALE_STOP');
  });

  it('reports experimental trace coverage and pauses a trace-enabled thread', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    let pausedThreadId: number | undefined;
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    const session = mockSession(
      'trace-coverage-session',
      {
        type: 'django-process',
        request: 'attach',
        name: 'trace coverage',
        engine: 'experimental',
      },
      async (command, args) => {
        switch (command) {
          case 'djangoTracerStatus':
            return {
              pythonVersion: '3.11.15',
              allThreadsHookInstalled: false,
              futureThreadsHookInstalled: true,
              djangoRequestBridgeInstalled: true,
              djangoRequestBridgeModes: [
                'wsgi-sync',
                'invalid-mode',
                'asgi-sync',
                'asgi-async',
                'asgi-async',
                42,
              ],
              coverage: 'partial',
              djangoRequestBridgeObserved: true,
              djangoRequestBridgeDispatchCount: 2,
              djangoRequestBridgeTraceEnableCount: 1,
              djangoRequestBridgeLastMode: 'asgi-async',
              djangoRequestBridgeLastThreadName: 'django-main-thread',
              djangoRequestBridgeLastSender: 'django.core.handlers.asgi.ASGIHandler',
              djangoRequestBridgeLastOutcome: 'conflicting-trace-hook',
              djangoRequestBridgeLastFailureReason: 'conflicting-trace-hook',
              knownThreadCount: 2,
              traceEnabledThreadCount: 1,
              threads: [
                { name: 'MainThread', traceEnabled: false },
                { name: 'django-main-thread', traceEnabled: true },
              ],
            };
          case 'threads':
            return {
              threads: [
                { id: 1, name: 'MainThread', djangoTraceEnabled: false },
                { id: 2, name: 'django-main-thread', djangoTraceEnabled: true },
              ],
            };
          case 'pause':
            pausedThreadId = (args as { threadId?: number } | undefined)?.threadId;
            return {};
          default:
            throw new Error(`Unexpected DAP command: ${command}`);
        }
      },
    );
    const sessionRef = controller.handleSessionStarted(session)!;

    const status = success(await controller.callTool('django_breakpoints_status', {
      sessionRef,
    }));
    const sessionStatus = (status.sessions as Array<Record<string, unknown>>)[0];
    assert.deepStrictEqual(sessionStatus.traceCoverage, {
      coverage: 'partial',
      pythonVersion: '3.11.15',
      allThreadsHookInstalled: false,
      futureThreadsHookInstalled: true,
      djangoRequestBridgeInstalled: true,
      djangoRequestBridgeModes: ['wsgi-sync', 'asgi-sync', 'asgi-async'],
      djangoRequestBridgeObserved: true,
      djangoRequestBridgeDispatchCount: 2,
      djangoRequestBridgeTraceEnableCount: 1,
      djangoRequestBridgeLastMode: 'asgi-async',
      djangoRequestBridgeLastThreadName: 'django-main-thread',
      djangoRequestBridgeLastSender: 'django.core.handlers.asgi.ASGIHandler',
      djangoRequestBridgeLastOutcome: 'conflicting-trace-hook',
      djangoRequestBridgeLastFailureReason: 'conflicting-trace-hook',
      knownThreadCount: 2,
      traceEnabledThreadCount: 1,
      untracedThreadNames: ['MainThread'],
    });

    const pause = success(await controller.callTool('django_execution_control', {
      sessionRef,
      action: 'pause',
    }));
    assert.strictEqual(pause.accepted, true);
    assert.strictEqual(pausedThreadId, 2);
  });

  it('maps an older adapter untraced pause rejection to a specific MCP error', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    let pauseAttempted = false;
    const session = mockSession(
      'untraced-pause-session',
      {
        type: 'django-process',
        request: 'attach',
        name: 'untraced pause',
        engine: 'experimental',
      },
      async (command) => {
        if (command === 'threads') {
          return {
            // Older tracer versions do not publish djangoTraceEnabled.
            threads: [{ id: 1, name: 'django-main-thread' }],
          };
        }
        if (command === 'pause') {
          pauseAttempted = true;
          throw new Error('Thread is not trace-enabled yet');
        }
        throw new Error(`Unexpected DAP command: ${command}`);
      },
    );
    const sessionRef = controller.handleSessionStarted(session)!;
    const result = await controller.callTool('django_execution_control', {
      sessionRef,
      action: 'pause',
    });
    assert.strictEqual(failureCode(result), 'THREAD_NOT_TRACE_ENABLED');
    assert.strictEqual(pauseAttempted, true);
  });

  it('refreshes trace coverage before retrying pause after a request enables a thread', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    let threadRequests = 0;
    const pausedThreadIds: number[] = [];
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    const session = mockSession(
      'trace-refresh-session',
      {
        type: 'django-process',
        request: 'attach',
        name: 'trace refresh',
        engine: 'experimental',
      },
      async (command, args) => {
        if (command === 'threads') {
          threadRequests += 1;
          return threadRequests === 1
            ? {
              threads: [
                { id: 1, name: 'MainThread', djangoTraceEnabled: false },
              ],
            }
            : {
              threads: [
                { id: 1, name: 'MainThread', djangoTraceEnabled: false },
                { id: 2, name: 'django-main-thread', djangoTraceEnabled: true },
              ],
            };
        }
        if (command === 'pause') {
          const threadId = (args as { threadId?: unknown } | undefined)?.threadId;
          assert.strictEqual(typeof threadId, 'number');
          pausedThreadIds.push(threadId as number);
          return {};
        }
        throw new Error(`Unexpected DAP command: ${command}`);
      },
    );
    const sessionRef = controller.handleSessionStarted(session)!;

    const firstPause = await controller.callTool('django_execution_control', {
      sessionRef,
      action: 'pause',
    });
    assert.strictEqual(failureCode(firstPause), 'THREAD_NOT_TRACE_ENABLED');
    assert.strictEqual(threadRequests, 1);
    assert.deepStrictEqual(pausedThreadIds, []);

    const secondPause = success(await controller.callTool('django_execution_control', {
      sessionRef,
      action: 'pause',
    }));
    assert.strictEqual(secondPause.accepted, true);
    assert.strictEqual(threadRequests, 2, 'pause retry must not reuse the untraced thread cache');
    assert.deepStrictEqual(pausedThreadIds, [2]);
  });

  it('does not move a terminated session backwards when disconnect races termination', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    let finishStop: ((accepted: boolean) => void) | undefined;
    const stopResult = new Promise<boolean>((resolve) => { finishStop = resolve; });
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      stopDebugging: async () => stopResult,
    });
    const session = mockSession(
      'disconnect-race-session',
      { type: 'django-process', request: 'attach', name: 'disconnect-race' },
      async () => ({}),
    );
    const sessionRef = controller.handleSessionStarted(session)!;
    const disconnect = controller.callTool('django_execution_control', {
      sessionRef,
      action: 'disconnect',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.handleSessionTerminated(session);
    finishStop!(true);
    const result = success(await disconnect);
    assert.strictEqual(result.state, 'terminated');
    const status = await controller.getStatus();
    const summary = (status.sessions as Array<Record<string, unknown>>)
      .find((candidate) => candidate.sessionRef === sessionRef);
    assert.strictEqual(summary?.state, 'terminated');
    assert.strictEqual(summary?.ready, false);
  });

  it('replaces only MCP-owned workspace-relative Python breakpoints', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const additions: vscode.Breakpoint[][] = [];
    const removals: vscode.Breakpoint[][] = [];
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      addBreakpoints: (breakpoints) => additions.push([...breakpoints]),
      removeBreakpoints: (breakpoints) => removals.push([...breakpoints]),
    });

    const updated = success(await controller.callTool('django_breakpoints_update', {
      breakpoints: [{
        path: 'sampleapp/views.py',
        line: 3,
        condition: 'request.method == "GET"',
        hitCondition: '2',
        logMessage: 'request={request!r}',
      }],
    }));
    assert.strictEqual(updated.count, 1);
    assert.strictEqual(additions.length, 1);
    assert.strictEqual(removals.length, 0);
    const sourceBreakpoint = additions[0][0] as vscode.SourceBreakpoint;
    assert.strictEqual(sourceBreakpoint.location.range.start.line, 2);
    assert.strictEqual(sourceBreakpoint.condition, 'request.method == "GET"');
    assert.strictEqual(sourceBreakpoint.hitCondition, '2');
    assert.strictEqual(sourceBreakpoint.logMessage, 'request={request!r}');

    const cleared = success(await controller.callTool('django_breakpoints_update', {
      breakpoints: [],
    }));
    assert.strictEqual(cleared.count, 0);
    assert.deepStrictEqual(removals[0], additions[0]);

    success(await controller.callTool('django_breakpoints_update', {
      breakpoints: [{ path: 'sampleapp/views.py', line: 3 }],
    }));
    assert.strictEqual(controller.clearOwnedBreakpoints(), 1);
    assert.deepStrictEqual(removals[1], additions[1]);
    assert.strictEqual(controller.clearOwnedBreakpoints(), 0);

    const traversal = await controller.callTool('django_breakpoints_update', {
      breakpoints: [{ path: '../outside.py', line: 1 }],
    });
    assert.strictEqual(failureCode(traversal), 'INVALID_SOURCE_PATH');
  });

  it('exposes MCP transport definitions and JSON resources', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      windowId: 'window-test',
    });
    assert.strictEqual(controller.listToolDefinitions().length, 13);
    assert.strictEqual(controller.listResourceDefinitions().length, 3);
    const djangoReadTools = new Set([
      'django_session_wait_ready',
      'django_breakpoints_status',
      'django_request_context',
      'django_failure_snapshot',
    ]);
    for (const definition of controller.listToolDefinitions()) {
      if (djangoReadTools.has(definition.name)) {
        assert.deepStrictEqual(definition.annotations, {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
    }
    assert.deepStrictEqual(
      controller.listToolDefinitions().find((tool) => tool.name === 'django_expression_inspect')
        ?.annotations,
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    );
    const backend = controller.asTransportBackend();
    const definitions = await backend.listTools();
    assert.ok(definitions.some((tool) => tool.name === 'django_state_snapshot'));
    const resource = await controller.readResource('django-debugger://status');
    assert.strictEqual(JSON.parse(resource.text).windowId, 'window-test');
    controller.setWindowId('window-after-collision');
    assert.strictEqual((await controller.getStatus()).windowId, 'window-after-collision');
    assert.throws(() => controller.setWindowId('   '), /windowId must be/);
    assert.throws(() => controller.setWindowId('x'.repeat(257)), /windowId must be/);
  });

  it('cancels an execution wait through the transport request signal', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    const session = mockSession(
      'debug-session-cancel',
      { type: 'django-process', request: 'attach', name: 'cancel-test' },
      async () => ({}),
    );
    const sessionRef = controller.handleSessionStarted(session);
    assert.ok(sessionRef);

    const abort = new AbortController();
    const startedAt = Date.now();
    const pending = controller.asTransportBackend().callTool(
      'django_execution_wait',
      { sessionRef, cursor: 1, timeoutMs: 30_000 },
      {
        requestId: 7,
        protocolVersion: '2025-11-25',
        signal: abort.signal,
      },
    );
    abort.abort('test cancellation');
    const result = await pending;

    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(result.structuredContent, {
      ok: false,
      error: {
        code: 'REQUEST_CANCELLED',
        message: 'The execution wait was cancelled.',
      },
    });
    assert.ok(Date.now() - startedAt < 1_000);
  });

  it('waits for session readiness, reports termination cursors, and supports cancellation', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() {
        return [{
          pid: 301,
          command: 'python manage.py runserver',
          pythonPath: 'python',
          arch: process.arch,
          type: 'django',
          cwd: fixturesRoot,
        }];
      },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      startDebugging: async () => true,
    });
    const listed = success(await controller.callTool('django_targets_list', {}));
    const targetRef = (listed.targets as Array<Record<string, unknown>>)[0].targetRef;
    const started = success(await controller.callTool('django_session_start', { targetRef }));
    const sessionRef = started.sessionRef as string;
    const abort = new AbortController();
    const pending = Promise.resolve(controller.asTransportBackend().callTool(
      'django_session_wait_ready',
      { sessionRef, timeoutMs: 30_000 },
      {
        requestId: 'ready',
        protocolVersion: '2025-11-25',
        signal: abort.signal,
      },
    ));
    const session = mockSession(
      'ready-session',
      {
        type: 'django-process',
        request: 'attach',
        name: 'ready-test',
        [DJANGO_MCP_SESSION_REF_CONFIG_KEY]: sessionRef,
      },
      async () => ({}),
    );
    controller.handleSessionStarted(session);
    let readinessSettled = false;
    void pending.then(() => { readinessSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(
      readinessSettled,
      false,
      'onDidStartDebugSession is earlier than DAP configurationDone',
    );
    controller.handleDapMessage(session, {
      type: 'response',
      command: 'configurationDone',
      success: true,
    });
    const ready = await pending;
    assert.strictEqual(ready.isError, false);
    assert.deepStrictEqual(ready.structuredContent, {
      ok: true,
      sessionRef,
      state: 'running',
      ready: true,
      terminated: false,
      timedOut: false,
      cursor: 3,
    });

    controller.handleSessionTerminated(session);
    const terminated = success(await controller.callTool('django_session_wait_ready', {
      sessionRef,
      timeoutMs: 0,
    }));
    assert.strictEqual(terminated.state, 'terminated');
    assert.strictEqual(terminated.ready, false);
    assert.strictEqual(terminated.terminated, true);
    assert.strictEqual(terminated.timedOut, false);
    assert.strictEqual(terminated.cursor, 4);

    const listedAgain = success(await controller.callTool('django_targets_list', {}));
    const nextTargetRef = (listedAgain.targets as Array<Record<string, unknown>>)[0].targetRef;
    const nextStarted = success(await controller.callTool('django_session_start', {
      targetRef: nextTargetRef,
    }));
    const cancel = new AbortController();
    const cancelled = controller.asTransportBackend().callTool(
      'django_session_wait_ready',
      { sessionRef: nextStarted.sessionRef, timeoutMs: 30_000 },
      {
        requestId: 'cancel-ready',
        protocolVersion: '2025-11-25',
        signal: cancel.signal,
      },
    );
    cancel.abort('client stopped waiting');
    const cancelledResult = await cancelled;
    assert.strictEqual(cancelledResult.isError, true);
    assert.deepStrictEqual(cancelledResult.structuredContent, {
      ok: false,
      error: {
        code: 'REQUEST_CANCELLED',
        message: 'The session readiness wait was cancelled.',
      },
    });
  });

  it('reports each live adapter breakpoint verification without exposing DAP ids', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
      addBreakpoints: () => undefined,
      removeBreakpoints: () => undefined,
    });
    await controller.callTool('django_breakpoints_update', {
      breakpoints: [{ path: 'sampleapp/views.py', line: 3, column: 1 }],
    });
    const sessionA = mockSession(
      'breakpoint-session-a',
      { type: 'django-process', request: 'attach', name: 'breakpoint-a' },
      async () => ({}),
      async () => ({
        id: 9001,
        verified: true,
        message: 'relocated to executable line',
        line: 5,
        column: 2,
        source: {
          name: 'views.py',
          path: path.join(fixturesRoot, 'sampleapp/views.py'),
        },
      }),
    );
    const sessionB = mockSession(
      'breakpoint-session-b',
      { type: 'django-process', request: 'attach', name: 'breakpoint-b' },
      async () => ({}),
      async () => ({ verified: false, message: 'module has not loaded', line: 3 }),
    );
    const sessionRefA = controller.handleSessionStarted(sessionA);
    const sessionRefB = controller.handleSessionStarted(sessionB);
    assert.ok(sessionRefA && sessionRefB);

    const result = success(await controller.callTool('django_breakpoints_status', {}));
    const breakpoints = result.breakpoints as Array<Record<string, unknown>>;
    const statuses = breakpoints[0].sessions as Array<Record<string, unknown>>;
    assert.strictEqual(statuses.length, 2);
    assert.deepStrictEqual(statuses[0], {
      sessionRef: sessionRefA,
      state: 'running',
      verified: true,
      pending: false,
      actualLine: 5,
      actualColumn: 2,
      message: 'relocated to executable line',
      source: {
        name: 'views.py',
        path: 'fixtures/sampleapp/views.py',
        external: false,
      },
    });
    assert.strictEqual(statuses[1].sessionRef, sessionRefB);
    assert.strictEqual(statuses[1].verified, false);
    assert.strictEqual(statuses[1].actualLine, 3);
    assert.strictEqual(JSON.stringify(result).includes('9001'), false);

    const selected = success(await controller.callTool('django_breakpoints_status', {
      sessionRef: sessionRefB,
    }));
    const selectedStatuses = ((selected.breakpoints as Array<Record<string, unknown>>)[0]
      .sessions as Array<Record<string, unknown>>);
    assert.deepStrictEqual(selectedStatuses.map((status) => status.sessionRef), [sessionRefB]);
    controller.handleSessionTerminated(sessionB);
    assert.strictEqual(failureCode(await controller.callTool('django_breakpoints_status', {
      sessionRef: sessionRefB,
    })), 'SESSION_NOT_ACTIVE');
  });

  it('summarizes bounded Django request context from scopes without evaluate', async function () {
    const commands: string[] = [];
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    const contextVariables = [
      { name: 'request', value: '<WSGIRequest: GET /orders/>', type: 'WSGIRequest', variablesReference: 501 },
      { name: 'user', value: '<User: alice>', type: 'User', variablesReference: 502 },
      { name: 'self', value: '<OrderView>', type: 'OrderView', variablesReference: 503 },
      { name: 'args', value: '()', type: 'tuple', variablesReference: 0 },
      { name: 'kwargs', value: "{'pk': 7}", type: 'dict', variablesReference: 504 },
      { name: 'unrelated', value: 'secret', type: 'str', variablesReference: 0 },
    ];
    const session = mockSession(
      'request-context-session',
      { type: 'django-process', request: 'attach', name: 'request-context' },
      async (command) => {
        commands.push(command);
        switch (command) {
          case 'threads':
            return { threads: [{ id: 1, name: 'MainThread' }] };
          case 'stackTrace':
            return {
              stackFrames: [{
                id: 71,
                name: 'dispatch',
                line: 12,
                column: 1,
                source: { path: path.join(fixturesRoot, 'sampleapp/views.py') },
              }],
            };
          case 'scopes':
            return { scopes: [{ name: 'Locals', variablesReference: 81 }] };
          case 'variables':
            return { variables: contextVariables };
          case 'exceptionInfo':
            return {};
          default:
            throw new Error(`Unexpected DAP command: ${command}`);
        }
      },
    );
    const sessionRef = controller.handleSessionStarted(session);
    assert.ok(sessionRef);
    controller.handleDapMessage(session, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1 },
    });
    const waited = success(await controller.callTool('django_execution_wait', {
      sessionRef,
      cursor: 0,
    }));
    const stopped = (waited.events as Array<Record<string, unknown>>)
      .find((event) => event.event === 'stopped');
    assert.ok(stopped);
    const snapshot = success(await controller.callTool('django_state_snapshot', {
      sessionRef,
      stopRef: stopped.stopRef,
      maxVariables: 1,
    }));
    const context = success(await controller.callTool('django_request_context', {
      frameRef: snapshot.primaryFrameRef,
      maxVariables: 5,
    }));
    assert.strictEqual(context.inspectedVariables, 5);
    assert.strictEqual(context.truncated, true);
    assert.deepStrictEqual(context.foundRoles, ['request', 'user', 'self', 'args', 'kwargs']);
    const values = context.context as Record<string, Record<string, unknown>>;
    assert.match(values.request.variablesRef as string, /^variables_[a-f0-9]{32}$/);
    assert.match(values.user.variablesRef as string, /^variables_[a-f0-9]{32}$/);
    assert.strictEqual('variablesReference' in values.request, false);
    assert.strictEqual(commands.includes('evaluate'), false);
    assert.strictEqual(JSON.stringify(context).includes('secret'), false);

    controller.handleDapMessage(session, {
      type: 'event',
      event: 'continued',
      body: { allThreadsContinued: true },
    });
    assert.strictEqual(failureCode(await controller.callTool('django_request_context', {
      frameRef: snapshot.primaryFrameRef,
    })), 'STALE_STOP');
  });

  it('inspects only restricted frame paths and invalidates results after resume', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const evaluateArguments: Array<Record<string, unknown>> = [];
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    const session = mockSession(
      'expression-session',
      { type: 'django-process', request: 'attach', name: 'expression' },
      async (command, args) => {
        switch (command) {
          case 'threads':
            return { threads: [{ id: 1, name: 'MainThread' }] };
          case 'stackTrace':
            return {
              stackFrames: [{
                id: 91,
                name: 'view',
                line: 3,
                column: 1,
                source: { path: path.join(fixturesRoot, 'sampleapp/views.py') },
              }],
            };
          case 'scopes':
            return { scopes: [] };
          case 'exceptionInfo':
            return {};
          case 'evaluate':
            evaluateArguments.push(args as Record<string, unknown>);
            return {
              result: "'alice@example.com'",
              type: 'str',
              variablesReference: 701,
            };
          default:
            throw new Error(`Unexpected DAP command: ${command}`);
        }
      },
    );
    const sessionRef = controller.handleSessionStarted(session);
    assert.ok(sessionRef);
    controller.handleDapMessage(session, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1 },
    });
    const waited = success(await controller.callTool('django_execution_wait', {
      sessionRef,
      cursor: 0,
    }));
    const stopped = (waited.events as Array<Record<string, unknown>>)
      .find((event) => event.event === 'stopped');
    assert.ok(stopped);
    const snapshot = success(await controller.callTool('django_state_snapshot', {
      sessionRef,
      stopRef: stopped.stopRef,
      maxVariables: 1,
    }));

    const inspected = success(await controller.callTool('django_expression_inspect', {
      frameRef: snapshot.primaryFrameRef,
      expression: 'request.user.email',
    }));
    assert.strictEqual(inspected.result, "'alice@example.com'");
    assert.strictEqual(inspected.type, 'str');
    assert.match(inspected.variablesRef as string, /^variables_[a-f0-9]{32}$/);
    assert.deepStrictEqual(evaluateArguments, [{
      expression: 'request.user.email',
      frameId: 91,
      context: 'watch',
    }]);

    for (const expression of [
      'request.delete()',
      'request.__class__',
      'request.user = None',
      'request.user or fallback',
      'request.items[9999999]',
    ]) {
      assert.strictEqual(failureCode(await controller.callTool('django_expression_inspect', {
        frameRef: snapshot.primaryFrameRef,
        expression,
      })), 'UNSAFE_EXPRESSION');
    }
    assert.strictEqual(evaluateArguments.length, 1);

    controller.handleDapMessage(session, {
      type: 'event',
      event: 'continued',
      body: { allThreadsContinued: true },
    });
    assert.strictEqual(failureCode(await controller.callTool('django_expression_inspect', {
      frameRef: snapshot.primaryFrameRef,
      expression: 'request.user.email',
    })), 'STALE_STOP');
  });

  it('builds failure summaries for one stopped session and rejects ambiguous selection', async function () {
    const finder: DjangoProcessFinderLike = {
      async findDjangoProcesses() { return []; },
      async resolveDebuggablePid(pid) { return { pid, pythonPath: 'python' }; },
    };
    const controller = new DjangoMcpDebugController({
      processFinder: finder,
      getWorkspaceFolders: () => [fixtureFolder()],
    });
    const dap = (label: string) => async (command: string): Promise<unknown> => {
      switch (command) {
        case 'threads':
          return { threads: [{ id: 11, name: `${label}-thread` }] };
        case 'stackTrace':
          return {
            stackFrames: [
              {
                id: 101,
                name: 'test_checkout_failure',
                line: 44,
                column: 1,
                source: {
                  name: 'test_checkout.py',
                  path: path.join(fixturesRoot, 'sampleapp/tests/test_checkout.py'),
                },
              },
              {
                id: 102,
                name: 'dispatch',
                line: 8,
                column: 1,
                source: { path: path.join(fixturesRoot, 'sampleapp/views.py') },
              },
            ],
            totalFrames: 2,
          };
        case 'scopes':
          return { scopes: [{ name: 'Locals', variablesReference: 201 }] };
        case 'variables':
          return { variables: [{ name: 'request', value: '<request>', variablesReference: 0 }] };
        case 'exceptionInfo':
          return {
            exceptionId: 'AssertionError',
            description: `${label} failed`,
            details: { typeName: 'AssertionError', message: `${label} failed` },
          };
        default:
          throw new Error(`Unexpected DAP command: ${command}`);
      }
    };
    const firstSession = mockSession(
      'failure-session-a',
      { type: 'django-process', request: 'attach', name: 'failure-a' },
      dap('first'),
    );
    const firstRef = controller.handleSessionStarted(firstSession);
    assert.ok(firstRef);
    controller.handleDapMessage(firstSession, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'exception', threadId: 11 },
    });
    const firstWait = success(await controller.callTool('django_execution_wait', {
      sessionRef: firstRef,
      cursor: 0,
    }));
    const firstStop = (firstWait.events as Array<Record<string, unknown>>)
      .find((event) => event.event === 'stopped');
    assert.ok(firstStop);

    const only = success(await controller.callTool('django_failure_snapshot', {
      maxThreads: 1,
      maxFrames: 5,
      maxVariables: 2,
    }));
    assert.strictEqual(only.sessionRef, firstRef);
    assert.deepStrictEqual(only.exceptionInfo, {
      exceptionId: 'AssertionError',
      description: 'first failed',
      details: { message: 'first failed', typeName: 'AssertionError' },
    });
    const summary = only.failureSummary as Record<string, unknown>;
    const testFrames = summary.testLikeFrames as Array<Record<string, unknown>>;
    assert.strictEqual(testFrames.length, 1);
    assert.strictEqual(testFrames[0].name, 'test_checkout_failure');
    assert.match(testFrames[0].frameRef as string, /^frame_[a-f0-9]{32}$/);

    const secondSession = mockSession(
      'failure-session-b',
      { type: 'django-process', request: 'attach', name: 'failure-b' },
      dap('second'),
    );
    const secondRef = controller.handleSessionStarted(secondSession);
    assert.ok(secondRef);
    controller.handleDapMessage(secondSession, {
      type: 'event',
      event: 'stopped',
      body: { reason: 'exception', threadId: 11 },
    });
    const secondWait = success(await controller.callTool('django_execution_wait', {
      sessionRef: secondRef,
      cursor: 0,
    }));
    const secondStop = (secondWait.events as Array<Record<string, unknown>>)
      .find((event) => event.event === 'stopped');
    assert.ok(secondStop);

    const ambiguous = await controller.callTool('django_failure_snapshot', {});
    assert.strictEqual(failureCode(ambiguous), 'AMBIGUOUS_SESSION');
    const selected = success(await controller.callTool('django_failure_snapshot', {
      sessionRef: firstRef,
      stopRef: firstStop.stopRef,
      maxFrames: 1,
    }));
    assert.strictEqual(selected.sessionRef, firstRef);
    const selectedByStop = success(await controller.callTool('django_failure_snapshot', {
      stopRef: secondStop.stopRef,
      maxFrames: 1,
    }));
    assert.strictEqual(selectedByStop.sessionRef, secondRef);
    assert.strictEqual(failureCode(await controller.callTool('django_failure_snapshot', {
      sessionRef: firstRef,
      stopRef: secondStop.stopRef,
    })), 'STOP_REF_NOT_FOUND');
  });
});
