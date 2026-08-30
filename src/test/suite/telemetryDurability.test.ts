import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'mocha';
import {
  ExtensionTelemetry,
  MAX_TRACKED_DEBUG_SESSIONS,
  type TelemetryReporterLike,
} from '../../telemetry';

interface SentEvent {
  eventName: string;
  properties: Parameters<TelemetryReporterLike['sendTelemetryEvent']>[1];
  measurements: Parameters<TelemetryReporterLike['sendTelemetryEvent']>[2];
}

class RecordingReporter implements TelemetryReporterLike {
  readonly events: SentEvent[] = [];
  disposeCount = 0;

  sendTelemetryEvent(
    eventName: string,
    properties?: SentEvent['properties'],
    measurements?: SentEvent['measurements'],
  ): void {
    this.events.push({ eventName, properties, measurements });
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

class CountingReporter implements TelemetryReporterLike {
  eventCount = 0;
  disposeCount = 0;

  sendTelemetryEvent(): void {
    this.eventCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

function sendSessionStart(
  telemetry: ExtensionTelemetry,
  sessionKey: string,
): void {
  telemetry.sendDebugSessionStarted(sessionKey, {
    engine: 'experimental',
    source: 'launchConfiguration',
    hotReloadEnabled: true,
    justMyCode: true,
    redirectOutput: true,
  });
}

describe('Extension telemetry durability', function () {
  it('isolates reporter send, dispose, and diagnostics failures', async function () {
    const phases: string[] = [];
    const reporter: TelemetryReporterLike = {
      sendTelemetryEvent() {
        throw new Error('synthetic send failure');
      },
      async dispose() {
        throw new Error('synthetic dispose failure');
      },
    };
    const telemetry = new ExtensionTelemetry(reporter, {
      onError(phase) {
        phases.push(phase);
        throw new Error('synthetic diagnostics failure');
      },
    });

    assert.doesNotThrow(() => {
      telemetry.sendCommandInvoked('djangoProcessDebugger.setup');
      telemetry.sendMcpToolCompleted('django_debugger_status', 'failed', 1);
      sendSessionStart(telemetry, 'private-session');
      telemetry.sendDebugSessionTerminated('private-session');
    });
    await assert.doesNotReject(telemetry.shutdown());

    assert.deepStrictEqual(phases, ['send', 'send', 'send', 'send', 'dispose']);
  });

  it('bounds incomplete debug-session tracking and evicts the oldest entries', function () {
    const reporter = new RecordingReporter();
    let now = 1_000;
    const telemetry = new ExtensionTelemetry(reporter, { now: () => now });
    const overflow = 17;

    for (let index = 0; index < MAX_TRACKED_DEBUG_SESSIONS + overflow; index += 1) {
      sendSessionStart(telemetry, `private-session-${index}`);
    }
    now = 2_000;
    for (let index = 0; index < MAX_TRACKED_DEBUG_SESSIONS + overflow; index += 1) {
      telemetry.sendDebugSessionTerminated(`private-session-${index}`);
    }

    assert.strictEqual(
      reporter.events.filter((event) => event.eventName === 'debugSessionStarted').length,
      MAX_TRACKED_DEBUG_SESSIONS + overflow,
    );
    assert.strictEqual(
      reporter.events.filter((event) => event.eventName === 'debugSessionTerminated').length,
      MAX_TRACKED_DEBUG_SESSIONS,
    );
    assert.ok(!JSON.stringify(reporter.events).includes('private-session-'));
  });

  it('normalizes untrusted names and invalid measurements at the privacy boundary', function () {
    const reporter = new RecordingReporter();
    const telemetry = new ExtensionTelemetry(reporter);

    telemetry.sendMcpToolCompleted('../../workspace/private-tool', 'failed', Number.NaN);
    telemetry.sendCommandCompleted(
      'djangoProcessDebugger.attachToProcess',
      'failed',
      'activation',
      -50,
    );
    telemetry.sendHotReloadCompleted({
      outcome: 'failed',
      fileCount: -3.8,
      durationMs: Number.POSITIVE_INFINITY,
    });

    assert.deepStrictEqual(reporter.events, [
      {
        eventName: 'mcpToolCompleted',
        properties: { tool: 'unknown', outcome: 'failed' },
        measurements: { durationMs: 0 },
      },
      {
        eventName: 'commandCompleted',
        properties: {
          command: 'djangoProcessDebugger.attachToProcess',
          outcome: 'failed',
          stage: 'activation',
        },
        measurements: { durationMs: 0 },
      },
      {
        eventName: 'hotReloadCompleted',
        properties: { outcome: 'failed' },
        measurements: { fileCount: 0, durationMs: 0 },
      },
    ]);
    assert.ok(!JSON.stringify(reporter.events).includes('private-tool'));
  });

  it('keeps emitted event fields aligned with telemetry.json', function () {
    const reporter = new RecordingReporter();
    let now = 100;
    const telemetry = new ExtensionTelemetry(reporter, { now: () => now });

    telemetry.sendExtensionActivated({
      engine: 'experimental',
      hotReloadEnabled: true,
      mcpEnabled: true,
      workspaceTrusted: true,
      workspaceFolderCount: 1,
    });
    telemetry.sendCommandInvoked('djangoProcessDebugger.setup');
    telemetry.sendCommandCompleted('djangoProcessDebugger.setup', 'succeeded', 'setup', 10);
    telemetry.sendConfigurationChanged('engine', 'debugpy');
    telemetry.sendMcpToolCompleted('django_targets_list', 'succeeded', 20);
    telemetry.sendHotReloadCompleted({ outcome: 'skipped', fileCount: 2, durationMs: 30 });
    sendSessionStart(telemetry, 'schema-session');
    now = 150;
    telemetry.sendDebugSessionTerminated('schema-session');

    const schemaPath = path.resolve(__dirname, '../../../telemetry.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
      events: Record<string, Record<string, unknown>>;
    };
    assert.deepStrictEqual(Object.keys(schema.events).sort(), [
      'commandCompleted',
      'commandInvoked',
      'configurationChanged',
      'debugSessionStarted',
      'debugSessionTerminated',
      'extensionActivated',
      'hotReloadCompleted',
      'mcpToolCompleted',
    ]);

    for (const event of reporter.events) {
      const eventSchema = schema.events[event.eventName];
      assert.ok(eventSchema, `missing telemetry.json event: ${event.eventName}`);
      for (const property of Object.keys(event.properties ?? {})) {
        const field = eventSchema[property] as { isMeasurement?: boolean } | undefined;
        assert.ok(field, `missing property ${event.eventName}.${property}`);
        assert.notStrictEqual(field.isMeasurement, true);
      }
      for (const measurement of Object.keys(event.measurements ?? {})) {
        const field = eventSchema[measurement] as { isMeasurement?: boolean } | undefined;
        assert.ok(field, `missing measurement ${event.eventName}.${measurement}`);
        assert.strictEqual(field.isMeasurement, true);
      }
    }
  });

  it('handles 100,000 events and ignores new work once shutdown begins', async function () {
    const reporter = new CountingReporter();
    let releaseDispose: (() => void) | undefined;
    reporter.dispose = () => new Promise<void>((resolve) => {
      reporter.disposeCount += 1;
      releaseDispose = resolve;
    });
    const telemetry = new ExtensionTelemetry(reporter);

    for (let index = 0; index < 100_000; index += 1) {
      telemetry.sendCommandCompleted(
        'djangoProcessDebugger.showSetupStatus',
        'succeeded',
        'execution',
        index,
      );
    }
    assert.strictEqual(reporter.eventCount, 100_000);

    const firstShutdown = telemetry.shutdown();
    const secondShutdown = telemetry.shutdown();
    assert.strictEqual(firstShutdown, secondShutdown);
    telemetry.sendCommandInvoked('djangoProcessDebugger.setup');
    assert.strictEqual(reporter.eventCount, 100_000);
    assert.strictEqual(reporter.disposeCount, 1);

    assert.ok(releaseDispose);
    releaseDispose();
    await Promise.all([firstShutdown, secondShutdown]);
  });
});
