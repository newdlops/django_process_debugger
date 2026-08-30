import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { BOOTSTRAP_VERSION, DebugpyInjector } from '../../debugpyInjector';
import {
  allocateLoopbackPort,
  createTempVenv,
  findSystemPython,
  projectRoot,
  sleep,
  spawnFakeRunserver,
  SpawnedProcess,
} from './testHelpers';
import {
  McpStdioTestClient,
  waitForWindowManifest,
} from './mcpStdioTestClient';

const EXTENSION_ID = 'newdlops.django-process-debugger';
const BREAKPOINT_MARKER = 'MCP_E2E_BREAKPOINT';

interface SessionEventResult {
  event: Record<string, unknown>;
  cursor: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function positiveInteger(value: unknown, label: string): number {
  assert.ok(typeof value === 'number' && Number.isInteger(value) && value >= 0, label);
  return value;
}

async function waitForSessionEvent(
  client: McpStdioTestClient,
  sessionRef: string,
  cursor: number,
  eventName: string,
  timeoutMs: number,
): Promise<SessionEventResult> {
  const deadline = Date.now() + timeoutMs;
  let nextCursor = cursor;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for MCP debugger event ${eventName}`);
    }
    const result = await client.callTool('django_execution_wait', {
      sessionRef,
      cursor: nextCursor,
      timeoutMs: Math.min(remaining, 5_000),
    }, Math.min(remaining + 5_000, 40_000));
    const events = records(result.events);
    nextCursor = positiveInteger(result.nextCursor, 'execution_wait must return nextCursor');
    const event = events.find((candidate) => candidate.event === eventName);
    if (event) {
      return { event, cursor: nextCursor };
    }
    const terminated = events.find((candidate) =>
      candidate.event === 'terminated' || candidate.event === 'exited');
    if (terminated) {
      throw new Error(
        `Debug session terminated before ${eventName}: ${JSON.stringify(terminated)}`,
      );
    }
  }
}

function targetForPort(
  targets: readonly Record<string, unknown>[],
  port: number,
): Record<string, unknown> | undefined {
  return targets.find((target) =>
    records(target.endpoints).some((endpoint) => endpoint.port === port));
}

function allSnapshotVariables(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  return records(snapshot.scopes).flatMap((scope) => records(scope.variables));
}

async function waitForBootstrapRuntimeState(pid: number, timeoutMs: number): Promise<void> {
  const statePath = `/tmp/django-process-debugger/${pid}.bootstrap.json`;
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown;
  while (Date.now() < deadline) {
    try {
      lastState = JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown;
      if (isRecord(lastState)
        && lastState.pid === pid
        && lastState.version === BOOTSTRAP_VERSION
        && lastState.activationVersion === 2
        && typeof lastState.pythonExecutable === 'string'
        && typeof lastState.runtimeId === 'string'
        && /^[a-f0-9]{64}$/i.test(lastState.runtimeId)
        && lastState.controlSocket === `/tmp/django-process-debugger/${pid}.control.sock`
        && Array.isArray(lastState.engines)
        && lastState.engines.includes('debugpy')) {
        return;
      }
    } catch {
      // The bootstrap publishes state atomically; wait for its current identity.
    }
    await sleep(25);
  }

  const bootstrapLog = await fs.readFile(
    '/tmp/django-process-debugger/bootstrap.log',
    'utf8',
  ).catch(() => '(bootstrap log unavailable)');
  const pidLog = bootstrapLog
    .split(/\r?\n/)
    .filter((line) => line.includes(`[PID ${pid}]`))
    .slice(-20)
    .join('\n');
  throw new Error(
    `Timed out waiting for bootstrap runtime state for PID ${pid}: `
    + `${JSON.stringify(lastState)}\n${pidLog || '(no PID-specific bootstrap log)'}`,
  );
}

describe('Feature: live MCP-to-Django debugger vertical flow', function () {
  it('drives stdio bridge → HTTP MCP → VS Code → debugpy through a real breakpoint', async function () {
    this.timeout(120_000);

    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }
    const venv = await createTempVenv(python);
    if (!venv) {
      this.skip();
      return;
    }

    let server: SpawnedProcess | undefined;
    let client: McpStdioTestClient | undefined;
    let liveSession: vscode.DebugSession | undefined;
    let sessionRef: string | undefined;
    const triggerPath = path.join(
      os.tmpdir(),
      `django-process-debugger-mcp-e2e-${process.pid}-${Date.now()}.trigger`,
    );
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder?.uri.scheme === 'file', 'live MCP E2E requires a local workspace');
    const workspacePath = workspaceFolder.uri.fsPath;
    const engineConfiguration = vscode.workspace.getConfiguration('djangoProcessDebugger');
    const previousGlobalEngine = engineConfiguration.inspect<unknown>('engine')?.globalValue;
    let engineOverrideApplied = false;
    const sourcePath = path.join(workspacePath, 'mcp_breakpoint_target.py');
    const source = await fs.readFile(sourcePath, 'utf8');
    const breakpointLine = source.split(/\r?\n/)
      .findIndex((line) => line.includes(BREAKPOINT_MARKER)) + 1;
    assert.ok(breakpointLine > 0, `missing ${BREAKPOINT_MARKER} fixture marker`);

    const sessionListener = vscode.debug.onDidStartDebugSession((session) => {
      if (server && session.type === 'django-process' && session.configuration.pid === server.pid) {
        liveSession = session;
      }
    });

    try {
      // This scenario intentionally covers optional debugpy even though new
      // sessions now default to the dependency-free experimental engine.
      await engineConfiguration.update(
        'engine',
        'debugpy',
        vscode.ConfigurationTarget.Global,
      );
      engineOverrideApplied = true;

      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, `extension ${EXTENSION_ID} not found`);
      if (!extension.isActive) {
        await extension.activate();
      }
      assert.strictEqual(vscode.workspace.isTrusted, true, 'MCP host requires a trusted workspace');

      const injector = new DebugpyInjector();
      injector.setBundledDebugpyPath(path.join(projectRoot(), 'vendor', 'python'));
      await injector.installBootstrap(venv.sitePackages);

      const serverPort = await allocateLoopbackPort();
      server = await spawnFakeRunserver(venv.python, serverPort, {
        cwd: workspacePath,
        env: {
          DPD_MCP_E2E_TRIGGER: triggerPath,
          DPD_MCP_E2E_SOURCE: sourcePath,
        },
      });
      await waitForBootstrapRuntimeState(server.pid, 10_000);

      const manifest = await waitForWindowManifest({
        workspacePath,
        extensionPid: process.pid,
      });
      client = McpStdioTestClient.start({
        workspacePath,
        windowId: manifest.windowId,
      });
      const initialized = await client.initialize();
      assert.strictEqual(initialized.protocolVersion, '2025-11-25');

      const toolList = await client.request('tools/list');
      assert.ok(isRecord(toolList));
      assert.ok(
        records(toolList.tools).some((tool) => tool.name === 'django_session_start'),
        'stdio MCP client must see debugger tool definitions',
      );

      const listed = await client.callTool('django_targets_list', {});
      const target = targetForPort(records(listed.targets), serverPort);
      assert.ok(target, `live fixture on port ${serverPort} was not exposed by MCP`);
      assert.match(String(target.targetRef), /^target_[a-f0-9]{32}$/);
      assert.strictEqual('pid' in target, false, 'MCP target capabilities must not expose raw PIDs');

      const breakpoints = await client.callTool('django_breakpoints_update', {
        breakpoints: [{
          path: 'mcp_breakpoint_target.py',
          line: breakpointLine,
        }],
      });
      assert.strictEqual(breakpoints.count, 1);

      const started = await client.callTool('django_session_start', {
        targetRef: target.targetRef,
      }, 45_000);
      sessionRef = String(started.sessionRef);
      assert.match(sessionRef, /^session_[a-f0-9]{32}$/);
      positiveInteger(started.cursor, 'session_start must return cursor');
      const ready = await client.callTool('django_session_wait_ready', {
        sessionRef,
        timeoutMs: 30_000,
      }, 35_000);
      assert.strictEqual(ready.ready, true);
      assert.strictEqual(ready.timedOut, false);
      let cursor = positiveInteger(ready.cursor, 'ready cursor');

      // configurationDone has completed; emulate one request entering workspace code.
      await fs.writeFile(triggerPath, 'run\n', { mode: 0o600 });

      const stop = await waitForSessionEvent(
        client,
        sessionRef,
        cursor,
        'stopped',
        30_000,
      );
      cursor = stop.cursor;
      const stopRef = String(stop.event.stopRef);
      assert.match(stopRef, /^stop_[a-f0-9]{32}$/);
      assert.strictEqual(stop.event.reason, 'breakpoint');
      assert.strictEqual('threadId' in stop.event, false);

      const snapshot = await client.callTool('django_state_snapshot', {
        sessionRef,
        stopRef,
        maxThreads: 8,
        maxFrames: 30,
        maxVariables: 100,
      });
      const frames = records(snapshot.threads).flatMap((thread) => records(thread.frames));
      const fixtureFrame = frames.find((frame) => {
        const frameSource = isRecord(frame.source) ? frame.source : undefined;
        return typeof frameSource?.path === 'string'
          && frameSource.path.endsWith('/mcp_breakpoint_target.py');
      });
      assert.ok(fixtureFrame, `snapshot omitted fixture frame: ${JSON.stringify(frames)}`);
      assert.strictEqual(fixtureFrame.line, breakpointLine);
      assert.strictEqual(isRecord(fixtureFrame.source) && fixtureFrame.source.external, false);
      const variables = allSnapshotVariables(snapshot);
      assert.ok(variables.some((variable) => variable.name === 'request'));
      assert.ok(variables.some((variable) =>
        variable.name === 'response' && String(variable.value).includes('mcp-live-e2e')));
      assert.strictEqual(JSON.stringify(snapshot).includes('variablesReference'), false);

      const continued = await client.callTool('django_execution_control', {
        sessionRef,
        stopRef,
        action: 'continue',
      });
      assert.strictEqual(continued.state, 'running');
      const continueEvent = await waitForSessionEvent(
        client,
        sessionRef,
        cursor,
        'continued',
        15_000,
      );
      cursor = continueEvent.cursor;

      const disconnected = await client.callTool('django_execution_control', {
        sessionRef,
        action: 'disconnect',
      });
      assert.strictEqual(disconnected.accepted, true);
      await waitForSessionEvent(client, sessionRef, cursor, 'terminated', 20_000);

      const cleared = await client.callTool('django_breakpoints_update', { breakpoints: [] });
      assert.strictEqual(cleared.count, 0);
    } finally {
      sessionListener.dispose();
      if (engineOverrideApplied) {
        try {
          await engineConfiguration.update(
            'engine',
            previousGlobalEngine,
            vscode.ConfigurationTarget.Global,
          );
        } catch {
          // Keep cleanup best-effort when the test host is already shutting down.
        }
      }
      if (client) {
        try {
          await client.callTool('django_breakpoints_update', { breakpoints: [] }, 5_000);
        } catch {
          // The MCP window or bridge may already be gone after a failed assertion.
        }
      }
      if (liveSession) {
        try {
          await vscode.debug.stopDebugging(liveSession);
        } catch {
          // Best effort: stopping the target below also tears down its adapter.
        }
      }
      await client?.close();
      await server?.stop();
      await fs.unlink(triggerPath).catch(() => {});
      await venv.cleanup();
    }
  });
});
