import * as vscode from 'vscode';
import { DebugpyInjector, isValidExperimentalAuthToken } from './debugpyInjector';
import { DebugEngine, DEFAULT_DEBUG_ENGINE, normalizeDebugEngine } from './debugEngine';
import { log, logError, getLogger } from './logger';
import { formatEndpoint } from './listeningEndpoint';

export const DEBUG_SESSION_LOCK_TOKEN_KEY = '__djangoProcessDebuggerLockToken';
export const DEBUG_SESSION_AUTH_TOKEN_KEY = '__djangoProcessDebuggerAuthToken';

export interface DebugSessionLockTarget {
  pid: number;
  engine: DebugEngine;
  host: string;
  port: number;
  ownerToken: string;
}

export type DebugSessionLockClaim =
  | { allowed: true; release?: () => void | Promise<void> }
  | { allowed: false; message: string };

export interface DebugSessionLockGuard {
  claim(
    session: vscode.DebugSession,
    target: DebugSessionLockTarget,
  ): Promise<DebugSessionLockClaim>;
}

export function ensureDebugSessionLockToken(session: vscode.DebugSession): string {
  const existing = session.configuration[DEBUG_SESSION_LOCK_TOKEN_KEY];
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }

  const token = `${session.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  session.configuration[DEBUG_SESSION_LOCK_TOKEN_KEY] = token;
  return token;
}

export function parseDebugSessionPid(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError('Invalid django-process debug configuration: "pid" must be a positive integer.');
  }
  return value;
}

/**
 * Bridges between our "django-process" debug type and the underlying
 * selected debug adapter. When VS Code starts a "django-process" attach
 * session, this factory activates the configured engine through its private
 * process control channel first,
 * then delegates to its DAP server over TCP.
 */
export class DjangoDebugSessionFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  constructor(
    private readonly injector: DebugpyInjector,
    private readonly resolveDefaultEngine: () => DebugEngine = () => DEFAULT_DEBUG_ENGINE,
    private readonly lockGuard?: DebugSessionLockGuard,
  ) {}

  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): Promise<vscode.DebugAdapterDescriptor | null> {
    const config = session.configuration;
    let pid: number | undefined;
    try {
      pid = parseDebugSessionPid(config.pid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('[DebugSession] Invalid attach configuration', err);
      void vscode.window.showErrorMessage(msg);
      return null;
    }
    const engine = normalizeDebugEngine(config.engine ?? this.resolveDefaultEngine());
    let host: string = config.host ?? '127.0.0.1';
    let port: number = config.port ?? 5678;
    let lockClaim: Extract<DebugSessionLockClaim, { allowed: true }> | undefined;

    log(`[DebugSession] createDebugAdapterDescriptor: pid=${pid} engine=${engine} host=${host} port=${port}`);

    if (pid) {
      if (this.lockGuard) {
        try {
          const claim = await this.lockGuard.claim(session, {
            pid,
            engine,
            host,
            port,
            ownerToken: ensureDebugSessionLockToken(session),
          });
          if (!claim.allowed) {
            log(`[DebugSession] PID lock rejected: ${claim.message}`);
            void vscode.window.showErrorMessage(claim.message);
            return null;
          }
          lockClaim = claim;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError('[DebugSession] PID lock check failed', err);
          void vscode.window.showErrorMessage(`Cannot attach: PID lock check failed: ${msg}`);
          return null;
        }
      }

      try {
        const endpoint = await this.injector.activateEndpoint(pid, port, engine);
        host = endpoint.host;
        port = endpoint.port;
        // The lifecycle handler persists the actual endpoint, including a
        // dynamically allocated port, rather than the pre-activation request.
        config.host = host;
        config.port = port;
        if (engine === 'experimental') {
          if (!isValidExperimentalAuthToken(endpoint.authToken)) {
            throw new Error(
              'Experimental tracer did not publish a valid DAP authentication credential. ' +
              'Restart the target process after updating the bootstrap.'
            );
          }
          config[DEBUG_SESSION_AUTH_TOKEN_KEY] = endpoint.authToken;
        } else {
          delete config[DEBUG_SESSION_AUTH_TOKEN_KEY];
        }
        log(`[DebugSession] Activation succeeded, connecting to ${formatEndpoint(endpoint)}`);
      } catch (err) {
        try {
          await lockClaim?.release?.();
        } catch (releaseErr) {
          logError('[DebugSession] Failed to release PID lock after activation failure', releaseErr);
        }
        logError(`[DebugSession] Activation failed`, err);
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg, 'Show Logs').then((c) => {
          if (c === 'Show Logs') { getLogger().show(); }
        });
        return null;
      }
    }

    if (
      engine === 'experimental'
      && !isValidExperimentalAuthToken(config[DEBUG_SESSION_AUTH_TOKEN_KEY])
    ) {
      void vscode.window.showErrorMessage(
        'Cannot attach to the experimental tracer without its private DAP authentication credential.'
      );
      return null;
    }
    if (engine === 'debugpy') {
      delete config[DEBUG_SESSION_AUTH_TOKEN_KEY];
    }

    return new vscode.DebugAdapterServer(port, host);
  }
}
