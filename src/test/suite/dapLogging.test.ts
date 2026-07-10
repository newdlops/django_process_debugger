import * as assert from 'assert';
import { describe, it } from 'mocha';
import { summarizeDapMessage } from '../../dapLogging';

describe('Feature: safe DAP protocol logging', function () {
  it('redacts request arguments and variable or evaluation response bodies', function () {
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
    const evaluateRequest = summarizeDapMessage({
      type: 'request',
      seq: 9,
      command: 'evaluate',
      arguments: { expression: 'application_secrets["api-token"]' },
    });
    const evaluateResponse = summarizeDapMessage({
      type: 'response',
      seq: 10,
      request_seq: 9,
      success: true,
      command: 'evaluate',
      body: {
        result: 'secret-evaluation-result',
        type: 'str',
        variablesReference: 0,
      },
    });
    const logpointRequest = summarizeDapMessage({
      type: 'request',
      seq: 11,
      command: 'setBreakpoints',
      arguments: {
        source: { path: '/application/views.py' },
        breakpoints: [{ line: 10, logMessage: 'token={application_secret}' }],
      },
    });

    assert.match(request, /setVariable/);
    assert.match(response, /variables/);
    assert.match(evaluateRequest, /evaluate/);
    assert.match(evaluateResponse, /evaluate/);
    assert.match(logpointRequest, /setBreakpoints/);
    assert.ok(!request.includes('super-secret'));
    assert.ok(!response.includes('secret-token'));
    assert.ok(!evaluateRequest.includes('application_secrets'));
    assert.ok(!evaluateRequest.includes('api-token'));
    assert.ok(!evaluateResponse.includes('secret-evaluation-result'));
    assert.ok(!logpointRequest.includes('application_secret'));
    assert.ok(!logpointRequest.includes('token='));
  });

  it('records output metadata without recording program output', function () {
    const summary = summarizeDapMessage({
      type: 'event',
      seq: 9,
      event: 'output',
      body: { category: 'console', output: 'authorization=secret' },
    });

    assert.match(summary, /console/);
    assert.match(summary, /outputLength/);
    assert.ok(!summary.includes('authorization=secret'));
  });
});
