import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
  ExtensionTelemetry,
  TELEMETRY_CONNECTION_STRING_ENV,
  resolveTelemetryConnectionString,
  type TelemetryReporterLike,
} from '../../telemetry';

interface SentEvent {
  eventName: string;
  properties: Parameters<TelemetryReporterLike['sendTelemetryEvent']>[1];
  measurements: Parameters<TelemetryReporterLike['sendTelemetryEvent']>[2];
}

class FakeTelemetryReporter implements TelemetryReporterLike {
  readonly events: SentEvent[] = [];
  disposeCount = 0;

  sendTelemetryEvent(
    eventName: SentEvent['eventName'],
    properties?: SentEvent['properties'],
    measurements?: SentEvent['measurements'],
  ): void {
    this.events.push({ eventName, properties, measurements });
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

describe('Extension telemetry', function () {
  it('resolves a release manifest value before the local environment fallback', function () {
    const environment = {
      [TELEMETRY_CONNECTION_STRING_ENV]: 'environment-connection',
    };
    assert.strictEqual(
      resolveTelemetryConnectionString({
        telemetry: { connectionString: '  manifest-connection  ' },
      }, environment),
      'manifest-connection',
    );
    assert.strictEqual(
      resolveTelemetryConnectionString({}, environment),
      'environment-connection',
    );
    assert.strictEqual(
      resolveTelemetryConnectionString({ telemetry: { connectionString: '  ' } }, {}),
      undefined,
    );
  });

  it('sends only the declared categorical properties and measurements', function () {
    const reporter = new FakeTelemetryReporter();
    let now = 1_000;
    const telemetry = new ExtensionTelemetry(reporter, { now: () => now });

    telemetry.sendExtensionActivated({
      engine: 'debugpy',
      hotReloadEnabled: true,
      mcpEnabled: false,
      workspaceTrusted: true,
      workspaceFolderCount: 2,
    });
    telemetry.sendCommandInvoked('djangoProcessDebugger.attachToProcess');
    telemetry.sendCommandCompleted(
      'djangoProcessDebugger.attachToProcess',
      'succeeded',
      'sessionStart',
      125,
    );
    telemetry.sendConfigurationChanged('hotReload', 'false');
    telemetry.sendMcpToolCompleted('django_state_snapshot', 'succeeded', 42);
    telemetry.sendHotReloadCompleted({
      outcome: 'partial',
      fileCount: 3,
      durationMs: 600,
    });
    telemetry.sendDebugSessionStarted('private-session-id', {
      engine: 'experimental',
      source: 'command',
      hotReloadEnabled: true,
      justMyCode: false,
      redirectOutput: false,
    });
    now = 3_750;
    telemetry.sendDebugSessionTerminated('private-session-id');

    assert.deepStrictEqual(reporter.events, [
      {
        eventName: 'extensionActivated',
        properties: {
          engine: 'debugpy',
          hotReloadEnabled: 'true',
          mcpEnabled: 'false',
          workspaceTrusted: 'true',
        },
        measurements: { workspaceFolderCount: 2 },
      },
      {
        eventName: 'commandInvoked',
        properties: { command: 'djangoProcessDebugger.attachToProcess' },
        measurements: undefined,
      },
      {
        eventName: 'commandCompleted',
        properties: {
          command: 'djangoProcessDebugger.attachToProcess',
          outcome: 'succeeded',
          stage: 'sessionStart',
        },
        measurements: { durationMs: 125 },
      },
      {
        eventName: 'configurationChanged',
        properties: { setting: 'hotReload', value: 'false' },
        measurements: undefined,
      },
      {
        eventName: 'mcpToolCompleted',
        properties: { tool: 'django_state_snapshot', outcome: 'succeeded' },
        measurements: { durationMs: 42 },
      },
      {
        eventName: 'hotReloadCompleted',
        properties: { outcome: 'partial' },
        measurements: { fileCount: 3, durationMs: 600 },
      },
      {
        eventName: 'debugSessionStarted',
        properties: {
          engine: 'experimental',
          source: 'command',
          hotReloadEnabled: 'true',
          justMyCode: 'false',
          redirectOutput: 'false',
        },
        measurements: undefined,
      },
      {
        eventName: 'debugSessionTerminated',
        properties: { engine: 'experimental', source: 'command' },
        measurements: { durationMs: 2_750 },
      },
    ]);
    assert.ok(!JSON.stringify(reporter.events).includes('private-session-id'));
  });

  it('is a no-op without configuration and disposes a reporter once', async function () {
    const disabled = new ExtensionTelemetry();
    assert.strictEqual(disabled.isConfigured, false);
    disabled.sendCommandInvoked('djangoProcessDebugger.setup');
    disabled.sendDebugSessionTerminated('unknown-session');
    await disabled.shutdown();

    const reporter = new FakeTelemetryReporter();
    const telemetry = new ExtensionTelemetry(reporter);
    assert.strictEqual(telemetry.isConfigured, true);
    await Promise.all([telemetry.shutdown(), telemetry.shutdown()]);
    telemetry.sendCommandInvoked('djangoProcessDebugger.setup');
    assert.strictEqual(reporter.disposeCount, 1);
    assert.deepStrictEqual(reporter.events, []);
  });
});
