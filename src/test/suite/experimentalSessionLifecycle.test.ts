import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import {
  DEBUG_SESSION_AUTH_TOKEN_KEY,
  DEBUG_SESSION_LOCK_TOKEN_KEY,
} from '../../debugSession';
import { DebugpyInjector } from '../../debugpyInjector';
import {
  allocateLoopbackPort,
  createTempVenv,
  findSystemPython,
  projectRoot,
  spawnFakeRunserver,
} from './testHelpers';

const EXTENSION_ID = 'newdlops.django-process-debugger';

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function startExperimentalSession(
  folder: vscode.WorkspaceFolder,
  pid: number,
  name: string,
): Promise<vscode.DebugSession> {
  let resolveSession!: (session: vscode.DebugSession) => void;
  const sessionPromise = new Promise<vscode.DebugSession>((resolve) => {
    resolveSession = resolve;
  });
  const listener = vscode.debug.onDidStartDebugSession((session) => {
    if (session.type === 'django-process'
      && session.name === name
      && session.configuration.pid === pid) {
      resolveSession(session);
    }
  });
  try {
    const started = await vscode.debug.startDebugging(folder, {
      type: 'django-process',
      request: 'attach',
      name,
      pid,
      engine: 'experimental',
      host: '127.0.0.1',
      port: 0,
      justMyCode: true,
    });
    assert.strictEqual(started, true, 'VS Code rejected the experimental session');
    const session = await Promise.race([
      sessionPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('experimental session never started')), 10_000);
      }),
    ]);
    await waitUntil(async () => {
      try {
        const result = await session.customRequest('threads') as { threads?: unknown[] };
        return Array.isArray(result.threads);
      } catch {
        return false;
      }
    }, 'experimental session never became DAP-ready');
    assert.match(
      String(session.configuration[DEBUG_SESSION_AUTH_TOKEN_KEY] ?? ''),
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      String(session.configuration[DEBUG_SESSION_LOCK_TOKEN_KEY] ?? ''),
      /^config:/,
    );
    return session;
  } finally {
    listener.dispose();
  }
}

async function stopSession(session: vscode.DebugSession): Promise<void> {
  let resolveTerminated!: () => void;
  const terminated = new Promise<void>((resolve) => {
    resolveTerminated = resolve;
  });
  const listener = vscode.debug.onDidTerminateDebugSession((candidate) => {
    if (candidate.id === session.id) {
      resolveTerminated();
    }
  });
  try {
    await vscode.debug.stopDebugging(session);
    await Promise.race([
      terminated,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('experimental session never terminated')), 10_000);
      }),
    ]);
  } finally {
    listener.dispose();
  }
}

describe('Feature: experimental VS Code session lifecycle', function () {
  it('authenticates before the descriptor RPC, abandons failed startup, and reuses the endpoint', async function () {
    this.timeout(90_000);

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
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'experimental lifecycle E2E requires a workspace folder');

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    if (!extension.isActive) {
      await extension.activate();
    }

    const injector = new DebugpyInjector();
    injector.setBundledDebugpyPath(path.join(projectRoot(), 'vendor', 'python'));
    await injector.installBootstrap(venv.sitePackages);
    const serverPort = await allocateLoopbackPort();
    const server = await spawnFakeRunserver(venv.python, serverPort, {
      cwd: folder.uri.fsPath,
    });
    const activePath = path.join(
      '/tmp/django-process-debugger',
      `${server.pid}.experimental.active`,
    );
    const lockPath = path.join(
      '/tmp/django-process-debugger',
      `debug-session.${server.pid}.lock`,
    );
    const claimPath = path.join(
      '/tmp/django-process-debugger',
      `debug-session.${server.pid}.claim`,
    );
    let liveSession: vscode.DebugSession | undefined;

    try {
      const endpoint = await injector.activateEndpoint(server.pid, 0, 'experimental');
      assert.match(endpoint.authToken ?? '', /^[0-9a-f]{64}$/);
      const activeRecord = JSON.parse(await fs.readFile(activePath, 'utf8')) as {
        authToken: string;
      };

      // Force a post-descriptor DAP authentication rejection. This recreates
      // the lifecycle gap where VS Code emits tracker error but no start or
      // terminate event, without changing the live tracer credential.
      activeRecord.authToken = endpoint.authToken === 'f'.repeat(64)
        ? 'e'.repeat(64)
        : 'f'.repeat(64);
      await fs.writeFile(activePath, JSON.stringify(activeRecord), { mode: 0o600 });
      const failedSessionName = 'Expected experimental authentication failure';
      let sawAttachRejection = false;
      const failureTracker = vscode.debug.registerDebugAdapterTrackerFactory(
        'django-process',
        {
          createDebugAdapterTracker(session) {
            if (session.name !== failedSessionName) {
              return undefined;
            }
            return {
              onDidSendMessage(message: unknown) {
                const response = message as {
                  type?: string;
                  command?: string;
                  success?: boolean;
                };
                if (response.type === 'response'
                  && response.command === 'attach'
                  && response.success === false) {
                  sawAttachRejection = true;
                }
              },
            };
          },
        },
      );
      try {
        try {
          await vscode.debug.startDebugging(folder, {
            type: 'django-process',
            request: 'attach',
            name: failedSessionName,
            pid: server.pid,
            engine: 'experimental',
            host: '127.0.0.1',
            port: 0,
          });
        } catch (error) {
          // VS Code's test dialog service surfaces the expected attach rejection
          // as a thrown error because it refuses to display the error dialog.
          assert.match(String(error), /Authentication failed|refused to show dialog/);
        }
        await waitUntil(
          () => sawAttachRejection,
          'the forced failure did not reach the DAP attach authentication check',
        );
      } finally {
        failureTracker.dispose();
      }

      await waitUntil(
        async () => !await exists(lockPath) && !await exists(claimPath),
        'failed DAP startup left a PID lock or claim behind',
      );

      // Restore the tracer-owned credential and retry immediately on the same
      // live PID. No target restart or pending-lock TTL wait is allowed.
      activeRecord.authToken = endpoint.authToken!;
      await fs.writeFile(activePath, JSON.stringify(activeRecord), { mode: 0o600 });
      liveSession = await startExperimentalSession(folder, server.pid, 'Experimental retry');
      assert.strictEqual(liveSession.configuration.host, endpoint.host);
      assert.strictEqual(liveSession.configuration.port, endpoint.port);
      assert.strictEqual(
        liveSession.configuration[DEBUG_SESSION_AUTH_TOKEN_KEY],
        endpoint.authToken,
      );
      await stopSession(liveSession);
      liveSession = undefined;
      await waitUntil(async () => !await exists(lockPath), 'normal termination left a PID lock');

      // The tracer survives disconnect. A second session must recover the
      // original active-record credential and attach to that same endpoint.
      liveSession = await startExperimentalSession(folder, server.pid, 'Experimental endpoint reuse');
      assert.strictEqual(liveSession.configuration.host, endpoint.host);
      assert.strictEqual(liveSession.configuration.port, endpoint.port);
      assert.strictEqual(
        liveSession.configuration[DEBUG_SESSION_AUTH_TOKEN_KEY],
        endpoint.authToken,
      );
      await stopSession(liveSession);
      liveSession = undefined;
      await waitUntil(async () => !await exists(lockPath), 'reused session left a PID lock');
    } finally {
      if (liveSession) {
        try {
          await vscode.debug.stopDebugging(liveSession);
        } catch {
          // Best effort: stopping the target below also closes the adapter.
        }
      }
      await server.stop();
      await venv.cleanup();
      await fs.unlink(lockPath).catch(() => {});
      await fs.unlink(claimPath).catch(() => {});
    }
  });
});
