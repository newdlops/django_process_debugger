import { createRequire } from 'module';
import type {
  TelemetryEventMeasurements,
  TelemetryEventProperties,
} from '@vscode/extension-telemetry';
import * as vscode from 'vscode';
import type { DebugEngine } from './debugEngine';

export const TELEMETRY_CONNECTION_STRING_ENV =
  'DJANGO_PROCESS_DEBUGGER_TELEMETRY_CONNECTION_STRING';

export type TelemetryCommandId =
  | 'djangoProcessDebugger.setup'
  | 'djangoProcessDebugger.showSetupStatus'
  | 'djangoProcessDebugger.attachToProcess'
  | 'djangoProcessDebugger.killProcess'
  | 'djangoProcessDebugger.reinstallDebugpy'
  | 'djangoProcessDebugger.cleanPythonLanguageServer'
  | 'djangoProcessDebugger.installMcp'
  | 'djangoProcessDebugger.repairMcp'
  | 'djangoProcessDebugger.verifyMcp'
  | 'djangoProcessDebugger.showMcpStatus';

export interface ExtensionActivatedTelemetry {
  engine: DebugEngine;
  hotReloadEnabled: boolean;
  mcpEnabled: boolean;
  workspaceTrusted: boolean;
  workspaceFolderCount: number;
}

export interface DebugSessionStartedTelemetry {
  engine: DebugEngine;
  hotReloadEnabled: boolean;
  justMyCode: boolean;
  redirectOutput: boolean;
}

export interface TelemetryReporterLike {
  sendTelemetryEvent(
    eventName: string,
    properties?: TelemetryEventProperties,
    measurements?: TelemetryEventMeasurements,
  ): void;
  dispose(): void | Promise<unknown>;
}

export type TelemetryReporterFactory = (
  connectionString: string,
) => TelemetryReporterLike;

const loadModule = createRequire(__filename);

interface DebugSessionStart {
  engine: DebugEngine;
  startedAt: number;
}

function asBooleanProperty(value: boolean): string {
  return value ? 'true' : 'false';
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve publisher-owned telemetry configuration without exposing an end-user
 * setting. Release builds can provide `telemetry.connectionString` in their
 * package manifest. The namespaced environment variable is useful for local
 * extension-host verification and CI.
 */
export function resolveTelemetryConnectionString(
  packageJSON: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const manifest = typeof packageJSON === 'object' && packageJSON !== null
    ? packageJSON as { telemetry?: { connectionString?: unknown } }
    : undefined;
  return nonEmptyString(manifest?.telemetry?.connectionString)
    ?? nonEmptyString(environment[TELEMETRY_CONNECTION_STRING_ENV]);
}

/**
 * Privacy boundary for extension telemetry. Callers provide only fixed enums,
 * booleans, counts, and durations; process ids, paths, workspace names, debug
 * data, error messages, and stacks never enter this class.
 */
export class ExtensionTelemetry implements vscode.Disposable {
  private readonly debugSessionStarts = new Map<string, DebugSessionStart>();
  private shutdownPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly reporter?: TelemetryReporterLike,
    private readonly now: () => number = Date.now,
  ) {}

  get isConfigured(): boolean {
    return this.reporter !== undefined;
  }

  sendExtensionActivated(event: ExtensionActivatedTelemetry): void {
    this.sendEvent(
      'extensionActivated',
      {
        engine: event.engine,
        hotReloadEnabled: asBooleanProperty(event.hotReloadEnabled),
        mcpEnabled: asBooleanProperty(event.mcpEnabled),
        workspaceTrusted: asBooleanProperty(event.workspaceTrusted),
      },
      { workspaceFolderCount: event.workspaceFolderCount },
    );
  }

  sendCommandInvoked(command: TelemetryCommandId): void {
    this.sendEvent('commandInvoked', { command });
  }

  sendDebugSessionStarted(
    sessionKey: string,
    event: DebugSessionStartedTelemetry,
  ): void {
    if (this.disposed || !this.reporter) {
      return;
    }
    this.debugSessionStarts.set(sessionKey, {
      engine: event.engine,
      startedAt: this.now(),
    });
    this.sendEvent('debugSessionStarted', {
      engine: event.engine,
      hotReloadEnabled: asBooleanProperty(event.hotReloadEnabled),
      justMyCode: asBooleanProperty(event.justMyCode),
      redirectOutput: asBooleanProperty(event.redirectOutput),
    });
  }

  sendDebugSessionTerminated(sessionKey: string): void {
    const started = this.debugSessionStarts.get(sessionKey);
    this.debugSessionStarts.delete(sessionKey);
    if (!started) {
      return;
    }
    this.sendEvent(
      'debugSessionTerminated',
      { engine: started.engine },
      { durationMs: Math.max(0, this.now() - started.startedAt) },
    );
  }

  private sendEvent(
    eventName: string,
    properties?: TelemetryEventProperties,
    measurements?: TelemetryEventMeasurements,
  ): void {
    if (this.disposed) {
      return;
    }
    this.reporter?.sendTelemetryEvent(eventName, properties, measurements);
  }

  dispose(): void {
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.disposed = true;
      this.debugSessionStarts.clear();
      await this.reporter?.dispose();
    })();
    return this.shutdownPromise;
  }
}

export function createExtensionTelemetry(
  context: vscode.ExtensionContext,
  reporterFactory: TelemetryReporterFactory = (connectionString) => {
    const { TelemetryReporter } = loadModule('@vscode/extension-telemetry') as
      typeof import('@vscode/extension-telemetry');
    return new TelemetryReporter(
      connectionString,
      undefined,
      { ignoreUnhandledErrors: true },
    );
  },
): ExtensionTelemetry {
  const connectionString = resolveTelemetryConnectionString(
    context.extension.packageJSON,
  );
  return new ExtensionTelemetry(
    connectionString ? reporterFactory(connectionString) : undefined,
  );
}
