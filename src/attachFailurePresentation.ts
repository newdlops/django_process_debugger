import {
  BootstrapControlChannelError,
  BootstrapNotInstalledError,
  BootstrapNotLoadedError,
  BootstrapRuntimeIdentityError,
  BootstrapRuntimeVersionError,
  DebugEngineConflictError,
  DebugEngineUnavailableError,
  ProcessNotFoundError,
} from './debugpyInjector';

export interface AttachFailurePresentation {
  message: string;
  actions: readonly ('Run Setup' | 'Show Status' | 'Show Logs')[];
}

/** Keep all attach entry points precise without adding a new UI surface. */
export function presentAttachFailure(error: unknown): AttachFailurePresentation {
  if (error instanceof ProcessNotFoundError) {
    return { message: `Cannot attach: PID ${error.pid} has exited. Refresh the process list and try again.`, actions: ['Show Status', 'Show Logs'] };
  }
  if (error instanceof BootstrapNotInstalledError) {
    return { message: error.message, actions: ['Run Setup', 'Show Status', 'Show Logs'] };
  }
  if (error instanceof BootstrapRuntimeVersionError || error instanceof BootstrapRuntimeIdentityError) {
    return { message: error.message, actions: ['Run Setup', 'Show Status', 'Show Logs'] };
  }
  if (error instanceof BootstrapControlChannelError) {
    return { message: error.message, actions: ['Show Status', 'Show Logs'] };
  }
  if (error instanceof BootstrapNotLoadedError) {
    return { message: `${error.message} Restart the target process after setup, then try again.`, actions: ['Show Status', 'Show Logs'] };
  }
  if (error instanceof DebugEngineConflictError) {
    return { message: error.message, actions: ['Show Status', 'Show Logs'] };
  }
  if (error instanceof DebugEngineUnavailableError) {
    return { message: error.message, actions: ['Run Setup', 'Show Status', 'Show Logs'] };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { message: `Debugger attach failed: ${detail}`, actions: ['Show Status', 'Show Logs'] };
}
