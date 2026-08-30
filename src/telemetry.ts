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

export type TelemetryOutcome =
  | 'succeeded'
  | 'cancelled'
  | 'blocked'
  | 'failed'
  | 'noAction';

export type TelemetryCommandStage =
  | 'discovery'
  | 'selection'
  | 'preflight'
  | 'setup'
  | 'activation'
  | 'confirmation'
  | 'execution'
  | 'sessionStart'
  | 'verification';

export type DebugSessionSource = 'command' | 'mcp' | 'launchConfiguration';

export type TelemetryConfigurationSetting =
  | 'engine'
  | 'justMyCode'
  | 'redirectOutput'
  | 'hotReload'
  | 'mcp.enabled'
  | 'mcp.allowControl'
  | 'mcp.allowEvaluate';

export type TelemetryConfigurationValue = DebugEngine | 'true' | 'false';

export type HotReloadOutcome =
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'timedOut'
  | 'cancelled';

export const TELEMETRY_MCP_TOOL_NAMES = [
  'django_debugger_status',
  'django_targets_list',
  'django_session_start',
  'django_breakpoints_update',
  'django_execution_wait',
  'django_session_wait_ready',
  'django_breakpoints_status',
  'django_state_snapshot',
  'django_variables_expand',
  'django_request_context',
  'django_failure_snapshot',
  'django_expression_inspect',
  'django_execution_control',
] as const;

export type TelemetryMcpToolName =
  | typeof TELEMETRY_MCP_TOOL_NAMES[number]
  | 'unknown';

export const MAX_TRACKED_DEBUG_SESSIONS = 256;

export interface ExtensionActivatedTelemetry {
  engine: DebugEngine;
  hotReloadEnabled: boolean;
  mcpEnabled: boolean;
  workspaceTrusted: boolean;
  workspaceFolderCount: number;
}

export interface DebugSessionStartedTelemetry {
  engine: DebugEngine;
  source: DebugSessionSource;
  hotReloadEnabled: boolean;
  justMyCode: boolean;
  redirectOutput: boolean;
}

export interface HotReloadCompletedTelemetry {
  outcome: HotReloadOutcome;
  fileCount: number;
  durationMs: number;
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

export interface ExtensionTelemetryOptions {
  now?: () => number;
  onError?: (phase: 'send' | 'dispose', error: unknown) => void;
  maxTrackedDebugSessions?: number;
}

const loadModule = createRequire(__filename);

interface DebugSessionStart {
  engine: DebugEngine;
  source: DebugSessionSource;
  startedAt: number;
}

function asBooleanProperty(value: boolean): string {
  return value ? 'true' : 'false';
}

function nonNegativeMeasurement(value: number, integer = false): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const normalized = Math.max(0, value);
  return integer ? Math.floor(normalized) : normalized;
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
  private readonly now: () => number;
  private readonly onError?: ExtensionTelemetryOptions['onError'];
  private readonly maxTrackedDebugSessions: number;
  private shutdownPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly reporter?: TelemetryReporterLike,
    options: ExtensionTelemetryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
    this.maxTrackedDebugSessions = Number.isInteger(options.maxTrackedDebugSessions)
      && (options.maxTrackedDebugSessions ?? 0) > 0
      ? options.maxTrackedDebugSessions!
      : MAX_TRACKED_DEBUG_SESSIONS;
  }

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
      { workspaceFolderCount: nonNegativeMeasurement(event.workspaceFolderCount, true) },
    );
  }

  sendCommandInvoked(command: TelemetryCommandId): void {
    this.sendEvent('commandInvoked', { command });
  }

  sendCommandCompleted(
    command: TelemetryCommandId,
    outcome: TelemetryOutcome,
    stage: TelemetryCommandStage,
    durationMs: number,
  ): void {
    this.sendEvent(
      'commandCompleted',
      { command, outcome, stage },
      { durationMs: nonNegativeMeasurement(durationMs) },
    );
  }

  sendConfigurationChanged(
    setting: TelemetryConfigurationSetting,
    value: TelemetryConfigurationValue,
  ): void {
    this.sendEvent('configurationChanged', { setting, value });
  }

  sendMcpToolCompleted(
    tool: string,
    outcome: Exclude<TelemetryOutcome, 'noAction'>,
    durationMs: number,
  ): void {
    const knownTool = (TELEMETRY_MCP_TOOL_NAMES as readonly string[]).includes(tool)
      ? tool as TelemetryMcpToolName
      : 'unknown';
    this.sendEvent(
      'mcpToolCompleted',
      { tool: knownTool, outcome },
      { durationMs: nonNegativeMeasurement(durationMs) },
    );
  }

  sendHotReloadCompleted(event: HotReloadCompletedTelemetry): void {
    this.sendEvent(
      'hotReloadCompleted',
      { outcome: event.outcome },
      {
        fileCount: nonNegativeMeasurement(event.fileCount, true),
        durationMs: nonNegativeMeasurement(event.durationMs),
      },
    );
  }

  sendDebugSessionStarted(
    sessionKey: string,
    event: DebugSessionStartedTelemetry,
  ): void {
    if (this.disposed || !this.reporter) {
      return;
    }
    this.debugSessionStarts.delete(sessionKey);
    while (this.debugSessionStarts.size >= this.maxTrackedDebugSessions) {
      const oldestSessionKey = this.debugSessionStarts.keys().next().value;
      if (oldestSessionKey === undefined) {
        break;
      }
      this.debugSessionStarts.delete(oldestSessionKey);
    }
    this.debugSessionStarts.set(sessionKey, {
      engine: event.engine,
      source: event.source,
      startedAt: this.now(),
    });
    this.sendEvent('debugSessionStarted', {
      engine: event.engine,
      source: event.source,
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
      { engine: started.engine, source: started.source },
      { durationMs: nonNegativeMeasurement(this.now() - started.startedAt) },
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
    try {
      this.reporter?.sendTelemetryEvent(eventName, properties, measurements);
    } catch (error) {
      this.reportFailure('send', error);
    }
  }

  private reportFailure(phase: 'send' | 'dispose', error: unknown): void {
    try {
      this.onError?.(phase, error);
    } catch {
      // Telemetry and its diagnostics must never interrupt extension behavior.
    }
  }

  dispose(): void {
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.disposed = true;
      this.debugSessionStarts.clear();
      try {
        await this.reporter?.dispose();
      } catch (error) {
        this.reportFailure('dispose', error);
      }
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
  options: ExtensionTelemetryOptions = {},
): ExtensionTelemetry {
  const connectionString = resolveTelemetryConnectionString(
    context.extension.packageJSON,
  );
  return new ExtensionTelemetry(
    connectionString ? reporterFactory(connectionString) : undefined,
    options,
  );
}
