import * as assert from 'assert';
import { describe, it } from 'mocha';
import { summarizeDapMessage } from '../../dapLogging';

describe('Feature: safe DAP protocol logging', function () {
  it('redacts request arguments and variable response bodies', function () {
    const request = summarizeDapMessage({
      type: 'request',
      seq: 7,
      command: 'setVariable',
      arguments: { name: 'password', value: 'super-secret' },
    });
    const response = summarizeDapMessage({
      type: 'response',
      seq: 8,
      request_seq: 7,
      success: true,
      command: 'variables',
      body: { variables: [{ name: 'token', value: 'secret-token' }] },
    });

    assert.match(request, /setVariable/);
    assert.match(response, /variables/);
    assert.ok(!request.includes('super-secret'));
    assert.ok(!response.includes('secret-token'));
  });

  it('records output metadata without recording program output', function () {
    const summary = summarizeDapMessage({
      type: 'event',
      seq: 9,
      event: 'output',
      body: { category: 'stdout', output: 'authorization=secret' },
    });

    assert.match(summary, /stdout/);
    assert.match(summary, /outputLength/);
    assert.ok(!summary.includes('authorization=secret'));
  });
});
