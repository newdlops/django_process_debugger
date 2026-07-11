import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
  DJANGO_PROCESS_DEBUG_TYPE,
  DJANGO_PROCESS_DEBUGGER_PUBLIC_API,
  PUBLIC_API_VERSION,
  SETUP_COMMAND_ID,
  STATUS_COMMAND_ID,
} from '../../publicApi';

describe('Feature: public extension API', function () {
  it('publishes the stable v1 declarative contract', function () {
    assert.strictEqual(PUBLIC_API_VERSION, 1);
    assert.strictEqual(DJANGO_PROCESS_DEBUG_TYPE, 'django-process');
    assert.deepStrictEqual(DJANGO_PROCESS_DEBUGGER_PUBLIC_API, {
      apiVersion: 1,
      debugType: 'django-process',
      engines: ['debugpy', 'experimental'],
      commands: {
        setup: 'djangoProcessDebugger.setup',
        status: 'djangoProcessDebugger.showSetupStatus',
      },
      capabilities: {
        experimental: {
          localPid: true,
          hotReload: true,
        },
      },
    });
    assert.strictEqual(SETUP_COMMAND_ID, DJANGO_PROCESS_DEBUGGER_PUBLIC_API.commands.setup);
    assert.strictEqual(STATUS_COMMAND_ID, DJANGO_PROCESS_DEBUGGER_PUBLIC_API.commands.status);
  });

  it('freezes public metadata so consumers cannot change shared capability state', function () {
    assert.strictEqual(Object.isFrozen(DJANGO_PROCESS_DEBUGGER_PUBLIC_API), true);
    assert.strictEqual(Object.isFrozen(DJANGO_PROCESS_DEBUGGER_PUBLIC_API.engines), true);
    assert.strictEqual(Object.isFrozen(DJANGO_PROCESS_DEBUGGER_PUBLIC_API.commands), true);
    assert.strictEqual(Object.isFrozen(DJANGO_PROCESS_DEBUGGER_PUBLIC_API.capabilities), true);
    assert.strictEqual(
      Object.isFrozen(DJANGO_PROCESS_DEBUGGER_PUBLIC_API.capabilities.experimental),
      true,
    );
  });
});
