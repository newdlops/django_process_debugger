import { randomUUID } from 'crypto';
import { realpath as fsRealpath, stat as fsStat } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugEngine, normalizeDebugEngine } from '../debugEngine';
import { DjangoProcess, DjangoProcessFinder } from '../processFinder';
import type { McpTransportBackend } from './transport';

export const DJANGO_MCP_SESSION_REF_CONFIG_KEY =
  '__djangoProcessDebuggerMcpSessionRef';

const DEBUG_TYPE = 'django-process';
const DEFAULT_TARGET_TTL_MS = 60_000;
const MAX_EVENT_HISTORY = 256;
const MAX_BREAKPOINTS = 200;
const MAX_THREADS = 16;
const MAX_STACK_FRAMES = 100;
const MAX_VARIABLES = 100;
const MAX_TEXT_LENGTH = 4_000;
const MAX_STALE_REF_HISTORY = 2_048;
const MAX_ACTIVE_FRAME_REFS = 4_096;
const MAX_ACTIVE_VARIABLE_REFS = 4_096;
const MAX_INSPECTION_EXPRESSION_LENGTH = 256;
const DEFAULT_SESSION_READY_TIMEOUT_MS = 10_000;
const DJANGO_REQUEST_BRIDGE_MODES = new Set([
  'wsgi-sync',
  'asgi-sync',
  'asgi-async',
]);
const DJANGO_REQUEST_BRIDGE_OUTCOMES = new Set([
  'trace-enabled',
  'process-mismatch',
  'tracer-disabled',
  'session-not-configured',
  'client-detached',
  'interpreter-finalizing',
  'thread-exempt',
  'debugger-internal-thread',
  'conflicting-trace-hook',
  'internal-error',
]);

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: 'application/json';
}

export interface McpResourceContents {
  uri: string;
  mimeType: 'application/json';
  text: string;
}

export interface McpControllerErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type McpToolCallResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: McpControllerErrorShape };

export class McpControllerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpControllerError';
  }
}

export interface DjangoProcessFinderLike {
  findDjangoProcesses(): Promise<DjangoProcess[]>;
  resolveDebuggablePid(pid: number): Promise<{ pid: number; pythonPath: string }>;
}

export interface DjangoMcpDebugControllerOptions {
  processFinder: Pick<
    DjangoProcessFinder,
    'findDjangoProcesses' | 'resolveDebuggablePid'
  > | DjangoProcessFinderLike;
  getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  getEngine?: () => DebugEngine;
  getJustMyCode?: () => boolean;
  getRedirectOutput?: () => boolean;
  getRuntimeStatus?: () => unknown | Promise<unknown>;
  startDebugging?: (
    folder: vscode.WorkspaceFolder,
    configuration: vscode.DebugConfiguration,
  ) => Promise<boolean>;
  stopDebugging?: (session: vscode.DebugSession) => Promise<boolean>;
  addBreakpoints?: (breakpoints: readonly vscode.Breakpoint[]) => void;
  removeBreakpoints?: (breakpoints: readonly vscode.Breakpoint[]) => void;
  realpath?: (filePath: string) => Promise<string>;
  stat?: (filePath: string) => Promise<{ isFile(): boolean }>;
  now?: () => number;
  targetTtlMs?: number;
  windowId?: string;
}

interface CanonicalWorkspaceRoot {
  folder: vscode.WorkspaceFolder;
  canonicalPath: string;
}

interface TargetRecord {
  targetRef: string;
  sourcePid: number;
  pid: number;
  pythonPath: string;
  process: DjangoProcess;
  folder: vscode.WorkspaceFolder;
  canonicalCwd: string;
  isWorker: boolean;
  expiresAt: number;
}

type SessionState =
  | 'starting'
  | 'running'
  | 'stopped'
  | 'terminating'
  | 'terminated';

interface SessionEvent extends Record<string, unknown> {
  cursor: number;
  event: string;
  timestamp: number;
}

interface SessionRecord {
  sessionRef: string;
  session?: vscode.DebugSession;
  sessionId?: string;
  name: string;
  folder?: vscode.WorkspaceFolder;
  engine: DebugEngine;
  pid?: number;
  state: SessionState;
  adapterReady: boolean;
  controlInFlight: boolean;
  stopEpoch: number;
  stopRef?: string;
  stoppedThreadId?: number;
  stopReason?: string;
  stopDescription?: string;
  threadIds: number[];
  events: SessionEvent[];
  nextCursor: number;
  waiters: Set<() => void>;
}

interface StopRecord {
  stopRef: string;
  sessionRef: string;
  epoch: number;
}

interface FrameRecord {
  frameRef: string;
  sessionRef: string;
  epoch: number;
  frameId: number;
  threadId: number;
}

interface VariablesRecord {
  variablesRef: string;
  sessionRef: string;
  epoch: number;
  dapReference: number;
}

interface OwnedBreakpoint {
  breakpoint: vscode.SourceBreakpoint;
  source: string;
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

interface DapEventMessage {
  type: 'event';
  event: string;
  body?: Record<string, unknown>;
}

interface DapResponseMessage {
  type: 'response';
  command: string;
  success: boolean;
}

const DAP_STARTUP_COMMANDS = new Set(['initialize', 'attach', 'configurationDone']);

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: 'django_debugger_status',
    description: 'Show the debugger state owned by this VS Code window.',
    inputSchema: noArgumentsSchema(),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_targets_list',
    description: 'List attachable Django and Celery targets, including verified Django listener ownership and network labels when available.',
    inputSchema: noArgumentsSchema(),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_session_start',
    description: 'Start a normal django-process debug session using an opaque target reference.',
    inputSchema: objectSchema({
      targetRef: { type: 'string', minLength: 1 },
    }, ['targetRef']),
    annotations: mutationAnnotations(false, false),
  },
  {
    name: 'django_breakpoints_update',
    description: 'Replace only the source breakpoints owned by this MCP controller.',
    inputSchema: objectSchema({
      breakpoints: {
        type: 'array',
        maxItems: MAX_BREAKPOINTS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'line'],
          properties: {
            path: { type: 'string', minLength: 1 },
            workspaceFolder: { type: 'string', minLength: 1 },
            line: { type: 'integer', minimum: 1 },
            column: { type: 'integer', minimum: 1 },
            condition: { type: 'string', minLength: 1 },
            hitCondition: { type: 'string', minLength: 1 },
            logMessage: { type: 'string', minLength: 1 },
          },
        },
      },
    }, ['breakpoints']),
    annotations: mutationAnnotations(true, true),
  },
  {
    name: 'django_execution_wait',
    description: 'Wait for debugger lifecycle events after a per-session cursor.',
    inputSchema: objectSchema({
      sessionRef: { type: 'string', minLength: 1 },
      cursor: { type: 'integer', minimum: 0 },
      timeoutMs: { type: 'integer', minimum: 0, maximum: 30_000 },
    }, ['sessionRef']),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_session_wait_ready',
    description: 'Wait until a newly requested debug session becomes ready, terminates, or times out.',
    inputSchema: objectSchema({
      sessionRef: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 0, maximum: 30_000 },
    }, ['sessionRef']),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_breakpoints_status',
    description: 'Read adapter verification, relocated positions, and experimental thread-trace coverage.',
    inputSchema: objectSchema({
      sessionRef: { type: 'string', minLength: 1 },
    }, []),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_state_snapshot',
    description: 'Read bounded threads, stacks, scopes, variables, and exception state while stopped.',
    inputSchema: objectSchema({
      sessionRef: { type: 'string', minLength: 1 },
      stopRef: {
        type: 'string',
        minLength: 1,
        description: 'Optional current stop capability; when supplied, stale snapshots are rejected.',
      },
      frameRef: { type: 'string', minLength: 1 },
      maxThreads: { type: 'integer', minimum: 1, maximum: MAX_THREADS },
      maxFrames: { type: 'integer', minimum: 1, maximum: MAX_STACK_FRAMES },
      maxVariables: { type: 'integer', minimum: 1, maximum: MAX_VARIABLES },
    }, ['sessionRef']),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_variables_expand',
    description: 'Expand a variables reference that belongs to the current stop epoch.',
    inputSchema: objectSchema({
      variablesRef: { type: 'string', minLength: 1 },
      start: { type: 'integer', minimum: 0 },
      count: { type: 'integer', minimum: 1, maximum: MAX_VARIABLES },
    }, ['variablesRef']),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_request_context',
    description: 'Summarize Django request, user, view, self, args, and kwargs variables from a current frame without evaluating expressions.',
    inputSchema: objectSchema({
      frameRef: { type: 'string', minLength: 1 },
      maxVariables: { type: 'integer', minimum: 1, maximum: MAX_VARIABLES },
    }, ['frameRef']),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_failure_snapshot',
    description: 'Capture a bounded stopped-session snapshot with exception and test-like frame summaries.',
    inputSchema: objectSchema({
      sessionRef: { type: 'string', minLength: 1 },
      stopRef: {
        type: 'string',
        minLength: 1,
        description: 'Optional stop capability used to select and validate the failure snapshot.',
      },
      maxThreads: { type: 'integer', minimum: 1, maximum: MAX_THREADS },
      maxFrames: { type: 'integer', minimum: 1, maximum: MAX_STACK_FRAMES },
      maxVariables: { type: 'integer', minimum: 1, maximum: MAX_VARIABLES },
    }, []),
    annotations: readOnlyAnnotations(),
  },
  {
    name: 'django_expression_inspect',
    description: 'Inspect a restricted identifier/attribute/index path in a current frame. Calls, operators, assignments, and dunder access are rejected.',
    inputSchema: objectSchema({
      frameRef: { type: 'string', minLength: 1 },
      expression: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_INSPECTION_EXPRESSION_LENGTH,
        description: 'A path such as request.user.email or request.GET["page"].',
      },
    }, ['frameRef', 'expression']),
    // Python attribute access can execute properties, so clients must treat
    // even this restricted form as an explicitly approved mutation-capable call.
    annotations: mutationAnnotations(true, false),
  },
  {
    name: 'django_execution_control',
    description: 'Pause, resume, step, or disconnect an opaque debugger session.',
    inputSchema: objectSchema({
      sessionRef: { type: 'string', minLength: 1 },
      stopRef: {
        type: 'string',
        minLength: 1,
        description: 'Required for continue, next, stepIn, and stepOut to prevent resuming a newer stop by mistake.',
      },
      action: {
        type: 'string',
        enum: ['pause', 'continue', 'next', 'stepIn', 'stepOut', 'disconnect'],
      },
    }, ['sessionRef', 'action']),
    annotations: mutationAnnotations(true, false),
  },
]);

const RESOURCE_DEFINITIONS: readonly McpResourceDefinition[] = Object.freeze([
  {
    uri: 'django-debugger://status',
    name: 'Django debugger status',
    description: 'Window, workspace, session, and controller status.',
    mimeType: 'application/json',
  },
  {
    uri: 'django-debugger://sessions',
    name: 'Django debugger sessions',
    description: 'Opaque session references and their current execution state.',
    mimeType: 'application/json',
  },
  {
    uri: 'django-debugger://breakpoints',
    name: 'MCP-owned breakpoints',
    description: 'Source breakpoints created by this controller only.',
    mimeType: 'application/json',
  },
]);

function noArgumentsSchema(): Record<string, unknown> {
  return objectSchema({}, []);
}

function readOnlyAnnotations(): NonNullable<McpToolDefinition['annotations']> {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function mutationAnnotations(
  destructive: boolean,
  idempotent: boolean,
): NonNullable<McpToolDefinition['annotations']> {
  return {
    readOnlyHint: false,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: false,
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDapEventMessage(value: unknown): value is DapEventMessage {
  return isRecord(value)
    && value.type === 'event'
    && typeof value.event === 'string'
    && (value.body === undefined || isRecord(value.body));
}

function isDapResponseMessage(value: unknown): value is DapResponseMessage {
  return isRecord(value)
    && value.type === 'response'
    && typeof value.command === 'string'
    && typeof value.success === 'boolean';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function truncate(value: unknown, maximum = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1))}\u2026`;
}

function snapshotDjangoProcess(processInfo: DjangoProcess): DjangoProcess {
  return {
    ...processInfo,
    workerPids: processInfo.workerPids ? [...processInfo.workerPids] : undefined,
    endpoints: processInfo.endpoints?.map((endpoint) => ({ ...endpoint })),
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof McpControllerError) {
    return error.details;
  }
  return undefined;
}

export class DjangoMcpDebugController {
  private readonly processFinder: DjangoProcessFinderLike;
  private readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  private readonly getEngine: () => DebugEngine;
  private readonly getJustMyCode: () => boolean;
  private readonly getRedirectOutput: () => boolean;
  private readonly getRuntimeStatus?: () => unknown | Promise<unknown>;
  private readonly startDebugging: DjangoMcpDebugControllerOptions['startDebugging'];
  private readonly stopDebugging: DjangoMcpDebugControllerOptions['stopDebugging'];
  private readonly addBreakpoints: NonNullable<DjangoMcpDebugControllerOptions['addBreakpoints']>;
  private readonly removeBreakpoints: NonNullable<DjangoMcpDebugControllerOptions['removeBreakpoints']>;
  private readonly realpath: NonNullable<DjangoMcpDebugControllerOptions['realpath']>;
  private readonly stat: NonNullable<DjangoMcpDebugControllerOptions['stat']>;
  private readonly now: () => number;
  private readonly targetTtlMs: number;
  private windowId?: string;

  private readonly targets = new Map<string, TargetRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionsById = new Map<string, SessionRecord>();
  private readonly stops = new Map<string, StopRecord>();
  private readonly frames = new Map<string, FrameRecord>();
  private readonly variables = new Map<string, VariablesRecord>();
  private readonly staleStops = new Set<string>();
  private readonly staleFrames = new Set<string>();
  private readonly staleVariables = new Set<string>();
  private ownedBreakpoints: OwnedBreakpoint[] = [];

  constructor(options: DjangoMcpDebugControllerOptions) {
    this.processFinder = options.processFinder;
    this.getWorkspaceFolders = options.getWorkspaceFolders;
    this.getEngine = options.getEngine ?? (() => 'debugpy');
    this.getJustMyCode = options.getJustMyCode ?? (() => true);
    this.getRedirectOutput = options.getRedirectOutput ?? (() => true);
    this.getRuntimeStatus = options.getRuntimeStatus;
    this.startDebugging = options.startDebugging
      ?? ((folder, configuration) => Promise.resolve(
        vscode.debug.startDebugging(folder, configuration),
      ));
    this.stopDebugging = options.stopDebugging
      ?? (async (session) => {
        await vscode.debug.stopDebugging(session);
        return true;
      });
    this.addBreakpoints = options.addBreakpoints
      ?? ((breakpoints) => vscode.debug.addBreakpoints(breakpoints));
    this.removeBreakpoints = options.removeBreakpoints
      ?? ((breakpoints) => vscode.debug.removeBreakpoints(breakpoints));
    this.realpath = options.realpath ?? fsRealpath;
    this.stat = options.stat ?? fsStat;
    this.now = options.now ?? Date.now;
    this.targetTtlMs = options.targetTtlMs ?? DEFAULT_TARGET_TTL_MS;
    if (options.windowId !== undefined) {
      this.setWindowId(options.windowId);
    }

    if (!Number.isInteger(this.targetTtlMs) || this.targetTtlMs <= 0) {
      throw new TypeError('targetTtlMs must be a positive integer.');
    }
  }

  static readonly toolDefinitions = TOOL_DEFINITIONS;
  static readonly resourceDefinitions = RESOURCE_DEFINITIONS;

  listToolDefinitions(): readonly McpToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  listResourceDefinitions(): readonly McpResourceDefinition[] {
    return RESOURCE_DEFINITIONS;
  }

  /** Update the public window identity after an endpoint collision recovery. */
  setWindowId(windowId: string): void {
    if (
      typeof windowId !== 'string'
      || windowId.trim().length === 0
      || windowId.length > 256
      || windowId.includes('\0')
    ) {
      throw new TypeError('windowId must be a non-empty string of at most 256 characters.');
    }
    this.windowId = windowId;
  }

  /** Adapt the controller's structured outcomes to the MCP transport contract. */
  asTransportBackend(): McpTransportBackend {
    return {
      listTools: () => this.listToolDefinitions(),
      callTool: async (name, args, context) => {
        const result = await this.callTool(name, args, context.signal);
        return {
          structuredContent: result,
          text: JSON.stringify(result),
          isError: !result.ok,
        };
      },
      listResources: () => this.listResourceDefinitions(),
      readResource: async (uri) => {
        try {
          const contents = await this.readResource(uri);
          return { contents: [contents] };
        } catch (error) {
          if (error instanceof McpControllerError && error.code === 'RESOURCE_NOT_FOUND') {
            return undefined;
          }
          throw error;
        }
      },
    };
  }

  async callTool(
    name: string,
    args: unknown = {},
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    try {
      let result: Record<string, unknown>;
      switch (name) {
        case 'django_debugger_status':
          this.expectArguments(args, []);
          result = await this.getStatus();
          break;
        case 'django_targets_list':
          this.expectArguments(args, []);
          result = await this.listTargets();
          break;
        case 'django_session_start':
          result = await this.startSession(args);
          break;
        case 'django_breakpoints_update':
          result = await this.updateBreakpoints(args);
          break;
        case 'django_execution_wait':
          result = await this.waitForExecution(args, signal);
          break;
        case 'django_session_wait_ready':
          result = await this.waitForSessionReady(args, signal);
          break;
        case 'django_breakpoints_status':
          result = await this.breakpointsStatus(args);
          break;
        case 'django_state_snapshot':
          result = await this.stateSnapshot(args);
          break;
        case 'django_variables_expand':
          result = await this.expandVariables(args);
          break;
        case 'django_request_context':
          result = await this.requestContext(args);
          break;
        case 'django_failure_snapshot':
          result = await this.failureSnapshot(args);
          break;
        case 'django_expression_inspect':
          result = await this.inspectExpression(args);
          break;
        case 'django_execution_control':
          result = await this.controlExecution(args);
          break;
        default:
          throw new McpControllerError('TOOL_NOT_FOUND', `Unknown tool: ${name}`);
      }
      return { ok: true, ...result };
    } catch (error) {
      const normalized = error instanceof McpControllerError
        ? error
        : new McpControllerError('INTERNAL_ERROR', 'The debugger controller failed unexpectedly.');
      return {
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(errorDetails(normalized) ? { details: errorDetails(normalized) } : {}),
        },
      };
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    this.purgeExpiredTargets();
    const folders = this.getWorkspaceFolders() ?? [];
    const runtime = this.getRuntimeStatus
      ? await this.getRuntimeStatus()
      : undefined;
    return {
      ...(this.windowId ? { windowId: this.windowId } : {}),
      debugType: DEBUG_TYPE,
      workspaceFolders: folders.map((folder) => ({
        name: folder.name,
        uri: folder.uri.toString(),
      })),
      targetRefs: this.targets.size,
      breakpoints: this.ownedBreakpoints.length,
      sessions: this.sessionSummaries(),
      ...(runtime === undefined ? {} : { runtime }),
    };
  }

  async readResource(uri: string): Promise<McpResourceContents> {
    let value: unknown;
    switch (uri) {
      case 'django-debugger://status':
        value = await this.getStatus();
        break;
      case 'django-debugger://sessions':
        value = { sessions: this.sessionSummaries() };
        break;
      case 'django-debugger://breakpoints':
        value = { breakpoints: this.breakpointSummaries() };
        break;
      default:
        throw new McpControllerError('RESOURCE_NOT_FOUND', `Unknown resource: ${uri}`);
    }
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(value, null, 2),
    };
  }

  async listTargets(): Promise<Record<string, unknown>> {
    this.purgeExpiredTargets();
    const roots = await this.canonicalWorkspaceRoots();
    if (roots.length === 0) {
      throw new McpControllerError(
        'NO_WORKSPACE',
        'This VS Code window has no local workspace folders.',
      );
    }

    let processes: DjangoProcess[];
    try {
      processes = await this.processFinder.findDjangoProcesses();
    } catch {
      throw new McpControllerError(
        'DISCOVERY_FAILED',
        'Django and Celery process discovery failed.',
      );
    }

    const targets: Array<Record<string, unknown>> = [];
    const seenResolvedPids = new Set<number>();
    let excludedOutsideWorkspace = 0;
    let resolutionFailures = 0;

    for (const processInfo of processes) {
      const scope = await this.scopeForProcess(processInfo, roots);
      if (!scope) {
        excludedOutsideWorkspace++;
        continue;
      }

      const candidatePids = processInfo.workerPids && processInfo.workerPids.length > 0
        ? [...new Set(processInfo.workerPids.filter(isPositiveInteger))]
        : [processInfo.pid];

      for (const candidatePid of candidatePids) {
        let resolved: { pid: number; pythonPath: string };
        try {
          resolved = await this.processFinder.resolveDebuggablePid(candidatePid);
        } catch {
          resolutionFailures++;
          continue;
        }
        if (!isPositiveInteger(resolved.pid) || seenResolvedPids.has(resolved.pid)) {
          continue;
        }
        seenResolvedPids.add(resolved.pid);

        const targetRef = this.newRef('target');
        const isWorker = candidatePid !== processInfo.pid
          || (processInfo.workerPids?.includes(candidatePid) ?? false);
        this.targets.set(targetRef, {
          targetRef,
          sourcePid: candidatePid,
          pid: resolved.pid,
          pythonPath: resolved.pythonPath,
          process: snapshotDjangoProcess(processInfo),
          folder: scope.folder,
          canonicalCwd: scope.canonicalCwd,
          isWorker,
          expiresAt: this.now() + this.targetTtlMs,
        });

        const relativeCwd = path.relative(scope.canonicalRoot, scope.canonicalCwd) || '.';
        targets.push({
          targetRef,
          type: processInfo.type,
          workspaceFolder: scope.folder.name,
          cwd: relativeCwd,
          command: truncate(processInfo.command, 1_000),
          python: path.basename(resolved.pythonPath),
          architecture: processInfo.arch,
          isWorker,
          endpoints: this.publicEndpoints(processInfo),
          ...(truncate(processInfo.networkName, 256)
            ? { network: truncate(processInfo.networkName, 256) }
            : {}),
          ...(processInfo.type === 'django'
            && typeof processInfo.endpointVerified === 'boolean'
            ? { servesTraffic: processInfo.endpointVerified }
            : {}),
          expiresAt: new Date(this.now() + this.targetTtlMs).toISOString(),
        });
      }
    }

    return {
      targets,
      excludedOutsideWorkspace,
      resolutionFailures,
      targetTtlMs: this.targetTtlMs,
    };
  }

  async startSession(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['targetRef']);
    const targetRef = this.expectString(input.targetRef, 'targetRef', 256);
    const target = this.targets.get(targetRef);
    if (!target) {
      throw new McpControllerError(
        'TARGET_NOT_FOUND',
        'The target reference is unknown or expired. Run django_targets_list again.',
      );
    }
    if (target.expiresAt <= this.now()) {
      this.targets.delete(targetRef);
      throw new McpControllerError(
        'TARGET_EXPIRED',
        'The target reference expired. Run django_targets_list again.',
      );
    }
    // Capabilities are one-shot. Consume before any await so two concurrent
    // calls can never attach twice with the same target reference.
    this.targets.delete(targetRef);
    await this.revalidateTarget(target);

    const sessionRef = this.newRef('session');
    const engine = normalizeDebugEngine(this.getEngine());
    const label = target.process.type === 'celery' ? 'Celery Worker' : 'Django';
    const record: SessionRecord = {
      sessionRef,
      name: `${label} via MCP`,
      folder: target.folder,
      engine,
      pid: target.pid,
      state: 'starting',
      adapterReady: false,
      controlInFlight: false,
      stopEpoch: 0,
      threadIds: [],
      events: [],
      nextCursor: 1,
      waiters: new Set(),
    };
    this.sessions.set(sessionRef, record);
    this.appendEvent(record, 'starting', { state: 'starting' });

    const configuration: vscode.DebugConfiguration = {
      type: DEBUG_TYPE,
      request: 'attach',
      name: record.name,
      pid: target.pid,
      engine,
      host: '127.0.0.1',
      port: 0,
      justMyCode: this.getJustMyCode(),
      redirectOutput: this.getRedirectOutput(),
      [DJANGO_MCP_SESSION_REF_CONFIG_KEY]: sessionRef,
    };

    let started: boolean;
    try {
      started = await this.startDebugging!(target.folder, configuration);
    } catch {
      this.discardRejectedSession(record);
      throw new McpControllerError(
        'SESSION_START_FAILED',
        'VS Code could not start the django-process debug session.',
      );
    }
    if (!started) {
      this.discardRejectedSession(record);
      throw new McpControllerError(
        'SESSION_START_REJECTED',
        'VS Code rejected the django-process debug session.',
      );
    }

    return {
      sessionRef,
      state: record.state,
      cursor: record.nextCursor - 1,
      workspaceFolder: target.folder.name,
      engine,
    };
  }

  async updateBreakpoints(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['breakpoints']);
    if (!Array.isArray(input.breakpoints)) {
      throw new McpControllerError('INVALID_ARGUMENT', 'breakpoints must be an array.');
    }
    if (input.breakpoints.length > MAX_BREAKPOINTS) {
      throw new McpControllerError(
        'INVALID_ARGUMENT',
        `At most ${MAX_BREAKPOINTS} breakpoints may be supplied.`,
      );
    }

    const roots = await this.canonicalWorkspaceRoots();
    if (roots.length === 0) {
      throw new McpControllerError(
        'NO_WORKSPACE',
        'This VS Code window has no local workspace folders.',
      );
    }

    const next: OwnedBreakpoint[] = [];
    const locations = new Set<string>();
    for (const raw of input.breakpoints) {
      const spec = this.expectBreakpoint(raw);
      const source = await this.resolveBreakpointSource(
        spec.path,
        spec.workspaceFolder,
        roots,
      );
      const locationKey = `${source.canonicalPath}:${spec.line}:${spec.column ?? 1}`;
      if (locations.has(locationKey)) {
        throw new McpControllerError(
          'DUPLICATE_BREAKPOINT',
          `Duplicate breakpoint at ${source.displayPath}:${spec.line}.`,
        );
      }
      locations.add(locationKey);

      const breakpoint = new vscode.SourceBreakpoint(
        new vscode.Location(
          vscode.Uri.file(source.canonicalPath),
          new vscode.Position(spec.line - 1, (spec.column ?? 1) - 1),
        ),
        true,
        spec.condition,
        spec.hitCondition,
        spec.logMessage,
      );
      next.push({
        breakpoint,
        source: source.displayPath,
        line: spec.line,
        column: spec.column,
        condition: spec.condition,
        hitCondition: spec.hitCondition,
        logMessage: spec.logMessage,
      });
    }

    const previous = this.ownedBreakpoints;
    try {
      if (previous.length > 0) {
        this.removeBreakpoints(previous.map((entry) => entry.breakpoint));
      }
      if (next.length > 0) {
        this.addBreakpoints(next.map((entry) => entry.breakpoint));
      }
      this.ownedBreakpoints = next;
    } catch {
      try {
        if (previous.length > 0) {
          this.addBreakpoints(previous.map((entry) => entry.breakpoint));
        }
      } catch {
        // Best effort restoration; the stable error below is the public contract.
      }
      throw new McpControllerError(
        'BREAKPOINT_UPDATE_FAILED',
        'VS Code could not update the MCP-owned breakpoints.',
      );
    }

    return {
      breakpoints: this.breakpointSummaries(),
      count: this.ownedBreakpoints.length,
    };
  }

  clearOwnedBreakpoints(): number {
    const previous = this.ownedBreakpoints;
    if (previous.length === 0) {
      return 0;
    }
    this.removeBreakpoints(previous.map((entry) => entry.breakpoint));
    this.ownedBreakpoints = [];
    return previous.length;
  }

  async waitForExecution(
    args: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['sessionRef', 'cursor', 'timeoutMs']);
    const sessionRef = this.expectString(input.sessionRef, 'sessionRef', 256);
    const cursor = this.optionalInteger(input.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const timeoutMs = this.optionalInteger(input.timeoutMs, 'timeoutMs', 0, 30_000) ?? 0;
    const record = this.requireSession(sessionRef);
    if (signal?.aborted) {
      throw new McpControllerError('REQUEST_CANCELLED', 'The execution wait was cancelled.');
    }

    const latestCursor = record.nextCursor - 1;
    if (cursor > latestCursor) {
      throw new McpControllerError(
        'INVALID_CURSOR',
        'The cursor is ahead of this session event stream.',
      );
    }
    const earliestCursor = record.events[0]?.cursor ?? record.nextCursor;
    if (cursor < earliestCursor - 1) {
      throw new McpControllerError(
        'CURSOR_EXPIRED',
        'The cursor is older than the retained debugger event history.',
        { earliestCursor: earliestCursor - 1 },
      );
    }

    if (!record.events.some((event) => event.cursor > cursor) && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          record.waiters.delete(finish);
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        record.waiters.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) {
          finish();
        }
      });
    }
    if (signal?.aborted) {
      throw new McpControllerError('REQUEST_CANCELLED', 'The execution wait was cancelled.');
    }

    const events = record.events.filter((event) => event.cursor > cursor);
    return {
      sessionRef,
      events,
      nextCursor: events[events.length - 1]?.cursor ?? cursor,
      state: record.state,
      timedOut: events.length === 0,
    };
  }

  async waitForSessionReady(
    args: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['sessionRef', 'timeoutMs']);
    const sessionRef = this.expectString(input.sessionRef, 'sessionRef', 256);
    const timeoutMs = this.optionalInteger(input.timeoutMs, 'timeoutMs', 0, 30_000)
      ?? DEFAULT_SESSION_READY_TIMEOUT_MS;
    const record = this.requireSession(sessionRef);
    if (signal?.aborted) {
      throw new McpControllerError(
        'REQUEST_CANCELLED',
        'The session readiness wait was cancelled.',
      );
    }

    const deadline = Date.now() + timeoutMs;
    while (!record.adapterReady
      && record.state !== 'stopped'
      && record.state !== 'terminating'
      && record.state !== 'terminated'
      && Date.now() < deadline) {
      await this.waitForSessionNotification(
        record,
        Math.max(1, deadline - Date.now()),
        signal,
      );
      if (signal?.aborted) {
        throw new McpControllerError(
          'REQUEST_CANCELLED',
          'The session readiness wait was cancelled.',
        );
      }
    }

    const terminated = record.state === 'terminating' || record.state === 'terminated';
    const ready = !terminated && (record.adapterReady || record.state === 'stopped');
    return {
      sessionRef,
      state: record.state,
      ready,
      terminated,
      timedOut: !ready && !terminated,
      cursor: record.nextCursor - 1,
      ...(record.stopRef ? { stopRef: record.stopRef } : {}),
    };
  }

  async breakpointsStatus(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['sessionRef']);
    const requestedSessionRef = input.sessionRef === undefined
      ? undefined
      : this.expectString(input.sessionRef, 'sessionRef', 256);
    let records: SessionRecord[];
    if (requestedSessionRef !== undefined) {
      const record = this.requireSession(requestedSessionRef);
      this.requireLiveDebugSession(record);
      records = [record];
    } else {
      records = [...this.sessions.values()].filter((record) =>
        record.session !== undefined
        && (record.state === 'running' || record.state === 'stopped'));
    }

    const traceCoverageBySession = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const coverage = await this.experimentalTraceCoverage(record);
      if (coverage) {
        traceCoverageBySession.set(record.sessionRef, coverage);
      }
    }

    const breakpoints: Array<Record<string, unknown>> = [];
    for (const entry of this.ownedBreakpoints) {
      const sessionStatuses: Array<Record<string, unknown>> = [];
      for (const record of records) {
        const session = record.session;
        if (!session) {
          continue;
        }
        try {
          const protocolBreakpoint = await session.getDebugProtocolBreakpoint(entry.breakpoint) as unknown;
          const value = isRecord(protocolBreakpoint) ? protocolBreakpoint : undefined;
          const source = value ? await this.publicSource(value.source) : undefined;
          sessionStatuses.push({
            sessionRef: record.sessionRef,
            state: record.state,
            verified: value?.verified === true,
            pending: value === undefined,
            actualLine: isPositiveInteger(value?.line) ? value.line : entry.line,
            actualColumn: isPositiveInteger(value?.column) ? value.column : (entry.column ?? 1),
            ...(truncate(value?.message, 1_000) ? { message: truncate(value?.message, 1_000) } : {}),
            ...(source ? { source } : {}),
          });
        } catch {
          sessionStatuses.push({
            sessionRef: record.sessionRef,
            state: record.state,
            verified: false,
            pending: true,
            actualLine: entry.line,
            actualColumn: entry.column ?? 1,
            message: 'The debug adapter did not provide breakpoint status.',
          });
        }
      }
      breakpoints.push({
        path: entry.source,
        requestedLine: entry.line,
        requestedColumn: entry.column ?? 1,
        ...(entry.condition === undefined ? {} : { condition: entry.condition }),
        ...(entry.hitCondition === undefined ? {} : { hitCondition: entry.hitCondition }),
        ...(entry.logMessage === undefined ? {} : { logMessage: entry.logMessage }),
        sessions: sessionStatuses,
      });
    }

    return {
      breakpoints,
      count: breakpoints.length,
      sessions: records.map((record) => ({
        sessionRef: record.sessionRef,
        state: record.state,
        ...(traceCoverageBySession.has(record.sessionRef)
          ? { traceCoverage: traceCoverageBySession.get(record.sessionRef) }
          : {}),
      })),
    };
  }

  async stateSnapshot(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(
      args,
      ['sessionRef', 'stopRef', 'frameRef', 'maxThreads', 'maxFrames', 'maxVariables'],
    );
    const sessionRef = this.expectString(input.sessionRef, 'sessionRef', 256);
    const maxThreads = this.optionalInteger(input.maxThreads, 'maxThreads', 1, MAX_THREADS) ?? 8;
    const maxFrames = this.optionalInteger(input.maxFrames, 'maxFrames', 1, MAX_STACK_FRAMES) ?? 20;
    const maxVariables = this.optionalInteger(input.maxVariables, 'maxVariables', 1, MAX_VARIABLES) ?? 40;
    const record = this.requireStoppedSession(sessionRef);
    if (input.stopRef !== undefined) {
      const stopRef = this.expectString(input.stopRef, 'stopRef', 256);
      this.requireCurrentStop(stopRef, record);
    }
    const session = this.requireLiveDebugSession(record);
    const epoch = record.stopEpoch;
    const selectedFrame = input.frameRef === undefined
      ? undefined
      : this.requireCurrentFrame(
        this.expectString(input.frameRef, 'frameRef', 256),
        record,
      );

    const threadsResponse = await this.dapRequest(record, 'threads');
    this.ensureEpoch(record, epoch);
    const rawThreads = isRecord(threadsResponse) && Array.isArray(threadsResponse.threads)
      ? threadsResponse.threads
      : [];
    const threads = rawThreads
      .filter((value): value is Record<string, unknown> =>
        isRecord(value) && isPositiveInteger(value.id))
      .slice(0, maxThreads);
    record.threadIds = threads.map((thread) => thread.id as number);

    const publicThreads: Array<Record<string, unknown>> = [];
    let primaryFrame: FrameRecord | undefined = selectedFrame;
    for (const [threadIndex, thread] of threads.entries()) {
      const threadId = thread.id as number;
      let stackFrames: unknown[] = [];
      let totalFrames: number | undefined;
      try {
        const stack = await session.customRequest('stackTrace', {
          threadId,
          startFrame: 0,
          levels: maxFrames,
        }) as unknown;
        this.ensureEpoch(record, epoch);
        if (isRecord(stack)) {
          stackFrames = Array.isArray(stack.stackFrames) ? stack.stackFrames : [];
          totalFrames = isPositiveInteger(stack.totalFrames) ? stack.totalFrames : undefined;
        }
      } catch {
        this.ensureEpoch(record, epoch);
      }

      const publicFrames: Array<Record<string, unknown>> = [];
      for (const rawFrame of stackFrames.slice(0, maxFrames)) {
        if (!isRecord(rawFrame) || !isPositiveInteger(rawFrame.id)) {
          continue;
        }
        const frameRef = this.newRef('frame');
        const frame: FrameRecord = {
          frameRef,
          sessionRef,
          epoch,
          frameId: rawFrame.id,
          threadId,
        };
        this.frames.set(frameRef, frame);
        this.trimActiveReferences(
          this.frames,
          this.staleFrames,
          MAX_ACTIVE_FRAME_REFS,
        );
        if (
          !primaryFrame
          && (record.stoppedThreadId === undefined || record.stoppedThreadId === threadId)
        ) {
          primaryFrame = frame;
        }
        publicFrames.push({
          frameRef,
          name: truncate(rawFrame.name, 512) ?? '<frame>',
          line: isPositiveInteger(rawFrame.line) ? rawFrame.line : 1,
          column: isPositiveInteger(rawFrame.column) ? rawFrame.column : 1,
          source: await this.publicSource(rawFrame.source),
        });
      }
      publicThreads.push({
        threadIndex,
        name: truncate(thread.name, 512) ?? `Thread ${threadIndex + 1}`,
        stopped: record.stoppedThreadId === undefined || record.stoppedThreadId === threadId,
        frames: publicFrames,
        ...(totalFrames === undefined ? {} : { totalFrames }),
      });
    }

    if (!primaryFrame && threads.length > 0) {
      const firstThread = publicThreads[0];
      const firstFrame = Array.isArray(firstThread?.frames) ? firstThread.frames[0] : undefined;
      if (isRecord(firstFrame) && typeof firstFrame.frameRef === 'string') {
        primaryFrame = this.frames.get(firstFrame.frameRef);
      }
    }

    const scopes: Array<Record<string, unknown>> = [];
    if (primaryFrame) {
      const scopesResponse = await this.dapRequest(record, 'scopes', {
        frameId: primaryFrame.frameId,
      });
      this.ensureEpoch(record, epoch);
      const rawScopes = isRecord(scopesResponse) && Array.isArray(scopesResponse.scopes)
        ? scopesResponse.scopes
        : [];
      let remaining = maxVariables;
      for (const rawScope of rawScopes) {
        if (!isRecord(rawScope) || !isPositiveInteger(rawScope.variablesReference)) {
          continue;
        }
        const variablesRef = this.storeVariablesReference(
          record,
          epoch,
          rawScope.variablesReference,
        );
        const count = Math.max(0, remaining);
        const values = count > 0
          ? await this.readVariables(record, epoch, rawScope.variablesReference, 0, count)
          : [];
        remaining -= values.length;
        scopes.push({
          name: truncate(rawScope.name, 512) ?? '<scope>',
          expensive: rawScope.expensive === true,
          variablesRef,
          variables: values,
          namedVariables: this.optionalPublicCount(rawScope.namedVariables),
          indexedVariables: this.optionalPublicCount(rawScope.indexedVariables),
        });
      }
    }

    let exceptionInfo: Record<string, unknown> | undefined;
    const exceptionThreadId = record.stoppedThreadId ?? record.threadIds[0];
    if (exceptionThreadId !== undefined) {
      try {
        const rawException = await session.customRequest('exceptionInfo', {
          threadId: exceptionThreadId,
        }) as unknown;
        this.ensureEpoch(record, epoch);
        exceptionInfo = this.publicExceptionInfo(rawException);
      } catch {
        this.ensureEpoch(record, epoch);
      }
    }

    return {
      sessionRef,
      stopRef: record.stopRef,
      reason: record.stopReason ?? 'stopped',
      ...(record.stopDescription ? { description: record.stopDescription } : {}),
      threads: publicThreads,
      ...(primaryFrame ? { primaryFrameRef: primaryFrame.frameRef } : {}),
      scopes,
      ...(exceptionInfo ? { exceptionInfo } : {}),
    };
  }

  async expandVariables(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['variablesRef', 'start', 'count']);
    const variablesRef = this.expectString(input.variablesRef, 'variablesRef', 256);
    const start = this.optionalInteger(input.start, 'start', 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const count = this.optionalInteger(input.count, 'count', 1, MAX_VARIABLES) ?? 50;
    const reference = this.variables.get(variablesRef);
    if (!reference) {
      if (this.staleVariables.has(variablesRef)) {
        throw new McpControllerError(
          'STALE_STOP',
          'Execution resumed or moved to another stop; refresh the debugger state.',
        );
      }
      throw new McpControllerError('VARIABLES_REF_NOT_FOUND', 'Unknown variables reference.');
    }
    const record = this.requireSession(reference.sessionRef);
    this.requireLiveDebugSession(record);
    this.ensureEpoch(record, reference.epoch);
    const values = await this.readVariables(
      record,
      reference.epoch,
      reference.dapReference,
      start,
      count,
    );
    return {
      variablesRef,
      start,
      count: values.length,
      variables: values,
    };
  }

  async requestContext(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['frameRef', 'maxVariables']);
    const frameRef = this.expectString(input.frameRef, 'frameRef', 256);
    const maxVariables = this.optionalInteger(
      input.maxVariables,
      'maxVariables',
      1,
      MAX_VARIABLES,
    ) ?? 40;
    const existingFrame = this.frames.get(frameRef);
    if (!existingFrame) {
      if (this.staleFrames.has(frameRef)) {
        throw new McpControllerError(
          'STALE_STOP',
          'The frame reference belongs to an earlier stop.',
        );
      }
      throw new McpControllerError('FRAME_REF_NOT_FOUND', 'Unknown frame reference.');
    }
    const record = this.requireStoppedSession(existingFrame.sessionRef);
    const frame = this.requireCurrentFrame(frameRef, record);
    const epoch = frame.epoch;
    const scopesResponse = await this.dapRequest(record, 'scopes', {
      frameId: frame.frameId,
    });
    this.ensureEpoch(record, epoch);
    const rawScopes = isRecord(scopesResponse) && Array.isArray(scopesResponse.scopes)
      ? scopesResponse.scopes
      : [];

    let remaining = maxVariables;
    let inspectedVariables = 0;
    const context: Record<string, Record<string, unknown>> = {};
    const contextVariables: Array<Record<string, unknown>> = [];
    for (const rawScope of rawScopes) {
      if (remaining <= 0) {
        break;
      }
      if (!isRecord(rawScope) || !isPositiveInteger(rawScope.variablesReference)) {
        continue;
      }
      const scopeName = truncate(rawScope.name, 512) ?? '<scope>';
      const values = await this.readVariables(
        record,
        epoch,
        rawScope.variablesReference,
        0,
        remaining,
      );
      remaining -= values.length;
      inspectedVariables += values.length;
      for (const variable of values) {
        const role = this.djangoContextRole(variable.name);
        if (!role) {
          continue;
        }
        const summary = { role, scope: scopeName, ...variable };
        contextVariables.push(summary);
        context[role] ??= summary;
      }
    }
    this.ensureEpoch(record, epoch);

    return {
      sessionRef: record.sessionRef,
      stopRef: record.stopRef,
      frameRef,
      inspectedVariables,
      maxVariables,
      truncated: remaining === 0,
      context,
      contextVariables,
      foundRoles: Object.keys(context),
    };
  }

  async failureSnapshot(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(
      args,
      ['sessionRef', 'stopRef', 'maxThreads', 'maxFrames', 'maxVariables'],
    );
    const sessionRef = input.sessionRef === undefined
      ? undefined
      : this.expectString(input.sessionRef, 'sessionRef', 256);
    const stopRef = input.stopRef === undefined
      ? undefined
      : this.expectString(input.stopRef, 'stopRef', 256);
    const maxThreads = this.optionalInteger(input.maxThreads, 'maxThreads', 1, MAX_THREADS) ?? 8;
    const maxFrames = this.optionalInteger(input.maxFrames, 'maxFrames', 1, MAX_STACK_FRAMES) ?? 20;
    const maxVariables = this.optionalInteger(input.maxVariables, 'maxVariables', 1, MAX_VARIABLES) ?? 40;

    let record: SessionRecord;
    if (sessionRef !== undefined) {
      record = this.requireStoppedSession(sessionRef);
      if (stopRef !== undefined) {
        this.requireCurrentStop(stopRef, record);
      }
    } else if (stopRef !== undefined) {
      const stop = this.stops.get(stopRef);
      if (!stop) {
        if (this.staleStops.has(stopRef)) {
          throw new McpControllerError('STALE_STOP', 'The stop reference is no longer current.');
        }
        throw new McpControllerError('STOP_REF_NOT_FOUND', 'Unknown stop reference.');
      }
      record = this.requireStoppedSession(stop.sessionRef);
      this.requireCurrentStop(stopRef, record);
    } else {
      const stopped = [...this.sessions.values()].filter((candidate) =>
        candidate.state === 'stopped'
        && candidate.session !== undefined
        && candidate.stopRef !== undefined);
      if (stopped.length === 0) {
        throw new McpControllerError(
          'NO_STOPPED_SESSION',
          'No debugger session in this VS Code window is currently stopped.',
        );
      }
      if (stopped.length > 1) {
        throw new McpControllerError(
          'AMBIGUOUS_SESSION',
          'More than one debugger session is stopped; pass sessionRef or stopRef.',
          { sessionRefs: stopped.map((candidate) => candidate.sessionRef) },
        );
      }
      [record] = stopped;
    }

    const snapshot = await this.stateSnapshot({
      sessionRef: record.sessionRef,
      stopRef: stopRef ?? record.stopRef,
      maxThreads,
      maxFrames,
      maxVariables,
    });
    const testLikeFrames: Array<Record<string, unknown>> = [];
    const threads = Array.isArray(snapshot.threads) ? snapshot.threads : [];
    for (const thread of threads) {
      if (!isRecord(thread) || !Array.isArray(thread.frames)) {
        continue;
      }
      for (const frame of thread.frames) {
        if (!isRecord(frame) || !this.isTestLikeFrame(frame)) {
          continue;
        }
        testLikeFrames.push({
          ...frame,
          thread: truncate(thread.name, 512) ?? '<thread>',
        });
        if (testLikeFrames.length >= maxFrames) {
          break;
        }
      }
      if (testLikeFrames.length >= maxFrames) {
        break;
      }
    }

    return {
      ...snapshot,
      failureSummary: {
        ...(isRecord(snapshot.exceptionInfo) ? { exception: snapshot.exceptionInfo } : {}),
        testLikeFrames,
      },
    };
  }

  async inspectExpression(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['frameRef', 'expression']);
    const frameRef = this.expectString(input.frameRef, 'frameRef', 256);
    const expression = this.expectString(
      input.expression,
      'expression',
      MAX_INSPECTION_EXPRESSION_LENGTH,
    );
    if (!this.isRestrictedInspectionExpression(expression)) {
      throw new McpControllerError(
        'UNSAFE_EXPRESSION',
        'Only identifier, attribute, and literal index paths are allowed; calls, operators, assignments, and dunder access are forbidden.',
      );
    }
    const existingFrame = this.frames.get(frameRef);
    if (!existingFrame) {
      if (this.staleFrames.has(frameRef)) {
        throw new McpControllerError(
          'STALE_STOP',
          'The frame reference belongs to an earlier stop.',
        );
      }
      throw new McpControllerError('FRAME_REF_NOT_FOUND', 'Unknown frame reference.');
    }
    const record = this.requireStoppedSession(existingFrame.sessionRef);
    const frame = this.requireCurrentFrame(frameRef, record);
    const response = await this.dapRequest(record, 'evaluate', {
      expression,
      frameId: frame.frameId,
      context: 'watch',
    });
    this.ensureEpoch(record, frame.epoch);
    if (!isRecord(response) || typeof response.result !== 'string') {
      throw new McpControllerError(
        'EVALUATE_RESULT_INVALID',
        'The debugger returned an invalid restricted inspection result.',
      );
    }
    const variablesRef = isPositiveInteger(response.variablesReference)
      ? this.storeVariablesReference(record, frame.epoch, response.variablesReference)
      : undefined;
    return {
      sessionRef: record.sessionRef,
      stopRef: record.stopRef,
      frameRef,
      expression,
      result: truncate(response.result) ?? '',
      ...(truncate(response.type, 512) ? { type: truncate(response.type, 512) } : {}),
      ...(variablesRef ? { variablesRef } : {}),
    };
  }

  async controlExecution(args: unknown): Promise<Record<string, unknown>> {
    const input = this.expectArguments(args, ['sessionRef', 'stopRef', 'action']);
    const sessionRef = this.expectString(input.sessionRef, 'sessionRef', 256);
    const action = this.expectString(input.action, 'action', 32);
    if (!['pause', 'continue', 'next', 'stepIn', 'stepOut', 'disconnect'].includes(action)) {
      throw new McpControllerError('INVALID_ARGUMENT', `Unsupported execution action: ${action}`);
    }
    const record = this.requireSession(sessionRef);
    const session = this.requireLiveDebugSession(record);
    if (record.controlInFlight) {
      throw new McpControllerError(
        'CONTROL_IN_PROGRESS',
        'Another execution-control request is already in progress for this session.',
      );
    }
    record.controlInFlight = true;
    try {
      if (action === 'disconnect') {
        let stopped: boolean;
        try {
          stopped = await this.stopDebugging!(session);
        } catch {
          throw new McpControllerError(
            'DISCONNECT_FAILED',
            'VS Code could not stop the debug session.',
          );
        }
        if (!stopped) {
          throw new McpControllerError(
            'DISCONNECT_REJECTED',
            'VS Code rejected the disconnect request.',
          );
        }
        // A terminate event may win the race with stopDebugging(). Never move
        // an already terminated record backwards to "terminating".
        if (record.state !== 'terminated' && record.session === session) {
          this.invalidateStop(record, 'terminating');
        }
        return { sessionRef, action, accepted: true, state: record.state };
      }

      let requestedStopRef: string | undefined;
      let requestedEpoch: number | undefined;
      if (action !== 'pause') {
        if (record.state !== 'stopped') {
          throw new McpControllerError(
            'SESSION_NOT_STOPPED',
            'The debug session must be stopped before resuming or stepping.',
          );
        }
        if (input.stopRef === undefined) {
          throw new McpControllerError(
            'STOP_REF_REQUIRED',
            'stopRef is required for continue and step actions.',
          );
        }
        requestedStopRef = this.expectString(input.stopRef, 'stopRef', 256);
        requestedEpoch = this.requireCurrentStop(requestedStopRef, record).epoch;
      } else if (record.state === 'stopped') {
        throw new McpControllerError('SESSION_ALREADY_STOPPED', 'The debug session is already stopped.');
      }

      const threadId = record.stoppedThreadId
        ?? (action === 'pause'
          ? await this.availableThreadId(record, true, true)
          : record.threadIds[0] ?? await this.availableThreadId(record));
      if (!threadId) {
        throw new McpControllerError(
          'THREAD_NOT_AVAILABLE',
          'No debugger thread is available for this action.',
        );
      }

      // Thread discovery awaited the adapter, so execution may have changed in
      // the meantime. Revalidate the capability immediately before mutation.
      if (action !== 'pause') {
        this.requireCurrentStop(requestedStopRef!, record);
      } else {
        this.requireLiveDebugSession(record);
        if (record.state === 'stopped') {
          throw new McpControllerError(
            'SESSION_ALREADY_STOPPED',
            'The debug session stopped before the pause request was sent.',
          );
        }
      }

      try {
        await session.customRequest(action, { threadId });
      } catch (error) {
        if (action === 'pause') {
          record.threadIds = [];
        }
        const adapterMessage = error instanceof Error ? error.message : '';
        if (action === 'pause' && /not trace-enabled/i.test(adapterMessage)) {
          throw new McpControllerError(
            'THREAD_NOT_TRACE_ENABLED',
            'The selected thread is not trace-enabled yet. On Python 3.11 and earlier, retry after a Django request reaches the session.',
          );
        }
        throw new McpControllerError(
          'EXECUTION_CONTROL_FAILED',
          `The debugger rejected the ${action} request.`,
        );
      }
      if (action !== 'pause'
        && record.state === 'stopped'
        && record.stopEpoch === requestedEpoch
        && record.stopRef === requestedStopRef) {
        this.invalidateStop(record, 'running');
      }
      return { sessionRef, action, accepted: true, state: record.state };
    } finally {
      record.controlInFlight = false;
    }
  }

  handleSessionStarted(session: vscode.DebugSession): string | undefined {
    if (session.type !== DEBUG_TYPE) {
      return undefined;
    }
    const configuredRef = session.configuration[DJANGO_MCP_SESSION_REF_CONFIG_KEY];
    let record: SessionRecord | undefined;
    if (typeof configuredRef === 'string') {
      record = this.sessions.get(configuredRef);
      // An MCP capability that was rejected, cancelled, or otherwise removed
      // must stay dead. A late tracker message cannot mint an unrelated
      // replacement session around the retired hidden reference.
      if (!record) {
        return undefined;
      }
    } else {
      record = this.sessionsById.get(session.id);
    }
    if (!record) {
      const sessionRef = this.newRef('session');
      record = {
        sessionRef,
        name: session.name,
        folder: session.workspaceFolder,
        engine: normalizeDebugEngine(session.configuration.engine),
        pid: isPositiveInteger(session.configuration.pid) ? session.configuration.pid : undefined,
        state: 'running',
        adapterReady: false,
        controlInFlight: false,
        stopEpoch: 0,
        threadIds: [],
        events: [],
        nextCursor: 1,
        waiters: new Set(),
      };
      this.sessions.set(sessionRef, record);
    }
    if (record.state === 'terminated') {
      return record.sessionRef;
    }
    const alreadyBound = record.sessionId === session.id && record.session === session;
    record.session = session;
    record.sessionId = session.id;
    record.folder = session.workspaceFolder ?? record.folder;
    record.name = session.name;
    record.engine = normalizeDebugEngine(session.configuration.engine ?? record.engine);
    if (record.state === 'starting') {
      record.state = 'running';
    }
    this.sessionsById.set(session.id, record);
    if (!alreadyBound) {
      this.appendEvent(record, 'started', { state: record.state });
    }
    return record.sessionRef;
  }

  handleSessionTerminated(session: vscode.DebugSession): void {
    const configuredRef = session.configuration[DJANGO_MCP_SESSION_REF_CONFIG_KEY];
    const record = this.sessionsById.get(session.id)
      ?? (typeof configuredRef === 'string' ? this.sessions.get(configuredRef) : undefined);
    if (!record) {
      return;
    }
    if (record.sessionId !== undefined && record.sessionId !== session.id) {
      return;
    }
    if (record.state !== 'terminated') {
      this.invalidateStop(record, 'terminated');
      this.appendEvent(record, 'terminated', { state: 'terminated' });
    }
    if (this.sessionsById.get(session.id) === record) {
      this.sessionsById.delete(session.id);
    }
    record.session = undefined;
  }

  handleDapMessage(session: vscode.DebugSession, message: unknown): void {
    if (session.type !== DEBUG_TYPE
      || (!isDapEventMessage(message) && !isDapResponseMessage(message))) {
      return;
    }
    let record = this.sessionsById.get(session.id);
    if (!record) {
      const sessionRef = this.handleSessionStarted(session);
      record = sessionRef ? this.sessions.get(sessionRef) : undefined;
    }
    if (!record) {
      return;
    }
    if (record.state === 'terminated') {
      return;
    }
    if (isDapResponseMessage(message)) {
      if (!message.success && DAP_STARTUP_COMMANDS.has(message.command)) {
        this.handleSessionTerminated(session);
        return;
      }
      if (message.command === 'configurationDone'
        && message.success
        && record.state !== 'terminating'
        && !record.adapterReady) {
        record.adapterReady = true;
        if (record.state === 'starting') {
          record.state = 'running';
        }
        this.appendEvent(record, 'ready', { state: record.state });
      }
      return;
    }
    const body = message.body ?? {};
    switch (message.event) {
      case 'stopped': {
        this.retireStopReferences(record);
        record.stopEpoch++;
        record.state = 'stopped';
        record.stoppedThreadId = isPositiveInteger(body.threadId) ? body.threadId : undefined;
        record.stopReason = truncate(body.reason, 128) ?? 'stopped';
        record.stopDescription = truncate(body.description, 1_000);
        const stopRef = this.newRef('stop');
        record.stopRef = stopRef;
        this.stops.set(stopRef, {
          stopRef,
          sessionRef: record.sessionRef,
          epoch: record.stopEpoch,
        });
        this.appendEvent(record, 'stopped', {
          state: 'stopped',
          stopRef,
          reason: record.stopReason,
          ...(record.stopDescription ? { description: record.stopDescription } : {}),
          allThreadsStopped: body.allThreadsStopped === true,
        });
        break;
      }
      case 'continued':
        this.invalidateStop(record, 'running');
        this.appendEvent(record, 'continued', {
          state: 'running',
          allThreadsContinued: body.allThreadsContinued === true,
        });
        break;
      case 'terminated':
      case 'exited':
        this.invalidateStop(record, 'terminated');
        this.appendEvent(record, message.event, { state: 'terminated' });
        break;
      case 'thread':
        this.appendEvent(record, 'thread', {
          reason: truncate(body.reason, 128) ?? 'changed',
        });
        break;
      case 'breakpoint':
        this.appendEvent(record, 'breakpoint', {
          reason: truncate(body.reason, 128) ?? 'changed',
        });
        break;
      default:
        break;
    }
  }

  private discardRejectedSession(record: SessionRecord): void {
    this.invalidateStop(record, 'terminated');
    if (record.sessionId && this.sessionsById.get(record.sessionId) === record) {
      this.sessionsById.delete(record.sessionId);
    }
    this.sessions.delete(record.sessionRef);
    record.session = undefined;
    for (const waiter of [...record.waiters]) {
      waiter();
    }
    record.waiters.clear();
  }

  private expectArguments(
    args: unknown,
    allowedKeys: readonly string[],
  ): Record<string, unknown> {
    if (!isRecord(args)) {
      throw new McpControllerError('INVALID_ARGUMENT', 'Tool arguments must be an object.');
    }
    const unexpected = Object.keys(args).filter((key) => !allowedKeys.includes(key));
    if (unexpected.length > 0) {
      throw new McpControllerError(
        'INVALID_ARGUMENT',
        `Unexpected argument: ${unexpected[0]}.`,
      );
    }
    return args;
  }

  private expectString(value: unknown, field: string, maximum: number): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
      throw new McpControllerError(
        'INVALID_ARGUMENT',
        `${field} must be a non-empty string of at most ${maximum} characters.`,
      );
    }
    return value;
  }

  private optionalInteger(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number,
  ): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new McpControllerError(
        'INVALID_ARGUMENT',
        `${field} must be an integer between ${minimum} and ${maximum}.`,
      );
    }
    return value;
  }

  private expectBreakpoint(value: unknown): {
    path: string;
    workspaceFolder?: string;
    line: number;
    column?: number;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
  } {
    const input = this.expectArguments(
      value,
      ['path', 'workspaceFolder', 'line', 'column', 'condition', 'hitCondition', 'logMessage'],
    );
    const sourcePath = this.expectString(input.path, 'path', 1_024);
    if (
      path.isAbsolute(sourcePath)
      || sourcePath.includes('://')
      || sourcePath.split(/[\\/]+/).includes('..')
    ) {
      throw new McpControllerError(
        'INVALID_SOURCE_PATH',
        'Breakpoint paths must be workspace-relative and may not traverse parent folders.',
      );
    }
    if (path.extname(sourcePath).toLowerCase() !== '.py') {
      throw new McpControllerError(
        'INVALID_SOURCE_PATH',
        'Django debugger breakpoints must target a Python source file.',
      );
    }
    const line = this.optionalInteger(input.line, 'line', 1, 1_000_000);
    if (line === undefined) {
      throw new McpControllerError('INVALID_ARGUMENT', 'line is required.');
    }
    const column = this.optionalInteger(input.column, 'column', 1, 1_000_000);
    const workspaceFolder = input.workspaceFolder === undefined
      ? undefined
      : this.expectString(input.workspaceFolder, 'workspaceFolder', 256);
    return {
      path: sourcePath,
      workspaceFolder,
      line,
      column,
      condition: this.optionalExpression(input.condition, 'condition', 2_000, true),
      hitCondition: this.optionalExpression(input.hitCondition, 'hitCondition', 256, false),
      logMessage: this.optionalExpression(input.logMessage, 'logMessage', 4_000, true),
    };
  }

  private optionalExpression(
    value: unknown,
    field: string,
    maximum: number,
    allowNewline: boolean,
  ): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    const text = this.expectString(value, field, maximum);
    if (text.trim().length === 0 || (!allowNewline && /[\r\n]/.test(text))) {
      throw new McpControllerError('INVALID_ARGUMENT', `${field} has an invalid value.`);
    }
    return text;
  }

  private isRestrictedInspectionExpression(expression: string): boolean {
    const identifier = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
    const integerIndex = String.raw`(?:0|[1-9][0-9]{0,5})`;
    const stringIndex = String.raw`(?:"[A-Za-z0-9_.:@ /-]{1,64}"|'[A-Za-z0-9_.:@ /-]{1,64}')`;
    const pattern = new RegExp(
      String.raw`^${identifier}(?:(?:\.${identifier})|(?:\[(?:${integerIndex}|${stringIndex})\]))*$`,
    );
    if (!pattern.test(expression)) {
      return false;
    }
    const identifiers = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    return identifiers.every((value) => !value.includes('__'));
  }

  private async canonicalWorkspaceRoots(): Promise<CanonicalWorkspaceRoot[]> {
    const folders = this.getWorkspaceFolders() ?? [];
    const roots: CanonicalWorkspaceRoot[] = [];
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      let canonicalPath: string;
      try {
        canonicalPath = await this.realpath(folder.uri.fsPath);
      } catch {
        canonicalPath = path.resolve(folder.uri.fsPath);
      }
      roots.push({ folder, canonicalPath: path.resolve(canonicalPath) });
    }
    return roots.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length);
  }

  private async scopeForProcess(
    processInfo: DjangoProcess,
    roots: readonly CanonicalWorkspaceRoot[],
  ): Promise<{
    folder: vscode.WorkspaceFolder;
    canonicalRoot: string;
    canonicalCwd: string;
  } | undefined> {
    if (!processInfo.cwd) {
      return undefined;
    }
    let canonicalCwd: string;
    try {
      canonicalCwd = path.resolve(await this.realpath(processInfo.cwd));
    } catch {
      return undefined;
    }
    const root = roots.find((candidate) => isPathInside(candidate.canonicalPath, canonicalCwd));
    return root
      ? {
        folder: root.folder,
        canonicalRoot: root.canonicalPath,
        canonicalCwd,
      }
      : undefined;
  }

  private async revalidateTarget(target: TargetRecord): Promise<void> {
    const roots = await this.canonicalWorkspaceRoots();
    let processes: DjangoProcess[];
    try {
      processes = await this.processFinder.findDjangoProcesses();
    } catch {
      throw new McpControllerError(
        'TARGET_CHANGED',
        'The selected process could not be revalidated. Run django_targets_list again.',
      );
    }

    for (const processInfo of processes) {
      const candidatePids = processInfo.workerPids && processInfo.workerPids.length > 0
        ? [...new Set(processInfo.workerPids.filter(isPositiveInteger))]
        : [processInfo.pid];
      if (!candidatePids.includes(target.sourcePid) || processInfo.type !== target.process.type) {
        continue;
      }
      const scope = await this.scopeForProcess(processInfo, roots);
      if (!scope
        || scope.folder.uri.toString() !== target.folder.uri.toString()
        || scope.canonicalCwd !== target.canonicalCwd) {
        continue;
      }
      if (target.process.endpointVerified === true
        && processInfo.endpointVerified !== true) {
        continue;
      }
      if (target.process.networkId
        && processInfo.networkId !== target.process.networkId) {
        continue;
      }
      const originalPorts = new Set(
        this.publicEndpoints(target.process).map((endpoint) => endpoint.port),
      );
      const currentPorts = new Set(
        this.publicEndpoints(processInfo).map((endpoint) => endpoint.port),
      );
      if ([...originalPorts].some((port) => !currentPorts.has(port))) {
        continue;
      }
      try {
        const resolved = await this.processFinder.resolveDebuggablePid(target.sourcePid);
        if (resolved.pid === target.pid && isPositiveInteger(resolved.pid)) {
          return;
        }
      } catch {
        // A disappeared or replaced process invalidates the one-shot target.
      }
    }

    throw new McpControllerError(
      'TARGET_CHANGED',
      'The selected process changed identity or left this workspace. Run django_targets_list again.',
    );
  }

  private async resolveBreakpointSource(
    sourcePath: string,
    workspaceFolder: string | undefined,
    roots: readonly CanonicalWorkspaceRoot[],
  ): Promise<{ canonicalPath: string; displayPath: string }> {
    const matchingRoots = workspaceFolder === undefined
      ? roots
      : roots.filter((root) => root.folder.name === workspaceFolder);
    if (workspaceFolder !== undefined && matchingRoots.length === 0) {
      throw new McpControllerError(
        'WORKSPACE_FOLDER_NOT_FOUND',
        `Unknown workspace folder: ${workspaceFolder}`,
      );
    }

    const matches = new Map<string, { canonicalPath: string; displayPath: string }>();
    for (const root of matchingRoots) {
      const normalized = sourcePath.replace(/[\\/]+/g, path.sep);
      const prefixed = normalized.startsWith(`${root.folder.name}${path.sep}`)
        ? normalized.slice(root.folder.name.length + 1)
        : normalized;
      const candidate = path.resolve(root.canonicalPath, prefixed);
      if (!isPathInside(root.canonicalPath, candidate)) {
        continue;
      }
      try {
        const canonicalPath = path.resolve(await this.realpath(candidate));
        const fileStat = await this.stat(canonicalPath);
        if (!fileStat.isFile() || !isPathInside(root.canonicalPath, canonicalPath)) {
          continue;
        }
        matches.set(canonicalPath, {
          canonicalPath,
          displayPath: `${root.folder.name}/${path.relative(root.canonicalPath, canonicalPath)}`,
        });
      } catch {
        continue;
      }
    }

    if (matches.size === 0) {
      throw new McpControllerError(
        'SOURCE_NOT_FOUND',
        `No workspace Python file matches ${sourcePath}.`,
      );
    }
    if (matches.size > 1) {
      throw new McpControllerError(
        'AMBIGUOUS_SOURCE',
        `The source path ${sourcePath} exists in more than one workspace folder.`,
      );
    }
    return [...matches.values()][0];
  }

  private publicEndpoints(processInfo: DjangoProcess): Array<{ host: string; port: number }> {
    const endpoints = processInfo.endpoints?.length
      ? processInfo.endpoints
      : processInfo.host && isPositiveInteger(processInfo.port)
        ? [{ host: processInfo.host, port: processInfo.port }]
        : [];
    const seen = new Set<string>();
    return endpoints.filter((endpoint) => {
      const key = `${endpoint.host}:${endpoint.port}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }).map((endpoint) => ({ host: endpoint.host, port: endpoint.port }));
  }

  private purgeExpiredTargets(): void {
    const now = this.now();
    for (const [targetRef, target] of this.targets) {
      if (target.expiresAt <= now) {
        this.targets.delete(targetRef);
      }
    }
  }

  private newRef(kind: 'target' | 'session' | 'stop' | 'frame' | 'variables'): string {
    return `${kind}_${randomUUID().replace(/-/g, '')}`;
  }

  private appendEvent(
    record: SessionRecord,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    record.events.push({
      cursor: record.nextCursor++,
      event,
      timestamp: this.now(),
      ...fields,
    });
    if (record.events.length > MAX_EVENT_HISTORY) {
      record.events.splice(0, record.events.length - MAX_EVENT_HISTORY);
    }
    for (const waiter of [...record.waiters]) {
      waiter();
    }
  }

  private waitForSessionNotification(
    record: SessionRecord,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        record.waiters.delete(finish);
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      record.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted
        || record.adapterReady
        || record.state === 'stopped'
        || record.state === 'terminating'
        || record.state === 'terminated') {
        finish();
      }
    });
  }

  private requireSession(sessionRef: string): SessionRecord {
    const record = this.sessions.get(sessionRef);
    if (!record) {
      throw new McpControllerError('SESSION_NOT_FOUND', 'Unknown debugger session reference.');
    }
    return record;
  }

  private requireLiveDebugSession(record: SessionRecord): vscode.DebugSession {
    if (record.state === 'starting' || !record.session) {
      throw new McpControllerError(
        record.state === 'starting' ? 'SESSION_STARTING' : 'SESSION_NOT_ACTIVE',
        record.state === 'starting'
          ? 'The debugger session is still starting.'
          : 'The debugger session is not active.',
      );
    }
    if (record.state === 'terminated' || record.state === 'terminating') {
      throw new McpControllerError('SESSION_NOT_ACTIVE', 'The debugger session is not active.');
    }
    return record.session;
  }

  private requireStoppedSession(sessionRef: string): SessionRecord {
    const record = this.requireSession(sessionRef);
    this.requireLiveDebugSession(record);
    if (record.state !== 'stopped' || !record.stopRef) {
      throw new McpControllerError(
        'SESSION_NOT_STOPPED',
        'The debug session is not currently stopped.',
      );
    }
    return record;
  }

  private requireCurrentStop(stopRef: string, record: SessionRecord): StopRecord {
    const stop = this.stops.get(stopRef);
    if (!stop || stop.sessionRef !== record.sessionRef) {
      if (this.staleStops.has(stopRef)) {
        throw new McpControllerError('STALE_STOP', 'The stop reference is no longer current.');
      }
      throw new McpControllerError('STOP_REF_NOT_FOUND', 'Unknown stop reference.');
    }
    this.ensureEpoch(record, stop.epoch);
    if (record.stopRef !== stopRef || record.state !== 'stopped') {
      throw new McpControllerError('STALE_STOP', 'The stop reference is no longer current.');
    }
    return stop;
  }

  private requireCurrentFrame(frameRef: string, record: SessionRecord): FrameRecord {
    const frame = this.frames.get(frameRef);
    if (!frame || frame.sessionRef !== record.sessionRef) {
      if (this.staleFrames.has(frameRef)) {
        throw new McpControllerError(
          'STALE_STOP',
          'The frame reference belongs to an earlier stop.',
        );
      }
      throw new McpControllerError('FRAME_REF_NOT_FOUND', 'Unknown frame reference.');
    }
    this.ensureEpoch(record, frame.epoch);
    return frame;
  }

  private ensureEpoch(record: SessionRecord, epoch: number): void {
    if (record.state !== 'stopped' || record.stopEpoch !== epoch) {
      throw new McpControllerError(
        'STALE_STOP',
        'Execution resumed or moved to another stop; refresh the debugger state.',
      );
    }
  }

  private invalidateStop(record: SessionRecord, nextState: SessionState): void {
    this.retireStopReferences(record);
    if (record.state === 'stopped') {
      record.stopEpoch++;
    }
    record.state = nextState;
    if (nextState === 'terminating' || nextState === 'terminated') {
      record.adapterReady = false;
    }
    record.stopRef = undefined;
    record.stoppedThreadId = undefined;
    record.stopReason = undefined;
    record.stopDescription = undefined;
    record.threadIds = [];
  }

  private retireStopReferences(record: SessionRecord): void {
    for (const [stopRef, stop] of this.stops) {
      if (stop.sessionRef === record.sessionRef) {
        this.stops.delete(stopRef);
        this.rememberStale(this.staleStops, stopRef);
      }
    }
    for (const [frameRef, frame] of this.frames) {
      if (frame.sessionRef === record.sessionRef) {
        this.frames.delete(frameRef);
        this.rememberStale(this.staleFrames, frameRef);
      }
    }
    for (const [variablesRef, variables] of this.variables) {
      if (variables.sessionRef === record.sessionRef) {
        this.variables.delete(variablesRef);
        this.rememberStale(this.staleVariables, variablesRef);
      }
    }
  }

  private rememberStale(refs: Set<string>, ref: string): void {
    refs.add(ref);
    while (refs.size > MAX_STALE_REF_HISTORY) {
      const oldest = refs.values().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      refs.delete(oldest);
    }
  }

  private trimActiveReferences<T>(
    refs: Map<string, T>,
    staleRefs: Set<string>,
    maximum: number,
  ): void {
    while (refs.size > maximum) {
      const oldest = refs.keys().next().value as string | undefined;
      if (oldest === undefined) {
        return;
      }
      refs.delete(oldest);
      this.rememberStale(staleRefs, oldest);
    }
  }

  private async dapRequest(
    record: SessionRecord,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    const session = this.requireLiveDebugSession(record);
    try {
      return await session.customRequest(command, args) as unknown;
    } catch {
      throw new McpControllerError(
        'DAP_REQUEST_FAILED',
        `The debugger rejected the ${command} request.`,
        { command },
      );
    }
  }

  private storeVariablesReference(
    record: SessionRecord,
    epoch: number,
    dapReference: number,
  ): string {
    const variablesRef = this.newRef('variables');
    this.variables.set(variablesRef, {
      variablesRef,
      sessionRef: record.sessionRef,
      epoch,
      dapReference,
    });
    this.trimActiveReferences(
      this.variables,
      this.staleVariables,
      MAX_ACTIVE_VARIABLE_REFS,
    );
    return variablesRef;
  }

  private async readVariables(
    record: SessionRecord,
    epoch: number,
    dapReference: number,
    start: number,
    count: number,
  ): Promise<Array<Record<string, unknown>>> {
    const response = await this.dapRequest(record, 'variables', {
      variablesReference: dapReference,
      start,
      count,
    });
    this.ensureEpoch(record, epoch);
    const rawVariables = isRecord(response) && Array.isArray(response.variables)
      ? response.variables
      : [];
    return rawVariables.slice(0, count).flatMap((rawVariable) => {
      if (!isRecord(rawVariable) || typeof rawVariable.name !== 'string') {
        return [];
      }
      const childReference = isPositiveInteger(rawVariable.variablesReference)
        ? this.storeVariablesReference(record, epoch, rawVariable.variablesReference)
        : undefined;
      return [{
        name: truncate(rawVariable.name, 1_000) ?? '<variable>',
        value: truncate(rawVariable.value) ?? '',
        ...(truncate(rawVariable.type, 512) ? { type: truncate(rawVariable.type, 512) } : {}),
        ...(childReference ? { variablesRef: childReference } : {}),
        ...(this.optionalPublicCount(rawVariable.namedVariables) === undefined
          ? {}
          : { namedVariables: this.optionalPublicCount(rawVariable.namedVariables) }),
        ...(this.optionalPublicCount(rawVariable.indexedVariables) === undefined
          ? {}
          : { indexedVariables: this.optionalPublicCount(rawVariable.indexedVariables) }),
      }];
    });
  }

  private optionalPublicCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : undefined;
  }

  private djangoContextRole(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    switch (value.trim().toLowerCase()) {
      case 'request':
        return 'request';
      case 'user':
        return 'user';
      case 'view':
      case 'view_func':
      case 'view_function':
      case 'callback':
        return 'view';
      case 'self':
        return 'self';
      case 'args':
        return 'args';
      case 'kwargs':
        return 'kwargs';
      default:
        return undefined;
    }
  }

  private isTestLikeFrame(frame: Record<string, unknown>): boolean {
    const name = typeof frame.name === 'string' ? frame.name.toLowerCase() : '';
    const source = isRecord(frame.source) ? frame.source : undefined;
    const sourcePath = typeof source?.path === 'string' ? source.path.toLowerCase() : '';
    const sourceName = typeof source?.name === 'string' ? source.name.toLowerCase() : '';
    const sourceText = sourcePath || sourceName;
    return /(^|[._])test([_.$]|$)/.test(name)
      || name.includes('pytest')
      || name.includes('unittest')
      || /(^|[\\/])tests?([\\/]|$)/.test(sourceText)
      || /(^|[\\/])test_[^\\/]*\.py$/.test(sourceText)
      || /_test\.py$/.test(sourceText);
  }

  private async publicSource(value: unknown): Promise<Record<string, unknown> | undefined> {
    if (!isRecord(value)) {
      return undefined;
    }
    const name = truncate(value.name, 512);
    const sourcePath = typeof value.path === 'string' ? value.path : undefined;
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      return name ? { name } : undefined;
    }
    const roots = await this.canonicalWorkspaceRoots();
    let canonicalSource: string;
    try {
      canonicalSource = path.resolve(await this.realpath(sourcePath));
    } catch {
      canonicalSource = path.resolve(sourcePath);
    }
    const root = roots.find((candidate) => isPathInside(candidate.canonicalPath, canonicalSource));
    if (!root) {
      return { ...(name ? { name } : {}), external: true };
    }
    return {
      ...(name ? { name } : {}),
      path: `${root.folder.name}/${path.relative(root.canonicalPath, canonicalSource)}`,
      external: false,
    };
  }

  private publicExceptionInfo(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
      return undefined;
    }
    const details = isRecord(value.details) ? value.details : undefined;
    const publicDetails = details
      ? {
        ...(truncate(details.message) ? { message: truncate(details.message) } : {}),
        ...(truncate(details.typeName, 512) ? { typeName: truncate(details.typeName, 512) } : {}),
        ...(truncate(details.fullTypeName, 1_000)
          ? { fullTypeName: truncate(details.fullTypeName, 1_000) }
          : {}),
        ...(truncate(details.stackTrace) ? { stackTrace: truncate(details.stackTrace) } : {}),
      }
      : undefined;
    return {
      ...(truncate(value.exceptionId, 1_000) ? { exceptionId: truncate(value.exceptionId, 1_000) } : {}),
      ...(truncate(value.description) ? { description: truncate(value.description) } : {}),
      ...(truncate(value.breakMode, 128) ? { breakMode: truncate(value.breakMode, 128) } : {}),
      ...(publicDetails && Object.keys(publicDetails).length > 0 ? { details: publicDetails } : {}),
    };
  }

  private async availableThreadId(
    record: SessionRecord,
    refresh = false,
    requireTraceEnabled = false,
  ): Promise<number | undefined> {
    if (!refresh && record.threadIds.length > 0) {
      return record.threadIds[0];
    }
    const response = await this.dapRequest(record, 'threads');
    const threads = isRecord(response) && Array.isArray(response.threads)
      ? response.threads
      : [];
    const rows = threads.filter((thread): thread is Record<string, unknown> =>
      isRecord(thread) && isPositiveInteger(thread.id));
    const preferred = rows.filter((thread) => thread.djangoTraceEnabled === true);
    const fallback = rows.filter((thread) => thread.djangoTraceEnabled !== true);
    record.threadIds = [...preferred, ...fallback].map((thread) => thread.id as number);
    const hasTraceMetadata = rows.some((thread) =>
      typeof thread.djangoTraceEnabled === 'boolean');
    if (requireTraceEnabled
      && record.engine === 'experimental'
      && hasTraceMetadata
      && preferred.length === 0) {
      throw new McpControllerError(
        'THREAD_NOT_TRACE_ENABLED',
        'No current debugger thread is trace-enabled yet. On Python 3.11 and earlier, retry after a Django request reaches the session.',
      );
    }
    return record.threadIds[0];
  }

  private async experimentalTraceCoverage(
    record: SessionRecord,
  ): Promise<Record<string, unknown> | undefined> {
    if (record.engine !== 'experimental' || !record.session) {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = await record.session.customRequest('djangoTracerStatus') as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(raw)) {
      return undefined;
    }
    const rawThreads = Array.isArray(raw.threads)
      ? raw.threads.filter(isRecord).slice(0, MAX_THREADS)
      : [];
    const untracedThreadNames = rawThreads.flatMap((thread) =>
      thread.traceEnabled === true
        ? []
        : [truncate(thread.name, 512) ?? '<thread>']);
    const coverage = raw.coverage === 'all' || raw.coverage === 'partial'
      ? raw.coverage
      : undefined;
    const knownThreadCount = this.optionalPublicCount(raw.knownThreadCount);
    const traceEnabledThreadCount = this.optionalPublicCount(raw.traceEnabledThreadCount);
    const bridgeDispatchCount = this.optionalPublicCount(
      raw.djangoRequestBridgeDispatchCount,
    );
    const bridgeTraceEnableCount = this.optionalPublicCount(
      raw.djangoRequestBridgeTraceEnableCount,
    );
    const djangoRequestBridgeModes = Array.isArray(raw.djangoRequestBridgeModes)
      ? [...new Set(raw.djangoRequestBridgeModes
        .slice(0, MAX_THREADS)
        .filter((mode): mode is string =>
          typeof mode === 'string' && DJANGO_REQUEST_BRIDGE_MODES.has(mode)))]
        .slice(0, DJANGO_REQUEST_BRIDGE_MODES.size)
      : [];
    return {
      ...(coverage ? { coverage } : {}),
      ...(truncate(raw.pythonVersion, 128)
        ? { pythonVersion: truncate(raw.pythonVersion, 128) }
        : {}),
      allThreadsHookInstalled: raw.allThreadsHookInstalled === true,
      futureThreadsHookInstalled: raw.futureThreadsHookInstalled === true,
      djangoRequestBridgeInstalled: raw.djangoRequestBridgeInstalled === true,
      djangoRequestBridgeModes,
      djangoRequestBridgeObserved: raw.djangoRequestBridgeObserved === true,
      ...(bridgeDispatchCount === undefined
        ? {}
        : { djangoRequestBridgeDispatchCount: bridgeDispatchCount }),
      ...(bridgeTraceEnableCount === undefined
        ? {}
        : { djangoRequestBridgeTraceEnableCount: bridgeTraceEnableCount }),
      ...(typeof raw.djangoRequestBridgeLastMode === 'string'
        && DJANGO_REQUEST_BRIDGE_MODES.has(raw.djangoRequestBridgeLastMode)
        ? { djangoRequestBridgeLastMode: raw.djangoRequestBridgeLastMode }
        : {}),
      ...(truncate(raw.djangoRequestBridgeLastThreadName, 256)
        ? { djangoRequestBridgeLastThreadName: truncate(raw.djangoRequestBridgeLastThreadName, 256) }
        : {}),
      ...(truncate(raw.djangoRequestBridgeLastSender, 256)
        ? { djangoRequestBridgeLastSender: truncate(raw.djangoRequestBridgeLastSender, 256) }
        : {}),
      ...(typeof raw.djangoRequestBridgeLastOutcome === 'string'
        && DJANGO_REQUEST_BRIDGE_OUTCOMES.has(raw.djangoRequestBridgeLastOutcome)
        ? { djangoRequestBridgeLastOutcome: raw.djangoRequestBridgeLastOutcome }
        : {}),
      ...(typeof raw.djangoRequestBridgeLastFailureReason === 'string'
        && DJANGO_REQUEST_BRIDGE_OUTCOMES.has(raw.djangoRequestBridgeLastFailureReason)
        ? { djangoRequestBridgeLastFailureReason: raw.djangoRequestBridgeLastFailureReason }
        : {}),
      ...(knownThreadCount === undefined ? {} : { knownThreadCount }),
      ...(traceEnabledThreadCount === undefined ? {} : { traceEnabledThreadCount }),
      untracedThreadNames,
    };
  }

  private sessionSummaries(): Array<Record<string, unknown>> {
    return [...this.sessions.values()].map((record) => ({
      sessionRef: record.sessionRef,
      name: record.name,
      state: record.state,
      ready: record.state !== 'terminating'
        && record.state !== 'terminated'
        && (record.adapterReady || record.state === 'stopped'),
      engine: record.engine,
      ...(record.folder ? { workspaceFolder: record.folder.name } : {}),
      ...(record.stopRef ? { stopRef: record.stopRef } : {}),
      cursor: record.nextCursor - 1,
    }));
  }

  private breakpointSummaries(): Array<Record<string, unknown>> {
    return this.ownedBreakpoints.map((entry) => ({
      path: entry.source,
      line: entry.line,
      ...(entry.column === undefined ? {} : { column: entry.column }),
      ...(entry.condition === undefined ? {} : { condition: entry.condition }),
      ...(entry.hitCondition === undefined ? {} : { hitCondition: entry.hitCondition }),
      ...(entry.logMessage === undefined ? {} : { logMessage: entry.logMessage }),
    }));
  }
}
