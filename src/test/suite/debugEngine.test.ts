import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
  DEBUG_ENGINES,
  DEFAULT_DEBUG_ENGINE,
  debugEngineDisplayName,
  isDebugEngine,
  normalizeDebugEngine,
  supportsHotReload,
} from '../../debugEngine';

describe('Feature: debug engine selection', function () {
  it('uses the native tracer as the default for new sessions', function () {
    assert.strictEqual(DEFAULT_DEBUG_ENGINE, 'experimental');
    assert.deepStrictEqual([...DEBUG_ENGINES], ['debugpy', 'experimental']);
    assert.strictEqual(normalizeDebugEngine(undefined), 'experimental');
    assert.strictEqual(normalizeDebugEngine('unknown'), 'experimental');
  });

  it('accepts the explicit experimental opt-in', function () {
    assert.strictEqual(isDebugEngine('experimental'), true);
    assert.strictEqual(normalizeDebugEngine('experimental'), 'experimental');
    assert.strictEqual(debugEngineDisplayName('experimental'), 'Experimental Native Tracer');
  });

  it('advertises hot reload for both debug engines', function () {
    assert.strictEqual(supportsHotReload('debugpy'), true);
    assert.strictEqual(supportsHotReload('experimental'), true);
  });
});
