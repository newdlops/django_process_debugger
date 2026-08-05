import * as assert from 'assert';
import { describe, it } from 'mocha';
import { presentAttachFailure } from '../../attachFailurePresentation';
import {
  BootstrapNotInstalledError,
  BootstrapRuntimeVersionError,
  DebugEngineUnavailableError,
  ProcessNotFoundError,
} from '../../debugpyInjector';

describe('Feature: attach failure presentation', function () {
  it('offers setup only when bootstrap remediation can establish readiness', function () {
    const presentation = presentAttachFailure(new BootstrapNotInstalledError(123));
    assert.ok(presentation.message.includes('Setup'));
    assert.deepStrictEqual(presentation.actions, ['Run Setup', 'Show Status', 'Show Logs']);
  });

  it('keeps restart guidance for an outdated live bootstrap', function () {
    const presentation = presentAttachFailure(new BootstrapRuntimeVersionError(123, 'old', 'new'));
    assert.ok(presentation.message.includes('Restart'));
    assert.ok(presentation.actions.includes('Run Setup'));
  });

  it('does not offer setup for an exited process', function () {
    const presentation = presentAttachFailure(new ProcessNotFoundError(123));
    assert.ok(presentation.message.includes('exited'));
    assert.ok(!presentation.actions.includes('Run Setup'));
  });

  it('offers setup and restart guidance when explicit debugpy is unavailable', function () {
    const presentation = presentAttachFailure(new DebugEngineUnavailableError(123, 'debugpy'));
    assert.ok(presentation.message.includes('restart'));
    assert.ok(presentation.actions.includes('Run Setup'));
  });
});
