import { performance } from 'perf_hooks';
import { cpus, totalmem } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  ExtensionTelemetry,
  MAX_TRACKED_DEBUG_SESSIONS,
  type TelemetryReporterLike,
} from '../../telemetry';

interface BenchmarkSample {
  durationMs: number;
  heapDeltaBytes: number;
  rssDeltaBytes: number;
  operations: number;
  operationsPerSecond: number;
}

interface BenchmarkSummary {
  samples: BenchmarkSample[];
  medianOperationsPerSecond: number;
  p95DurationMs: number;
  maxHeapDeltaBytes: number;
  maxRssDeltaBytes: number;
}

class DigestingReporter implements TelemetryReporterLike {
  eventCount = 0;
  disposeCount = 0;
  digest = 2_166_136_261;

  sendTelemetryEvent(
    eventName: string,
    properties?: Parameters<TelemetryReporterLike['sendTelemetryEvent']>[1],
    measurements?: Parameters<TelemetryReporterLike['sendTelemetryEvent']>[2],
  ): void {
    this.eventCount += 1;
    this.digest = Math.imul(this.digest ^ eventName.length, 16_777_619);
    for (const [key, value] of Object.entries(properties ?? {})) {
      this.digest = Math.imul(this.digest ^ key.length, 16_777_619);
      this.digest = Math.imul(this.digest ^ String(value ?? '').length, 16_777_619);
    }
    for (const [key, value] of Object.entries(measurements ?? {})) {
      this.digest = Math.imul(this.digest ^ key.length, 16_777_619);
      this.digest = Math.imul(this.digest ^ Math.floor(value ?? 0), 16_777_619);
    }
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

class ThrowingReporter implements TelemetryReporterLike {
  attemptCount = 0;

  sendTelemetryEvent(): void {
    this.attemptCount += 1;
    throw new Error('synthetic reporter failure');
  }

  dispose(): void {
    // Nothing to release in the synthetic reporter.
  }
}

function forceGc(): void {
  if (!global.gc) {
    throw new Error('Run this benchmark with node --expose-gc.');
  }
  global.gc();
  global.gc();
}

function measure(operations: number, run: () => void): BenchmarkSample {
  forceGc();
  const memoryBefore = process.memoryUsage();
  const startedAt = performance.now();
  run();
  const durationMs = performance.now() - startedAt;
  forceGc();
  const memoryAfter = process.memoryUsage();
  return {
    durationMs,
    heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    operations,
    operationsPerSecond: operations / (durationMs / 1_000),
  };
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index];
}

function summarize(samples: BenchmarkSample[]): BenchmarkSummary {
  return {
    samples,
    medianOperationsPerSecond: percentile(
      samples.map((sample) => sample.operationsPerSecond),
      0.5,
    ),
    p95DurationMs: percentile(samples.map((sample) => sample.durationMs), 0.95),
    maxHeapDeltaBytes: Math.max(...samples.map((sample) => sample.heapDeltaBytes)),
    maxRssDeltaBytes: Math.max(...samples.map((sample) => sample.rssDeltaBytes)),
  };
}

function trackedSessionCount(telemetry: ExtensionTelemetry): number {
  const sessions = Reflect.get(telemetry, 'debugSessionStarts') as unknown;
  if (!(sessions instanceof Map)) {
    throw new Error('Unable to inspect telemetry session tracking invariant.');
  }
  return sessions.size;
}

function sendSessionStart(telemetry: ExtensionTelemetry, sessionKey: string): void {
  telemetry.sendDebugSessionStarted(sessionKey, {
    engine: 'experimental',
    source: 'launchConfiguration',
    hotReloadEnabled: true,
    justMyCode: true,
    redirectOutput: true,
  });
}

async function main(): Promise<void> {
  const steadyReporter = new DigestingReporter();
  const steadyTelemetry = new ExtensionTelemetry(steadyReporter);

  for (let index = 0; index < 100_000; index += 1) {
    steadyTelemetry.sendCommandCompleted(
      'djangoProcessDebugger.showSetupStatus',
      'succeeded',
      'execution',
      index,
    );
  }

  const steadySamples: BenchmarkSample[] = [];
  const eventsPerSample = 1_000_000;
  for (let sample = 0; sample < 5; sample += 1) {
    steadySamples.push(measure(eventsPerSample, () => {
      for (let index = 0; index < eventsPerSample; index += 1) {
        steadyTelemetry.sendCommandCompleted(
          'djangoProcessDebugger.showSetupStatus',
          'succeeded',
          'execution',
          index,
        );
      }
    }));
  }

  const sessionReporter = new DigestingReporter();
  const sessionTelemetry = new ExtensionTelemetry(sessionReporter);
  const sessionCycles = 500_000;
  const sessionChurn = measure(sessionCycles * 2, () => {
    for (let index = 0; index < sessionCycles; index += 1) {
      const sessionKey = `churn-${index}`;
      sendSessionStart(sessionTelemetry, sessionKey);
      sessionTelemetry.sendDebugSessionTerminated(sessionKey);
    }
  });
  const trackedAfterChurn = trackedSessionCount(sessionTelemetry);

  const overflowReporter = new DigestingReporter();
  const overflowTelemetry = new ExtensionTelemetry(overflowReporter);
  const overflowStarts = 500_000;
  const overflow = measure(overflowStarts, () => {
    for (let index = 0; index < overflowStarts; index += 1) {
      sendSessionStart(overflowTelemetry, `overflow-${index}`);
    }
  });
  const trackedAfterOverflow = trackedSessionCount(overflowTelemetry);

  const throwingReporter = new ThrowingReporter();
  let diagnosticsCount = 0;
  const failureTelemetry = new ExtensionTelemetry(throwingReporter, {
    onError: () => {
      diagnosticsCount += 1;
    },
  });
  const failureAttempts = 250_000;
  const failureStorm = measure(failureAttempts, () => {
    for (let index = 0; index < failureAttempts; index += 1) {
      failureTelemetry.sendCommandInvoked('djangoProcessDebugger.setup');
    }
  });

  const shutdownTelemetry = new ExtensionTelemetry(new DigestingReporter());
  const firstShutdown = shutdownTelemetry.shutdown();
  const shutdownCalls = 100_000;
  const shutdownRace = measure(shutdownCalls, () => {
    for (let index = 0; index < shutdownCalls; index += 1) {
      if (shutdownTelemetry.shutdown() !== firstShutdown) {
        throw new Error('shutdown() returned a different promise.');
      }
      shutdownTelemetry.sendCommandInvoked('djangoProcessDebugger.setup');
    }
  });
  await firstShutdown;

  if (steadyReporter.eventCount !== 5_100_000) {
    throw new Error(`Unexpected steady event count: ${steadyReporter.eventCount}`);
  }
  if (trackedAfterChurn !== 0) {
    throw new Error(`Session churn retained ${trackedAfterChurn} entries.`);
  }
  if (trackedAfterOverflow !== MAX_TRACKED_DEBUG_SESSIONS) {
    throw new Error(
      `Session tracking exceeded its bound: ${trackedAfterOverflow}/${MAX_TRACKED_DEBUG_SESSIONS}.`,
    );
  }
  if (throwingReporter.attemptCount !== failureAttempts
      || diagnosticsCount !== failureAttempts) {
    throw new Error(
      `Reporter failures were not fully isolated: ${throwingReporter.attemptCount}/${diagnosticsCount}.`,
    );
  }

  const result = {
    benchmark: 'telemetry-durability',
    generatedAt: new Date().toISOString(),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    invariants: {
      steadyEventsDelivered: steadyReporter.eventCount,
      sessionEventsDelivered: sessionReporter.eventCount,
      trackedAfterChurn,
      overflowStarts,
      trackedAfterOverflow,
      sessionTrackingLimit: MAX_TRACKED_DEBUG_SESSIONS,
      reporterFailuresIsolated: throwingReporter.attemptCount,
      diagnosticsCallbacks: diagnosticsCount,
      shutdownCalls,
      shutdownPromiseStable: true,
      reporterDigest: steadyReporter.digest,
    },
    measurements: {
      steadyDispatch: summarize(steadySamples),
      sessionChurn,
      sessionOverflow: overflow,
      reporterFailureStorm: failureStorm,
      shutdownRace,
    },
    processPeakRssBytes: process.resourceUsage().maxRSS * 1_024,
  };
  const resultPath = path.resolve('test-results/telemetry-durability-benchmark.json');
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ...result, resultPath }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
