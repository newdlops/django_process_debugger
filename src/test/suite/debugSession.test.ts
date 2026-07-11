import * as assert from 'assert';
import type * as vscode from 'vscode';
import { describe, it } from 'mocha';
import {
  DEBUG_SESSION_AUTH_TOKEN_KEY,
  DEBUG_SESSION_LOCK_TOKEN_KEY,
  DebugSessionLockGuard,
  DjangoDebugSessionFactory,
  parseDebugSessionPid,
} from '../../debugSession';
import type { DebugpyInjector } from '../../debugpyInjector';

const EXPERIMENTAL_AUTH_TOKEN = 'a'.repeat(64);

describe('Feature: debug session configuration', function () {
  it('accepts an omitted or positive integer PID', function () {
    assert.strictEqual(parseDebugSessionPid(undefined), undefined);
    assert.strictEqual(parseDebugSessionPid(1), 1);
    assert.strictEqual(parseDebugSessionPid(43210), 43210);
  });

  it('rejects invalid configured PIDs before engine activation', function () {
    for (const value of [null, 0, -1, 1.5, '1234', Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => parseDebugSessionPid(value),
        /pid.*positive integer/i,
        `expected ${String(value)} to be rejected`,
      );
    }
  });

  it('does not activate an engine for an invalid session PID', async function () {
    let activateCalled = false;
    const injector = {
      async activateEndpoint() {
        activateCalled = true;
        throw new Error('activation must not be reached');
      },
    } as unknown as DebugpyInjector;
    const factory = new DjangoDebugSessionFactory(injector);
    const session = {
      id: 'invalid-pid-test',
      type: 'django-process',
      name: 'Invalid PID',
      configuration: { pid: 0 },
    } as unknown as vscode.DebugSession;

    const descriptor = await factory.createDebugAdapterDescriptor(session);

    assert.strictEqual(descriptor, null);
    assert.strictEqual(activateCalled, false);
  });

  it('activates the selected engine and uses the configured default when omitted', async function () {
    let activation: unknown[] | undefined;
    const injector = {
      async activateEndpoint(...args: unknown[]) {
        activation = args;
        return {
          host: '127.0.0.2',
          port: 45678,
          authToken: EXPERIMENTAL_AUTH_TOKEN,
        };
      },
    } as unknown as DebugpyInjector;
    const factory = new DjangoDebugSessionFactory(injector, () => 'experimental');
    const session = {
      id: 'experimental-engine-test',
      type: 'django-process',
      name: 'Experimental PID',
      configuration: { pid: 43210, port: 0 },
    } as unknown as vscode.DebugSession;

    const descriptor = await factory.createDebugAdapterDescriptor(session);

    assert.ok(descriptor);
    assert.deepStrictEqual(activation, [43210, 0, 'experimental']);
    assert.strictEqual(
      session.configuration[DEBUG_SESSION_AUTH_TOKEN_KEY],
      EXPERIMENTAL_AUTH_TOKEN,
    );
  });

  it('rejects a live PID lock before activating the engine', async function () {
    let activateCalled = false;
    const injector = {
      async activateEndpoint() {
        activateCalled = true;
        return { host: '127.0.0.1', port: 45678 };
      },
    } as unknown as DebugpyInjector;
    const guard: DebugSessionLockGuard = {
      async claim() {
        return { allowed: false, message: 'PID already owned' };
      },
    };
    const factory = new DjangoDebugSessionFactory(injector, () => 'debugpy', guard);
    const session = {
      id: 'lock-denied-test',
      type: 'django-process',
      name: 'Denied PID',
      configuration: { pid: 43210 },
    } as unknown as vscode.DebugSession;

    const descriptor = await factory.createDebugAdapterDescriptor(session);

    assert.strictEqual(descriptor, null);
    assert.strictEqual(activateCalled, false);
  });

  it('passes the attach reservation token to the lock guard', async function () {
    const ownerToken = 'attach-reservation-token';
    let guardedTarget: unknown;
    const injector = {
      async activateEndpoint() {
        return {
          host: '127.0.0.2',
          port: 45678,
          authToken: EXPERIMENTAL_AUTH_TOKEN,
        };
      },
    } as unknown as DebugpyInjector;
    const guard: DebugSessionLockGuard = {
      async claim(_session, target) {
        guardedTarget = target;
        return { allowed: true };
      },
    };
    const factory = new DjangoDebugSessionFactory(injector, () => 'experimental', guard);
    const session = {
      id: 'provisional-lock-test',
      type: 'django-process',
      name: 'Reserved PID',
      configuration: {
        pid: 43210,
        port: 0,
        [DEBUG_SESSION_LOCK_TOKEN_KEY]: ownerToken,
      },
    } as unknown as vscode.DebugSession;

    const descriptor = await factory.createDebugAdapterDescriptor(session);

    assert.ok(descriptor);
    assert.deepStrictEqual(guardedTarget, {
      pid: 43210,
      engine: 'experimental',
      host: '127.0.0.1',
      port: 0,
      ownerToken,
    });
    assert.strictEqual(session.configuration.host, '127.0.0.2');
    assert.strictEqual(session.configuration.port, 45678);
    assert.strictEqual(
      session.configuration[DEBUG_SESSION_AUTH_TOKEN_KEY],
      EXPERIMENTAL_AUTH_TOKEN,
    );
  });

  it('rejects an experimental endpoint that omits DAP authentication', async function () {
    const injector = {
      async activateEndpoint() {
        return { host: '127.0.0.2', port: 45678 };
      },
    } as unknown as DebugpyInjector;
    const factory = new DjangoDebugSessionFactory(injector, () => 'experimental');
    const session = {
      id: 'missing-experimental-auth-test',
      type: 'django-process',
      name: 'Missing Auth',
      configuration: { pid: 43210, port: 0 },
    } as unknown as vscode.DebugSession;

    assert.strictEqual(await factory.createDebugAdapterDescriptor(session), null);
    assert.strictEqual(
      session.configuration[DEBUG_SESSION_AUTH_TOKEN_KEY],
      undefined,
    );
  });

  it('removes internal DAP credentials from debugpy sessions', async function () {
    const injector = {
      async activateEndpoint() {
        return { host: '127.0.0.2', port: 45678 };
      },
    } as unknown as DebugpyInjector;
    const factory = new DjangoDebugSessionFactory(injector, () => 'debugpy');
    const session = {
      id: 'debugpy-auth-cleanup-test',
      type: 'django-process',
      name: 'Debugpy Auth Cleanup',
      configuration: {
        pid: 43210,
        [DEBUG_SESSION_AUTH_TOKEN_KEY]: 'b'.repeat(64),
      },
    } as unknown as vscode.DebugSession;

    assert.ok(await factory.createDebugAdapterDescriptor(session));
    assert.strictEqual(
      session.configuration[DEBUG_SESSION_AUTH_TOKEN_KEY],
      undefined,
    );
  });

  it('releases its PID-lock lease when engine activation fails', async function () {
    let released = false;
    const injector = {
      async activateEndpoint() {
        throw new Error('activation failed');
      },
    } as unknown as DebugpyInjector;
    const guard: DebugSessionLockGuard = {
      async claim() {
        return {
          allowed: true,
          release() {
            released = true;
          },
        };
      },
    };
    const factory = new DjangoDebugSessionFactory(injector, () => 'debugpy', guard);
    const session = {
      id: 'activation-failure-test',
      type: 'django-process',
      name: 'Activation Failure',
      configuration: { pid: 43210 },
    } as unknown as vscode.DebugSession;

    const descriptor = await factory.createDebugAdapterDescriptor(session);

    assert.strictEqual(descriptor, null);
    assert.strictEqual(released, true);
  });
});
